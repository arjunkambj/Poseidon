/**
 * Automatic thread titles, over a real engine and settings store with the
 * testkit's fake connector writing the text:
 *
 * - a first turn on "New thread" names it from the first message;
 * - a rename the user makes while the text is being written wins;
 * - with the setting off nothing is asked;
 * - a failure leaves the title and the turn alone;
 * - a thread created with a title is left alone;
 * - starting the reactor after history does not retitle old threads.
 */

import { describe, expect, it } from "@effect/vitest";
import type { GenerateTextInput } from "@poseidon/connector-sdk/definition";
import { GenerationFailed } from "@poseidon/connector-sdk/definition";
import { DEFAULT_GENERATION_SETTINGS } from "@poseidon/contracts/generation";
import { makeCommandId, makeEventId, makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { Command } from "@poseidon/contracts/orchestration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type { OrchestrationEngine } from "../orchestration/Engine";
import { generationStack } from "./test/generationStack";

const now = () => new Date().toISOString();

const dispatch = (engine: OrchestrationEngine["Service"], command: Command) =>
  Effect.flatMap(engine.dispatch(command), (receipt) =>
    receipt.status === "accepted"
      ? Effect.void
      : Effect.die(new Error(`${command.type} rejected: ${receipt.reason ?? ""}`)),
  );

const project = (engine: OrchestrationEngine["Service"]) =>
  Effect.gen(function* () {
    const projectId = makeProjectId();
    yield* dispatch(engine, {
      commandId: makeCommandId(),
      createdAt: now(),
      type: "project.create",
      projectId,
      name: "demo",
      workspaceRoot: `/repo/${projectId}`,
    });
    return projectId;
  });

const thread = (engine: OrchestrationEngine["Service"], projectId: ProjectId, title?: string) =>
  Effect.gen(function* () {
    const threadId = makeThreadId();
    yield* dispatch(engine, {
      commandId: makeCommandId(),
      createdAt: now(),
      type: "thread.create",
      threadId,
      projectId,
      settings: { model: "fake/model" },
      ...(title === undefined ? {} : { title }),
    });
    return threadId;
  });

const turn = (engine: OrchestrationEngine["Service"], threadId: ThreadId, text: string) =>
  dispatch(engine, {
    commandId: makeCommandId(),
    createdAt: now(),
    type: "thread.turn.start",
    threadId,
    text,
    attachments: [],
    mentions: [],
    queued: false,
  });

/** Settles the running turn, as its connector would once it finished. */
const complete = (engine: OrchestrationEngine["Service"], threadId: ThreadId) =>
  Effect.gen(function* () {
    const turnId = (yield* engine.threadDoc(threadId))?.currentTurn?.turnId;
    if (turnId === undefined) return;
    yield* engine.appendThreadEvents(threadId, [
      {
        eventId: makeEventId(),
        streamKind: "thread",
        streamId: threadId,
        occurredAt: now(),
        actor: "connector",
        type: "thread.turn.completed",
        payload: { turnId, stopReason: "end_turn" },
      },
    ]);
  });

const titleOf = (engine: OrchestrationEngine["Service"], threadId: ThreadId) =>
  Effect.map(engine.threadDoc(threadId), (doc) => doc?.title);

describe("TitleReactor", () => {
  it.live("names a new thread from its first message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const asked: Array<GenerateTextInput> = [];
        const stack = yield* generationStack({
          generateText: (input) =>
            Effect.sync(() => {
              asked.push(input);
              return '{"title":"Fix the login redirect"}';
            }),
        });
        yield* stack.startTitleReactor;
        const threadId = yield* thread(stack.engine, yield* project(stack.engine));
        yield* turn(stack.engine, threadId, "the login page redirects in a loop, fix it");
        yield* stack.settledFor(threadId);

        expect(yield* titleOf(stack.engine, threadId)).toBe("Fix the login redirect");
        expect(asked).toHaveLength(1);
        expect(asked[0]?.prompt).toContain("redirects in a loop");
        expect(asked[0]?.effort).toBe("low");

        // The second turn is not a first one: nothing more is asked. Another
        // thread's first turn, seen after it, is the barrier.
        yield* complete(stack.engine, threadId);
        yield* turn(stack.engine, threadId, "and the logout page too");
        const other = yield* thread(stack.engine, yield* project(stack.engine));
        yield* turn(stack.engine, other, "something else");
        yield* stack.settledFor(other);
        expect(asked.map((input) => input.prompt).join()).not.toContain("logout");
      }),
    ),
  );

  it.live("a rename made while the title is being written wins", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const stack = yield* generationStack({
          generateText: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as('{"title":"Generated"}'),
            ),
        });
        yield* stack.startTitleReactor;
        const threadId = yield* thread(stack.engine, yield* project(stack.engine));
        yield* turn(stack.engine, threadId, "write the parser");
        yield* Deferred.await(started);

        yield* dispatch(stack.engine, {
          commandId: makeCommandId(),
          createdAt: now(),
          type: "thread.rename",
          threadId,
          title: "Mine",
        });
        yield* Deferred.succeed(release, undefined);
        yield* stack.settledFor(threadId);
        expect(yield* titleOf(stack.engine, threadId)).toBe("Mine");
      }),
    ),
  );

  it.live("asks nothing when automatic titles are off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const stack = yield* generationStack({
          generateText: () => Effect.sync(() => (calls += 1)).pipe(Effect.as('{"title":"No"}')),
        });
        yield* stack.settings.update({
          generation: { ...DEFAULT_GENERATION_SETTINGS, autoTitle: false },
        });
        yield* stack.startTitleReactor;
        const threadId = yield* thread(stack.engine, yield* project(stack.engine));
        yield* turn(stack.engine, threadId, "write the parser");
        yield* stack.settledFor(threadId);
        expect(calls).toBe(0);
        expect(yield* titleOf(stack.engine, threadId)).toBe("New thread");
      }),
    ),
  );

  it.live("a failure leaves the title and the turn alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* generationStack({
          generateText: (_input, instanceId) =>
            Effect.fail(new GenerationFailed({ kind: "fake", instanceId, message: "refused" })),
        });
        yield* stack.startTitleReactor;
        const threadId = yield* thread(stack.engine, yield* project(stack.engine));
        yield* turn(stack.engine, threadId, "write the parser");
        yield* stack.settledFor(threadId);
        const doc = yield* stack.engine.threadDoc(threadId);
        expect(doc?.title).toBe("New thread");
        expect(doc?.status).toBe("running");
        expect(doc?.currentTurn?.input.text).toBe("write the parser");
      }),
    ),
  );

  it.live("leaves a thread that was given a title alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const stack = yield* generationStack({
          generateText: () => Effect.sync(() => (calls += 1)).pipe(Effect.as('{"title":"No"}')),
        });
        yield* stack.startTitleReactor;
        const threadId = yield* thread(stack.engine, yield* project(stack.engine), "Given");
        yield* turn(stack.engine, threadId, "write the parser");
        yield* stack.settledFor(threadId);
        expect(calls).toBe(0);
        expect(yield* titleOf(stack.engine, threadId)).toBe("Given");
      }),
    ),
  );

  it.live("starting after history does not retitle old threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const stack = yield* generationStack({
          generateText: () => Effect.sync(() => (calls += 1)).pipe(Effect.as('{"title":"No"}')),
        });
        const threadId = yield* thread(stack.engine, yield* project(stack.engine));
        yield* turn(stack.engine, threadId, "an old first message");

        yield* stack.startTitleReactor;
        // A live first turn elsewhere settles; the old thread was never looked at.
        const fresh = yield* thread(stack.engine, yield* project(stack.engine));
        yield* turn(stack.engine, fresh, "a new first message");
        yield* stack.settledFor(fresh);
        expect(calls).toBe(1);
        expect(yield* titleOf(stack.engine, threadId)).toBe("New thread");
        expect(yield* titleOf(stack.engine, fresh)).toBe("No");
      }),
    ),
  );
});
