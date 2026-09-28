/**
 * The model's questions to the user, on Poseidon's question card.
 *
 * The app-server asks with a server request, `item/tool/requestUserInput`
 * (experimental in `PROTOCOL_CLI_VERSION`, offered to the model in plan mode):
 * one or more questions, each with an id, a header, the question, its options
 * (label and description, or none) and `isOther` — whether an answer of the
 * user's own is welcome. The request stays open until the client answers
 * `{ answers: { [questionId]: { answers: [...] } } }`, each answer a list of
 * strings: the labels of the options picked, then the user's own text.
 *
 * Each request is one card (`user-input.requested`), parked until the first
 * of:
 *
 * - the user's answers (`respond`) — sent back as above;
 * - Stop (`cancelAll`) — answered with no answers, so the CLI is waiting on
 *   nothing when `turn/interrupt` reaches it;
 * - the CLI withdrawing it — `serverRequest/resolved` for a request still
 *   open, or its turn completing — or the session closing (`closeAll`): the
 *   card goes, and nothing is sent, since nobody is waiting.
 *
 * Whichever comes first, `user-input.resolved` says the card is gone, once.
 *
 * The protocol has no multi-select: one option is picked per question.
 * `isSecret` asks for a masked field; the card has none, so the answer shows
 * as typed. A question with no options takes a typed answer.
 */

import type { RequestId } from "@poseidon/contracts/ids";
import { makeRequestId } from "@poseidon/contracts/ids";
import type { UserQuestion, UserQuestionAnswer } from "@poseidon/contracts/runtime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type { RpcId, RpcOutcome, RpcServerRequest } from "./rpc";
import {
  asArray,
  asRecord,
  nonEmpty,
  type Notification,
  type PendingRuntimeEvent,
} from "./translate/pending";

/** The server request that is the model asking the user. */
export const USER_INPUT_REQUEST = "item/tool/requestUserInput";

/** Poseidon's id for an option: its place in the question's list. */
const optionId = (index: number): string => `option-${index}`;

/** The request's questions as the card's. A question with nothing to ask is left out. */
export const questionsOf = (params: unknown): ReadonlyArray<UserQuestion> =>
  asArray(asRecord(params).questions).flatMap((entry): Array<UserQuestion> => {
    const question = asRecord(entry);
    const questionId = nonEmpty(question.id);
    const text = nonEmpty(question.question);
    if (questionId === undefined || text === undefined) return [];
    const options = asArray(question.options).flatMap((value, index) => {
      const option = asRecord(value);
      const label = nonEmpty(option.label);
      if (label === undefined) return [];
      const description = nonEmpty(option.description);
      return [
        {
          optionId: optionId(index),
          label,
          ...(description === undefined ? {} : { description }),
        },
      ];
    });
    const header = nonEmpty(question.header);
    return [
      {
        questionId,
        question: text,
        ...(header === undefined ? {} : { header }),
        options,
        multiSelect: false,
        freeform: question.isOther === true || options.length === 0,
      },
    ];
  });

/** The user's answers as the response the CLI reads. */
export const answersResponse = (
  questions: ReadonlyArray<UserQuestion>,
  answers: ReadonlyArray<UserQuestionAnswer>,
): { readonly answers: Readonly<Record<string, { readonly answers: ReadonlyArray<string> }>> } => {
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]));
  const entries = questions.flatMap((question) => {
    const answer = byId.get(question.questionId);
    if (answer === undefined) return [];
    const labels = answer.optionIds.flatMap((id) => {
      const option = question.options.find((each) => each.optionId === id);
      return option === undefined ? [] : [option.label];
    });
    const text = answer.text?.trim() ?? "";
    const list = text === "" ? labels : [...labels, text];
    return list.length === 0 ? [] : [[question.questionId, { answers: list }] as const];
  });
  return { answers: Object.fromEntries(entries) };
};

