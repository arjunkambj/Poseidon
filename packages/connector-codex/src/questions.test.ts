/**
 * The question card, on the request the `question` recording made: how its
 * questions read, how the user's answers go back, and every way a card ends —
 * answered, stopped, withdrawn, closed — resolving it exactly once.
 */

import { describe, expect, it } from "@effect/vitest";
import type { RequestId } from "@poseidon/contracts/ids";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { recordedServerRequests } from "../test/frames";
import { answersResponse, makeCodexQuestions, questionsOf, USER_INPUT_REQUEST } from "./questions";
import type { PendingRuntimeEvent } from "./translate/pending";

const recorded = recordedServerRequests("question").find(
  (request) => request.method === USER_INPUT_REQUEST,
)!;

describe("questionsOf", () => {
  it("reads the recorded question: its id, header, options and a typed answer allowed", () => {
    expect(questionsOf(recorded.params)).toEqual([
      {
        questionId: "file_name",
        question: "Should the new file be named a.txt or b.txt?",
        header: "File name",
        options: [
          {
            optionId: "option-0",
            label: "a.txt (Recommended)",
            description: "Name the new file a.txt.",
          },
          { optionId: "option-1", label: "b.txt", description: "Name the new file b.txt." },
        ],
        multiSelect: false,
        freeform: true,
      },
    ]);
  });

  it("takes a typed answer for a question with no options, and drops one with no text", () => {
    const questions = questionsOf({
      questions: [
        { id: "q", header: "", question: "Name?", isOther: false, options: null },
        { id: "", question: "no id" },
      ],
    });
    expect(questions).toEqual([
      { questionId: "q", question: "Name?", options: [], multiSelect: false, freeform: true },
    ]);
  });
});

describe("answersResponse", () => {
  const questions = questionsOf(recorded.params);

  it("answers by option label, then the user's own text", () => {
    expect(
      answersResponse(questions, [
        { questionId: "file_name", optionIds: ["option-1"], text: " c.txt " },
      ]),
    ).toEqual({ answers: { file_name: { answers: ["b.txt", "c.txt"] } } });
  });

  it("leaves out a question with nothing answered, and ignores unknown ids", () => {
    expect(
      answersResponse(questions, [
        { questionId: "file_name", optionIds: ["option-9"] },
        { questionId: "other", optionIds: ["option-0"] },
      ]),
    ).toEqual({ answers: {} });
  });
});

/** A questions module collecting what it emits. */
const collecting = () => {
  const emitted: Array<PendingRuntimeEvent> = [];
  const questions = makeCodexQuestions({
    emit: (event) => Effect.sync(() => void emitted.push(event)),
  });
  const requestId = () => {
    const opened = emitted.find((event) => event.type === "user-input.requested");
    return opened?.type === "user-input.requested" ? opened.payload.requestId : undefined;
  };
  const resolutions = () => emitted.filter((event) => event.type === "user-input.resolved");
  return { emitted, questions, requestId, resolutions };
};

const request = { id: recorded.id, method: USER_INPUT_REQUEST, params: recorded.params };

describe("makeCodexQuestions", () => {
  it.effect("raises the card and answers the CLI with the user's choice", () =>
    Effect.gen(function* () {
      const { questions, requestId, resolutions } = collecting();
      const fiber = yield* Effect.forkChild(questions.ask(request));
      yield* Effect.yieldNow;
      const id = requestId()!;
      yield* questions.respond(id, [{ questionId: "file_name", optionIds: ["option-0"] }]);
      yield* questions.respond(id, [{ questionId: "file_name", optionIds: ["option-1"] }]);
      expect(yield* Fiber.join(fiber)).toEqual({
        result: { answers: { file_name: { answers: ["a.txt (Recommended)"] } } },
      });
      yield* questions.closeAll;
      expect(resolutions()).toHaveLength(1);
    }),
  );

  it.effect("answers nothing on Stop, so the CLI waits on nothing", () =>
    Effect.gen(function* () {
      const { questions, resolutions } = collecting();
      const fiber = yield* Effect.forkChild(questions.ask(request));
      yield* Effect.yieldNow;
      yield* questions.cancelAll;
      expect(yield* Fiber.join(fiber)).toEqual({ result: { answers: {} } });
      expect(resolutions()).toHaveLength(1);
    }),
  );

  it.effect("sends nothing once the CLI withdrew the request, or its turn ended", () =>
    Effect.gen(function* () {
      for (const withdrawal of [
        { method: "serverRequest/resolved", params: { requestId: recorded.id } },
        { method: "turn/completed", params: {} },
      ]) {
        const { questions, requestId, resolutions } = collecting();
        const fiber = yield* Effect.forkChild(questions.ask(request));
        yield* Effect.yieldNow;
        yield* questions.observe(withdrawal);
        yield* questions.respond(requestId()!, []);
        expect(yield* Fiber.join(fiber)).toBeNull();
        expect(resolutions()).toHaveLength(1);
      }
    }),
  );

  it.effect("sends nothing on close, and raises no card for a request withdrawn first", () =>
    Effect.gen(function* () {
      const { questions, resolutions } = collecting();
      const fiber = yield* Effect.forkChild(questions.ask(request));
      yield* Effect.yieldNow;
      yield* questions.closeAll;
      expect(yield* Fiber.join(fiber)).toBeNull();
      expect(resolutions()).toHaveLength(1);

      const early = collecting();
      const pending = early.questions.ask(request);
      yield* early.questions.observe({
        method: "serverRequest/resolved",
        params: { requestId: recorded.id },
      });
      expect(yield* pending).toBeNull();
      expect(early.emitted).toEqual([]);
    }),
  );

  it.effect("ignores answers to a card it does not have", () =>
    Effect.gen(function* () {
      const { questions, emitted } = collecting();
      yield* questions.respond("nope" as RequestId, []);
      expect(emitted).toEqual([]);
    }),
  );
});
