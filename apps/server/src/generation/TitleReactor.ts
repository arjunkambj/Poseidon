/**
 * Names a new thread from its first message.
 *
 * It listens to live events only — the engine's PubSub, never the log — so a
 * boot does not walk history and retitle threads the user left as they were.
 * On a thread's first `thread.turn.requested`, while Settings → Models says to
 * name threads automatically (read at that moment) and the thread is still
 * called exactly `DEFAULT_THREAD_TITLE`, it forks a job into the reactor's own
 * scope and goes back to listening: the turn it saw is never waited on, and
 * nothing it does can fail that turn. The job asks `TextGeneration.autoTitle`,
 * which renames only if the title is still the default when the text arrives.
 * A fork or a fan-out thread already has a title, so it is left alone.
 *
 * Every failure — no harness can write, the harness refused, the timeout — is
 * logged and nothing else: the title simply stays "New thread", and the user
 * can still ask for one from the thread's menu.
 *
 * The subscription is opened in the building fiber, as the other reactors do,
 * so a turn requested between the build and the first pull is not missed.
 */

import type { ThreadId, TurnId } from "@poseidon/contracts/ids";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { DEFAULT_THREAD_TITLE } from "../orchestration/decider";
import { OrchestrationEngine } from "../orchestration/Engine";
import type { ThreadDoc } from "../orchestration/state";
import { SettingsStore } from "../rpc/services";
import { TextGeneration } from "./TextGeneration";

/** Whether `turnId` is the thread's first: no message of the user's came before it. */
const isFirstTurn = (doc: Pick<ThreadDoc, "items">, turnId: TurnId): boolean =>
  !doc.items.some((item) => item.kind === "user_message" && item.turnId !== turnId);

export interface TitleReactorOptions {
  /** Called when a job ends, however it ended: how a test knows it is done. */
  readonly onSettled?: (threadId: ThreadId) => Effect.Effect<void>;
}

export const makeTitleReactor = (options: TitleReactorOptions = {}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      const settings = yield* SettingsStore;
      const generation = yield* TextGeneration;
      const scope = yield* Effect.scope;
      /** Threads a job was started for in this process, so a second turn never starts another. */
      const started = new Set<ThreadId>();

      const job = (threadId: ThreadId, turnId: TurnId, text: string) =>
        Effect.gen(function* () {
          if (!(yield* settings.get).generation.autoTitle) {
            return;
          }
          const doc = yield* engine.threadDoc(threadId);
          if (
            doc === null ||
            doc.deleted ||
            doc.title !== DEFAULT_THREAD_TITLE ||
            !isFirstTurn(doc, turnId)
          ) {
            return;
          }
          yield* generation.autoTitle(threadId, text);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logInfo("automatic thread title skipped", { threadId, cause }),
          ),
          Effect.ensuring(options.onSettled?.(threadId) ?? Effect.void),
        );

      const mailbox = yield* engine.subscribeEvents;
      yield* Stream.runForEach(Stream.fromSubscription(mailbox), (event) => {
        if (event.streamKind !== "thread" || event.type !== "thread.turn.requested") {
          return Effect.void;
        }
        const threadId = event.streamId as ThreadId;
        const text = event.payload.text.trim();
        if (text === "" || started.has(threadId)) {
          return Effect.void;
        }
        started.add(threadId);
        return Effect.forkIn(job(threadId, event.payload.turnId as TurnId, text), scope).pipe(
          Effect.asVoid,
        );
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("title reactor ended", cause)),
        Effect.forkScoped,
      );
    }),
  );

/** The reactor as the server runs it. */
export const TitleReactor = makeTitleReactor();