export interface CodexQuestions {
  /**
   * One `item/tool/requestUserInput`: the card, then the outcome to send, or
   * null when nothing is sent. It is open as soon as this is called, so a
   * withdrawal read next already finds it.
   */
  readonly ask: (request: RpcServerRequest) => Effect.Effect<RpcOutcome | null>;
  /** The user's answers to an open card; an unknown id is ignored. */
  readonly respond: (
    requestId: RequestId,
    answers: ReadonlyArray<UserQuestionAnswer>,
  ) => Effect.Effect<void>;
  /** Reads a notification for the CLI withdrawing an open request. */
  readonly observe: (notification: Notification) => Effect.Effect<void>;
  /** Stop: every open card answered with nothing. */
  readonly cancelAll: Effect.Effect<void>;
  /** Close: every open card gone, nothing sent. */
  readonly closeAll: Effect.Effect<void>;
}

/** How a card was settled. */
type Settled =
  | { readonly kind: "answered"; readonly answers: ReadonlyArray<UserQuestionAnswer> }
  | { readonly kind: "cancelled" }
  | { readonly kind: "withdrawn" };

interface OpenCard {
  readonly rpcId: RpcId;
  readonly settled: Deferred.Deferred<Settled>;
  /** The card is on the thread; one settled before that says nothing. */
  announced: boolean;
}

export const makeCodexQuestions = (options: {
  readonly emit: (pending: PendingRuntimeEvent) => Effect.Effect<void>;
}): CodexQuestions => {
  const open = new Map<RequestId, OpenCard>();

  /**
   * Settles one card: out of the open set, its outcome decided, the card
   * gone from the thread — in the caller's effect, so a close has said so
   * before the session ends. A card already settled is left as it is.
   */
  const settle = (requestId: RequestId, outcome: Settled): Effect.Effect<void> =>
    Effect.suspend(() => {
      const card = open.get(requestId);
      if (card === undefined) return Effect.void;
      open.delete(requestId);
      return Deferred.succeed(card.settled, outcome).pipe(
        Effect.andThen(
          card.announced
            ? options.emit({ type: "user-input.resolved", requestId, payload: { requestId } })
            : Effect.void,
        ),
      );
    });

  const settleAll = (outcome: Settled): Effect.Effect<void> =>
    Effect.suspend(() =>
      Effect.forEach([...open.keys()], (requestId) => settle(requestId, outcome), {
        discard: true,
      }),
    );

  const ask: CodexQuestions["ask"] = (request) => {
    const questions = questionsOf(request.params);
    const requestId = makeRequestId();
    const settled = Deferred.makeUnsafe<Settled>();
    const card: OpenCard = { rpcId: request.id, settled, announced: false };
    if (questions.length > 0) open.set(requestId, card);
    return Effect.gen(function* () {
      // Nothing the card could ask: the CLI is told no answer came.
      if (questions.length === 0) return { result: { answers: {} } };
      // Withdrawn before its fiber ran: no card is raised for it.
      if (open.has(requestId)) {
        card.announced = true;
        yield* options.emit({
          type: "user-input.requested",
          requestId,
          payload: { requestId, questions },
        });
      }
      const outcome = yield* Deferred.await(settled);
      switch (outcome.kind) {
        case "answered":
          return { result: answersResponse(questions, outcome.answers) };
        case "cancelled":
          return { result: { answers: {} } };
        case "withdrawn":
          return null;
      }
    });
  };

  return {
    ask,
    respond: (requestId, answers) => settle(requestId, { kind: "answered", answers }),
    observe: (notification) =>
      Effect.suspend(() => {
        if (notification.method === "turn/completed") return settleAll({ kind: "withdrawn" });
        if (notification.method !== "serverRequest/resolved") return Effect.void;
        const rpcId = asRecord(notification.params).requestId;
        if (typeof rpcId !== "string" && typeof rpcId !== "number") return Effect.void;
        const entry = [...open].find(([, card]) => String(card.rpcId) === String(rpcId));
        return entry === undefined ? Effect.void : settle(entry[0], { kind: "withdrawn" });
      }),
    cancelAll: settleAll({ kind: "cancelled" }),
    closeAll: settleAll({ kind: "withdrawn" }),
  };
};
