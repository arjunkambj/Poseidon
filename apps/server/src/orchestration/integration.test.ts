import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  makeCheckpointId,
  makeCommandId,
  makeEventId,
  makeConnectorInstanceId,
  makeItemId,
  makeProjectId,
  makeThreadId,
  makeTurnId,
} from "@poseidon/contracts/ids";
import type { Command, OrchestrationEvent } from "@poseidon/contracts/orchestration";
import type { ConnectorInstance, ConnectorServices } from "@poseidon/connector-sdk/definition";
import { SessionClosed, SpawnFailed } from "@poseidon/connector-sdk/definition";
import {
  approvalTurnScript,
  makeFakeConnector,
  type FakeConnector,
  type FakeTurnScript,
} from "@poseidon/testkit/fakeConnector";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestConsole from "effect/testing/TestConsole";

import type { PlannedEvent } from "../persistence/EventStore";
import { EngineEnv, OrchestrationEngine } from "./Engine";
import { SessionManager } from "./SessionManager";
import { engineLayer, persistenceLayer, stackLayer } from "../../test/layers";

const NOW = "2026-01-02T03:04:05.000Z";

/** The services bag connectors are handed — the fake ignores it. */
const services = Effect.clockWith((clock) =>
  Effect.succeed<ConnectorServices>({
    mcpEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/mcp", bearer: "t" }),
    hookEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/hook", bearer: "t" }),
    permissions: { decide: () => Effect.succeed("allow" as const) },
    attachmentsDir: "/tmp/poseidon-test",
    logger: { log: () => Effect.void },
    clock,
  }),
);

const openFake = (
  options: Parameters<typeof makeFakeConnector>[0] = {},
): Effect.Effect<
  { fake: FakeConnector; instance: ConnectorInstance },
  import("@poseidon/connector-sdk/definition").ConnectorError,
  import("effect/Scope").Scope
> =>
  Effect.gen(function* () {
    const fake = yield* makeFakeConnector(options);
    const instance = yield* fake.definition.createInstance({
      instanceId: makeConnectorInstanceId(),
      config: {},
      services: yield* services,
    });
    return { fake, instance };
  });

const projectId = makeProjectId();
const threadId = makeThreadId();

const createProject: Command = {
  commandId: makeCommandId(),
  createdAt: NOW,
  type: "project.create",
  projectId,
  name: "demo",
  workspaceRoot: "/repo",
};

const createThread: Command = {
  commandId: makeCommandId(),
  createdAt: NOW,
  type: "thread.create",
  threadId,
  projectId,
  settings: { model: "fake/model" },
};

const createPlanThread: Command = {
  commandId: makeCommandId(),
  createdAt: NOW,
  type: "thread.create",
  threadId,
  projectId,
  settings: { model: "fake/model", interactionMode: "plan" },
};

const turnStart = (text: string, queued = false): Command => ({
  commandId: makeCommandId(),
  createdAt: NOW,
  type: "thread.turn.start",
  threadId,
  text,
  attachments: [],
  mentions: [],
  queued,
});

const turnSteer = (text: string): Command => ({
  commandId: makeCommandId(),
  createdAt: NOW,
  type: "thread.turn.steer",
  threadId,
  text,
  attachments: [],
  mentions: ["README.md"],
});

/**
 * A fiber that completes with the first matching event. Fork it *before* the
 * action that produces the event — a PubSub subscription only sees what
 * happens after it was created.
 */
const awaitEvent = (
  engine: OrchestrationEngine["Service"],
  pred: (event: OrchestrationEvent) => boolean,
) =>
  Effect.gen(function* () {
    const mailbox = yield* engine.subscribeEvents;
    return yield* Stream.fromSubscription(mailbox).pipe(
      Stream.filter(pred),
      Stream.runHead,
      Effect.forkChild,
    );
  });

const isType =
  (type: OrchestrationEvent["type"]) =>
  (event: OrchestrationEvent): boolean =>
    event.type === type;

describe("orchestration with a fake connector", () => {
  it.effect("runs a scripted turn end to end", () =>
    Effect.gen(function* () {
      const { fake, instance } = yield* openFake();
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const completed = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch(turnStart("hello"));
        yield* Fiber.join(completed);

        const detail = yield* engine.threadDetail(threadId);
        expect(detail?.status).toBe("idle");
        const message = detail?.items.find((item) => item.kind === "assistant_message");
        expect(message?.text).toContain("Fake reply to: hello");
        expect(detail?.session).not.toBeNull();
      }).pipe(Effect.provide(stackLayer({ instance })));

      const session = yield* fake.session(threadId);
      expect(session).not.toBeUndefined();
      const calls = yield* session!.calls;
      expect(calls.map((call) => call.method)).toContain("send");
    }),
  );

  it.effect("starts a worktree thread's session in its worktree", () =>
    Effect.gen(function* () {
      const { instance } = yield* openFake();
      const started: Array<string> = [];
      // The fake keeps no record of where it was started, so the test does.
      const recording: ConnectorInstance = {
        ...instance,
        startSession: (input) => {
          started.push(input.workspaceRoot);
          return instance.startSession(input);
        },
      };
      const worktree = { path: "/worktrees/demo/fix", branch: "poseidon/fix", baseBranch: "main" };
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch({ ...createThread, worktree } as Command);

        const completed = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch(turnStart("hello"));
        yield* Fiber.join(completed);

        expect((yield* engine.threadDetail(threadId))?.worktree).toEqual(worktree);
      }).pipe(Effect.provide(stackLayer({ instance: recording })));

      expect(started).toEqual([worktree.path]);
    }),
  );

  it.effect("a fatal error leaves a row on the timeline, not just a status", () =>
    Effect.gen(function* () {
      // `thread.error` moves the thread's status and nothing else, so a turn
      // that died on a 400 from the provider, an exhausted account or a
      // crashed harness simply stopped and the timeline said nothing about
      // why. `error` is one of the fifteen ItemKinds and the renderer has a
      // row for it; until this, nothing in the product ever produced one.
      const { instance } = yield* openFake({
        script: () => [
          {
            type: "runtime.error",
            payload: { message: "the image payload could not be decoded", fatal: true },
          },
        ],
      });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const completed = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch(turnStart("show me the picture"));
        yield* Fiber.join(completed);

        const detail = yield* engine.threadDetail(threadId);
        const failed = detail?.items.filter((item) => item.kind === "error") ?? [];
        expect(failed).toHaveLength(1);
        expect(failed[0]?.status).toBe("failed");
        expect(failed[0]?.text).toContain("could not be decoded");
      }).pipe(Effect.provide(stackLayer({ instance })));
    }),
  );

  it.effect("a connector error with no message still leaves a readable log", () =>
    Effect.gen(function* () {
      // `SessionClosed`, `NoConnector`, `ConnectorNotFound` and `TurnInProgress`
      // are `Data.TaggedError`s with no `message` field, so `Error.message` on
      // them is "". Writing that onto `thread.error` — whose message is a
      // NonEmptyString — produced a row nothing could decode again: the thread
      // was unopenable and the next boot died replaying the log.
      const { instance } = yield* openFake();
      const closed: ConnectorInstance = {
        ...instance,
        startSession: () => Effect.fail(new SessionClosed({ threadId })),
      };
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const failed = yield* awaitEvent(engine, isType("thread.error"));
        yield* engine.dispatch(turnStart("go"));
        const event = Option.getOrThrow(yield* Fiber.join(failed));
        expect((event.payload as { message: string }).message).toBe(
          "the connector failed: SessionClosed",
        );

        // The proof the row is readable: both of these decode the whole stream
        // through `OrchestrationEvent`, and an empty message threw a defect no
        // `Effect.catch` in the graph could stop.
        const replayed = yield* engine.subscribeThread(threadId, { afterSequence: 0 });
        yield* Stream.runDrain(Stream.take(replayed, 1));
        const receipt = yield* engine.dispatch(turnStart("again"));
        expect(receipt.status).toBe("accepted");
      }).pipe(Effect.provide(stackLayer({ instance: closed, supervisor: false })));
    }),
  );

  it.effect("routes an approval through the reactor back to the session", () =>
    Effect.gen(function* () {
      const { fake, instance } = yield* openFake({ script: approvalTurnScript });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const requested = yield* awaitEvent(engine, isType("thread.approval.opened"));
        const completed = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch(turnStart("npm run build"));
        const opened = yield* Fiber.join(requested);
        expect(Option.isSome(opened)).toBe(true);

        const detail = yield* engine.threadDetail(threadId);
        expect(detail?.status).toBe("waiting");
        expect(detail?.pendingApproval).not.toBeNull();
        const requestId = detail!.pendingApproval!.requestId;

        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.approval.respond",
          threadId,
          requestId,
          decision: "allow-once",
        });
        yield* Fiber.join(completed);

        const after = yield* engine.threadDetail(threadId);
        expect(after?.status).toBe("idle");
        expect(after?.pendingApproval).toBeNull();
      }).pipe(Effect.provide(stackLayer({ instance })));

      const session = yield* fake.session(threadId);
      const calls = yield* session!.calls;
      const respond = calls.find((call) => call.method === "respondToRequest");
      expect(respond?.detail.decision).toBe("allow-once");
    }),
  );

  it.effect("plan accept leaves plan mode for the implement turn", () =>
    Effect.gen(function* () {
      // A turn that proposes a plan and stops there.
      const planTurnScript: FakeTurnScript = ({ turnId }) => [
        {
          turnId,
          type: "turn.plan.proposed",
          payload: {
            turnId,
            planMarkdown: "# the plan",
            planPath: "/home/u/.commandcode/plans/the-plan.md",
          },
        },
      ];
      const { fake, instance } = yield* openFake({ script: planTurnScript });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createPlanThread);

        const firstCompleted = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch(turnStart("plan it"));
        yield* Fiber.join(firstCompleted);

        const detail = yield* engine.threadDetail(threadId);
        expect(detail?.status).toBe("waiting");
        expect(detail?.settings.interactionMode).toBe("plan");
        const planTurnId = detail!.pendingPlan!.turnId;

        const secondCompleted = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.plan.respond",
          threadId,
          turnId: planTurnId,
          action: "accept",
        });
        yield* Fiber.join(secondCompleted);

        // Accept must leave plan mode — otherwise the implement turn produces
        // yet another plan forever.
        const after = yield* engine.threadDetail(threadId);
        expect(after?.settings.interactionMode).toBe("default");
        // The implement turn is a turn like any other, so it
        // mints a user row like any other: the timeline says what was asked,
        // and the implementation that follows is not an answer to nothing.
        expect(
          after?.items.filter((item) => item.kind === "user_message").map((item) => item.text),
        ).toEqual([
          "plan it",
          "Implement the approved plan at /home/u/.commandcode/plans/the-plan.md",
        ]);
      }).pipe(Effect.provide(stackLayer({ instance })));

      const session = yield* fake.session(threadId);
      const calls = yield* session!.calls;
      const sends = calls.filter((call) => call.method === "send");
      // The implement turn names the plan file it approved.
      expect(sends.map((call) => call.detail.text)).toContain(
        "Implement the approved plan at /home/u/.commandcode/plans/the-plan.md",
      );
      const settings = calls.filter((call) => call.method === "updateSettings");
      expect(settings.map((call) => call.detail.patch)).toContainEqual({
        interactionMode: "default",
      });
    }),
  );

  it.effect("plan accept-auto leaves plan mode and switches runtime mode", () =>
    Effect.gen(function* () {
      const planTurnScript: FakeTurnScript = ({ turnId }) => [
        {
          turnId,
          type: "turn.plan.proposed",
          payload: { turnId, planMarkdown: "# the plan" },
        },
      ];
      const { fake, instance } = yield* openFake({ script: planTurnScript });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createPlanThread);

        const firstCompleted = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch(turnStart("plan it"));
        yield* Fiber.join(firstCompleted);

        const detail = yield* engine.threadDetail(threadId);
        const planTurnId = detail!.pendingPlan!.turnId;

        const secondCompleted = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.plan.respond",
          threadId,
          turnId: planTurnId,
          action: "accept-auto",
        });
        yield* Fiber.join(secondCompleted);

        const after = yield* engine.threadDetail(threadId);
        expect(after?.settings.interactionMode).toBe("default");
        expect(after?.settings.runtimeMode).toBe("auto-accept-edits");
      }).pipe(Effect.provide(stackLayer({ instance })));

      const session = yield* fake.session(threadId);
      const calls = yield* session!.calls;
      const settings = calls.filter((call) => call.method === "updateSettings");
      expect(settings.map((call) => call.detail.patch)).toContainEqual({
        interactionMode: "default",
        runtimeMode: "auto-accept-edits",
      });
    }),
  );

  it.effect(
    "queue drain redispatches the message with its attachments, mentions and references",
    () =>
      Effect.gen(function* () {
        // The approval script holds turn.completed until the request is
        // answered — the turn stays active while we queue behind it.
        const { fake, instance } = yield* openFake({ script: approvalTurnScript });
        const attachments = [{ path: "/tmp/poseidon-test/note.txt", mime: "text/plain" }];
        const mentions = ["src/app.ts"];
        const references = [
          { kind: "skill" as const, name: "release-notes" },
          { kind: "plugin" as const, name: "linters" },
        ];
        yield* Effect.gen(function* () {
          const engine = yield* OrchestrationEngine;
          yield* engine.dispatch(createProject);
          yield* engine.dispatch(createThread);

          const opened = yield* awaitEvent(engine, isType("thread.approval.opened"));
          yield* engine.dispatch(turnStart("first"));
          yield* Fiber.join(opened);

          yield* engine.dispatch({
            commandId: makeCommandId(),
            createdAt: NOW,
            type: "thread.turn.start",
            threadId,
            text: "second",
            attachments,
            mentions,
            references,
            queued: true,
          });
          expect((yield* engine.threadDetail(threadId))?.queue).toHaveLength(1);

          const requested = yield* awaitEvent(engine, isType("thread.turn.requested"));
          // The drain's send() lands after its request event publishes; the
          // next turn.started proves the handle got the call.
          const secondStarted = yield* awaitEvent(engine, isType("thread.turn.started"));
          yield* engine.dispatch({
            commandId: makeCommandId(),
            createdAt: NOW,
            type: "thread.approval.respond",
            threadId,
            requestId: (yield* engine.threadDetail(threadId))!.pendingApproval!.requestId,
            decision: "allow-once",
          });
          const event = yield* Fiber.join(requested);
          yield* Fiber.join(secondStarted);
          expect(Option.isSome(event)).toBe(true);
          const payload = Option.getOrThrow(event).payload as {
            text: string;
            attachments: unknown;
            mentions: unknown;
            references: unknown;
          };
          expect(payload.text).toBe("second");
          expect(payload.attachments).toEqual(attachments);
          expect(payload.mentions).toEqual(mentions);
          expect(payload.references).toEqual(references);
        }).pipe(Effect.provide(stackLayer({ instance })));

        const session = yield* fake.session(threadId);
        const sends = (yield* session!.calls).filter((call) => call.method === "send");
        const drained = sends.find((call) => call.detail.text === "second");
        expect(drained?.detail.attachments).toEqual(attachments);
        expect(drained?.detail.mentions).toEqual(mentions);
        expect(drained?.detail.references).toEqual(references);
      }),
  );

  it.effect("a drained message the decider refuses goes back into the queue", () =>
    Effect.gen(function* () {
      // The dequeue commits in its own transaction and the turn is dispatched
      // in a second one. Anything that makes the decider refuse that command in
      // the gap used to destroy the message outright: gone from the strip,
      // never sent, and nothing anywhere holding the text the user typed. A
      // `restoring` thread is the deterministic version of that window.
      const { instance } = yield* openFake({ script: approvalTurnScript });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const opened = yield* awaitEvent(engine, isType("thread.approval.opened"));
        yield* engine.dispatch(turnStart("first"));
        yield* Fiber.join(opened);

        yield* engine.dispatch(turnStart("second", true));
        expect((yield* engine.threadDetail(threadId))?.queue).toHaveLength(1);

        // Straight onto the log, because the decider refuses a restore while a
        // turn runs — which is the point: the flag flips under the drain.
        yield* engine.appendThreadEvents(threadId, [
          {
            eventId: makeEventId(),
            streamKind: "thread",
            streamId: threadId,
            occurredAt: NOW,
            actor: "system",
            type: "thread.checkpoint.restore.requested",
            payload: {
              checkpoint: {
                checkpointId: makeCheckpointId(),
                turnId: makeTurnId(),
                ref: "refs/poseidon/checkpoints/one",
                createdAt: NOW,
              },
            },
          } as PlannedEvent,
        ]);

        const requeued = yield* awaitEvent(engine, isType("thread.message.queued"));
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.approval.respond",
          threadId,
          requestId: (yield* engine.threadDetail(threadId))!.pendingApproval!.requestId,
          decision: "allow-once",
        });
        yield* Fiber.join(requeued);

        const after = yield* engine.threadDetail(threadId);
        expect(after?.queue.map((message) => message.text)).toEqual(["second"]);
      }).pipe(Effect.provide(stackLayer({ instance, checkpoints: false, supervisor: false })));
    }),
  );

  it.effect("a steered message reaches the running turn, and its row lands in that turn", () =>
    Effect.gen(function* () {
      // The approval script holds the turn open until the request is
      // answered, so the steer arrives while it is certainly still running.
      const { fake, instance } = yield* openFake({
        script: approvalTurnScript,
        capabilities: { steering: true },
      });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const opened = yield* awaitEvent(engine, isType("thread.approval.opened"));
        yield* engine.dispatch(turnStart("first"));
        yield* Fiber.join(opened);
        const turnId = (yield* engine.threadDetail(threadId))?.currentTurnId;

        const receipt = yield* engine.dispatch(turnSteer("use port 8081"));
        expect(receipt.status).toBe("accepted");

        // The reactor handles events in order, so by the time the approval
        // answer has completed the turn, the steer before it has been made.
        const completed = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.approval.respond",
          threadId,
          requestId: (yield* engine.threadDetail(threadId))!.pendingApproval!.requestId,
          decision: "allow-once",
        });
        yield* Fiber.join(completed);

        const detail = yield* engine.threadDetail(threadId);
        const rows = detail?.items.filter((item) => item.kind === "user_message") ?? [];
        expect(rows.map((row) => [row.text, row.turnId])).toEqual([
          ["first", turnId],
          ["use port 8081", turnId],
        ]);
        expect(detail?.queue).toEqual([]);
        expect(detail?.status).toBe("idle");
      }).pipe(Effect.provide(stackLayer({ instance })));

      const session = yield* fake.session(threadId);
      const calls = yield* session!.calls;
      // One turn: the steered text went to `steer`, never to a second `send`.
      expect(calls.filter((call) => call.method === "send")).toHaveLength(1);
      expect(calls.filter((call) => call.method === "steer")).toEqual([
        {
          method: "steer",
          detail: { text: "use port 8081", attachments: [], mentions: ["README.md"] },
        },
      ]);
    }),
  );

  it.effect("a steer the harness refuses falls back to the queue, with one row in total", () =>
    Effect.gen(function* () {
      const { fake, instance } = yield* openFake({
        script: approvalTurnScript,
        capabilities: { steering: true },
        refuseSteering: true,
      });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const opened = yield* awaitEvent(engine, isType("thread.approval.opened"));
        yield* engine.dispatch(turnStart("first"));
        yield* Fiber.join(opened);

        const queued = yield* awaitEvent(engine, isType("thread.message.queued"));
        yield* engine.dispatch(turnSteer("use port 8081"));
        yield* Fiber.join(queued);

        const detail = yield* engine.threadDetail(threadId);
        expect(detail?.queue.map((message) => [message.text, message.mentions])).toEqual([
          ["use port 8081", ["README.md"]],
        ]);
        const firstTurn = detail?.currentTurnId;
        const userRows = (items: ReadonlyArray<{ kind: string; text?: string; turnId?: string }>) =>
          items
            .filter((item) => item.kind === "user_message")
            .map((item) => [item.text, item.turnId]);
        // The turn the steer missed never saw the message, so it holds no row
        // for it: the row belongs to the turn the queue starts.
        expect(userRows(detail?.items ?? [])).toEqual([["first", firstTurn]]);

        // Finishing the first turn drains the queue into a second one, which
        // opens its own approval once it runs.
        const next = yield* awaitEvent(engine, isType("thread.approval.opened"));
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.approval.respond",
          threadId,
          requestId: detail!.pendingApproval!.requestId,
          decision: "allow-once",
        });
        yield* Fiber.join(next);

        const drained = yield* engine.threadDetail(threadId);
        const secondTurn = drained?.currentTurnId;
        expect(secondTurn).not.toBe(firstTurn);
        expect(drained?.queue).toEqual([]);
        // Exactly one row for the steered message in total, in the new turn.
        expect(userRows(drained?.items ?? [])).toEqual([
          ["first", firstTurn],
          ["use port 8081", secondTurn],
        ]);
      }).pipe(Effect.provide(stackLayer({ instance })));

      const session = yield* fake.session(threadId);
      // The steer was tried and refused; the message waited on the queue and
      // went out as the next turn's own send.
      const methods = (yield* session!.calls).map((call) => call.method);
      expect(methods.slice(0, 2)).toEqual(["send", "steer"]);
      expect(methods.filter((method) => method === "send")).toHaveLength(2);
    }),
  );

  it.effect("deleting a thread stops the session instead of reporting a crash", () =>
    Effect.gen(function* () {
      const { fake, instance } = yield* openFake();
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        const sessions = yield* SessionManager;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const bound = yield* awaitEvent(engine, isType("thread.session.bound"));
        yield* engine.dispatch(turnStart("hello"));
        yield* Fiber.join(bound);

        // Subscribe before deleting: a PubSub subscription only sees what
        // lands after it exists.
        const ended = yield* sessions.lifecycle.pipe(
          Stream.filter((entry) => entry.kind === "ended"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.delete",
          threadId,
        });
        const entry = yield* Fiber.join(ended);
        // `stopped`, not `crashed` — a deliberate close must not look like a
        // loss, or the supervisor would try to resurrect it.
        expect(Option.isSome(entry)).toBe(true);
        if (Option.isSome(entry) && entry.value.kind === "ended") {
          expect(entry.value.reason).toBe("stopped");
        }
      }).pipe(
        Effect.provide(
          stackLayer({ instance, supervisor: { baseDelayMillis: 0, maxAttempts: 3 } }),
        ),
      );

      // The handle's close() actually ran — the imaginary process is gone.
      expect(yield* fake.processGone(threadId)).toBe(true);
      // And nothing resurrected a session for the deleted thread.
      expect((yield* fake.sessions).length).toBe(1);
    }),
  );

  it.effect("archiving a thread stops its session", () =>
    Effect.gen(function* () {
      const { fake, instance } = yield* openFake();
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        const sessions = yield* SessionManager;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const completed = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch(turnStart("hello"));
        yield* Fiber.join(completed);

        const ended = yield* sessions.lifecycle.pipe(
          Stream.filter((entry) => entry.kind === "ended"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.archive",
          threadId,
        });

        const entry = yield* Fiber.join(ended);
        expect(Option.isSome(entry)).toBe(true);
        if (Option.isSome(entry) && entry.value.kind === "ended") {
          expect(entry.value.reason).toBe("stopped");
        }
      }).pipe(Effect.provide(stackLayer({ instance })));

      // Archiving is not deleting, but the connector process still goes.
      expect(yield* fake.processGone(threadId)).toBe(true);
    }),
  );

  it.effect("archiving a thread mid-turn settles the turn nothing can finish", () =>
    Effect.gen(function* () {
      const { instance } = yield* openFake({ script: approvalTurnScript });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        // The script holds its `turn.completed` back until the approval is
        // answered, so the turn is genuinely in flight.
        const opened = yield* awaitEvent(engine, isType("thread.approval.opened"));
        yield* engine.dispatch(turnStart("npm run build"));
        yield* Fiber.join(opened);
        expect((yield* engine.threadDoc(threadId))?.currentTurn).not.toBeNull();

        const completed = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* Effect.yieldNow;
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.archive",
          threadId,
        });

        // Killing the connector leaves nobody to write the completion, so the
        // thread would keep `currentTurn` for good — and the supervisor does
        // not resume a session that was stopped on purpose.
        const entry = yield* Fiber.join(completed).pipe(Effect.timeout("5 seconds"));
        expect(Option.isSome(entry)).toBe(true);
        if (Option.isSome(entry)) {
          expect((entry.value.payload as { readonly stopReason: string }).stopReason).toBe(
            "interrupted",
          );
        }

        const doc = yield* engine.threadDoc(threadId);
        expect(doc?.currentTurn).toBeNull();
        expect(doc?.interrupting).toBe(false);
        // And settling the turn did not put the thread back in the sidebar.
        expect(doc?.status).toBe("archived");
      }).pipe(Effect.provide(stackLayer({ instance })));
    }),
  );

  it.effect("unarchiving a thread resumes the session the archive closed", () =>
    Effect.gen(function* () {
      const { fake, instance } = yield* openFake();
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        const sessions = yield* SessionManager;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const first = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch(turnStart("hello"));
        yield* Fiber.join(first);

        const ended = yield* sessions.lifecycle.pipe(
          Stream.filter((entry) => entry.kind === "ended"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.archive",
          threadId,
        });
        yield* Fiber.join(ended);
        expect(yield* fake.processGone(threadId)).toBe(true);

        const receipt = yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.unarchive",
          threadId,
        });
        expect(receipt.status).toBe("accepted");
        expect((yield* engine.threadDoc(threadId))?.status).toBe("idle");

        const second = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch(turnStart("hello again"));
        const entry = yield* Fiber.join(second).pipe(Effect.timeout("5 seconds"));
        expect(Option.isSome(entry)).toBe(true);
      }).pipe(Effect.provide(stackLayer({ instance })));

      // `resumeSession`, not `startSession`: the conversation the archive
      // closed is the one the next turn continues.
      const opened = yield* fake.sessions;
      expect(opened.length).toBe(2);
      expect(yield* opened[1]!.handle.sessionRef()).toEqual(yield* opened[0]!.handle.sessionRef());
      const sends = (yield* opened[1]!.calls).filter((call) => call.method === "send");
      expect(sends.map((call) => call.detail.text)).toEqual(["hello again"]);
    }),
  );

  it.effect("a turn sent right after unarchiving mid-turn survives the old turn settling", () =>
    Effect.gen(function* () {
      const { instance } = yield* openFake({ script: approvalTurnScript });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        // The script holds its `turn.completed` back until the approval is
        // answered, so the first turn is in flight when the archive lands.
        const opened = yield* awaitEvent(engine, isType("thread.approval.opened"));
        yield* engine.dispatch(turnStart("npm run build"));
        yield* Fiber.join(opened);
        const firstTurn = (yield* engine.threadDoc(threadId))?.currentTurn?.turnId;

        // No waiting between the three: the close the archive asked for may
        // settle the first turn before or after the second one starts.
        const reopened = yield* awaitEvent(engine, isType("thread.approval.opened"));
        yield* Effect.yieldNow;
        for (const type of ["thread.archive", "thread.unarchive"] as const) {
          yield* engine.dispatch({ commandId: makeCommandId(), createdAt: NOW, type, threadId });
        }
        expect((yield* engine.dispatch(turnStart("npm test"))).status).toBe("accepted");
        const entry = yield* Fiber.join(reopened).pipe(Effect.timeout("10 seconds"));
        expect(Option.isSome(entry)).toBe(true);

        const doc = yield* engine.threadDoc(threadId);
        expect(doc?.currentTurn?.input.text).toBe("npm test");
        expect(doc?.currentTurn?.turnId).not.toBe(firstTurn);
        expect(doc?.status).not.toBe("error");
      }).pipe(Effect.provide(stackLayer({ instance })));
    }),
  );

  it.effect("removing a project deletes its threads and stops their sessions", () =>
    Effect.gen(function* () {
      const { fake, instance } = yield* openFake();
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        const sessions = yield* SessionManager;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const bound = yield* awaitEvent(engine, isType("thread.session.bound"));
        yield* engine.dispatch(turnStart("hello"));
        yield* Fiber.join(bound);

        const ended = yield* sessions.lifecycle.pipe(
          Stream.filter((entry) => entry.kind === "ended"),
          Stream.runHead,
          Effect.forkChild,
        );
        const deleted = yield* awaitEvent(engine, isType("thread.deleted"));
        yield* Effect.yieldNow;
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "project.remove",
          projectId,
        });

        // The thread stream gets its own `thread.deleted` — without it the
        // connector keeps running with nothing attached, and every event it
        // still produces is dropped for want of a projection row.
        expect(Option.isSome(yield* Fiber.join(deleted))).toBe(true);
        const entry = yield* Fiber.join(ended);
        expect(Option.isSome(entry)).toBe(true);
        if (Option.isSome(entry) && entry.value.kind === "ended") {
          expect(entry.value.reason).toBe("stopped");
        }
        expect(yield* engine.threadDoc(threadId)).toBeNull();
      }).pipe(Effect.provide(stackLayer({ instance })));

      expect(yield* fake.processGone(threadId)).toBe(true);
    }),
  );

  it.effect("resumes a crashed session and re-runs the in-flight turn", () =>
    Effect.gen(function* () {
      // No turn.completed in the script body — the turn stays in flight until
      // the fake's own completion fires, so a crash mid-replay is mid-turn.
      const script: FakeTurnScript = ({ turnId }) => [
        {
          turnId,
          type: "item.started",
          payload: {
            item: {
              itemId: makeItemId(),
              kind: "assistant_message",
              status: "in_progress",
            },
          },
        },
      ];
      const { fake, instance } = yield* openFake({ script });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        // Subscribe for the *second* bound before the crash can produce it.
        const firstBound = yield* awaitEvent(engine, isType("thread.session.bound"));
        yield* engine.dispatch(turnStart("work"));
        yield* Fiber.join(firstBound);

        const secondBound = yield* awaitEvent(engine, isType("thread.session.bound"));
        const completed = yield* awaitEvent(engine, isType("thread.turn.completed"));
        // The crash has to be visible: `session.ended` maps to no event, so
        // without this notice the answer just stops mid-sentence.
        const notice = yield* awaitEvent(engine, isType("thread.error"));

        const session = yield* fake.session(threadId);
        expect(session).not.toBeUndefined();
        yield* session!.pause;
        yield* session!.crash({ exitCode: 137 });

        const recorded = yield* Fiber.join(notice);
        expect(Option.isSome(recorded)).toBe(true);
        if (Option.isSome(recorded)) {
          const payload = recorded.value.payload as { message: string; fatal: boolean };
          expect(payload.fatal).toBe(false);
          expect(payload.message).toContain("exited unexpectedly");
        }

        yield* Fiber.join(secondBound);
        yield* Fiber.join(completed);

        const detail = yield* engine.threadDetail(threadId);
        expect(detail?.status).toBe("idle");
        const all = yield* fake.sessions;
        expect(all.length).toBe(2);
      }).pipe(
        Effect.provide(
          stackLayer({
            instance,
            supervisor: { baseDelayMillis: 0, maxAttempts: 3 },
          }),
        ),
      );
    }),
  );

  it.effect("sweeps up threads a half-finished project removal left behind", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { instance } = yield* openFake();
        const persistence = Layer.succeedContext(yield* Layer.build(persistenceLayer()));

        // The state a crash between `project.removed` and the thread deletes
        // leaves: a thread row whose project is gone.
        yield* Effect.gen(function* () {
          const engine = yield* OrchestrationEngine;
          yield* engine.dispatch(createProject);
          yield* engine.dispatch(createThread);
          yield* engine.dispatch({
            commandId: makeCommandId(),
            createdAt: NOW,
            type: "project.remove",
            projectId,
          });
          expect(yield* engine.threadDoc(threadId)).not.toBeNull();
        }).pipe(Effect.provide(engineLayer(persistence)));

        yield* Effect.gen(function* () {
          const engine = yield* OrchestrationEngine;
          yield* Stream.runHead(engine.events.pipe(Stream.filter(isType("thread.deleted")))).pipe(
            Effect.timeout("5 seconds"),
          );
          expect(yield* engine.threadDoc(threadId)).toBeNull();
        }).pipe(Effect.provide(stackLayer({ instance, persistence, supervisor: false })));
      }),
    ),
  );

  it.effect("resumes a mid-turn thread from a database a previous process left", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "poseidon-boot-"))),
        (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
      );
      const persistence = persistenceLayer(NodePath.join(directory, "state.sqlite"));
      const sessionRef = { sessionId: "persisted-session" };
      const { fake, instance } = yield* openFake();

      // The state a killed process leaves behind: a bound session and a turn
      // still in flight, on disk and nowhere else.
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);
        yield* engine.dispatch(turnStart("survive the restart"));
        yield* engine.appendThreadEvents(threadId, [
          {
            eventId: makeEventId(),
            streamKind: "thread",
            streamId: threadId,
            occurredAt: NOW,
            actor: "connector",
            type: "thread.session.bound",
            payload: {
              connectorInstanceId: instance.instanceId,
              connectorKind: instance.kind,
              sessionRef,
            },
          } as PlannedEvent,
        ]);
        const doc = yield* engine.threadDoc(threadId);
        expect(doc?.currentTurn).not.toBeNull();
      }).pipe(Effect.provide(engineLayer(persistence)));

      // A second stack over the same file: the boot scan resumes the session
      // and the reactor re-sends the turn the first process never finished.
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* Stream.runHead(
          engine.events.pipe(Stream.filter(isType("thread.turn.completed"))),
        ).pipe(Effect.timeout("10 seconds"));
        expect((yield* engine.threadDetail(threadId))?.status).toBe("idle");
      }).pipe(
        Effect.provide(
          stackLayer({ instance, persistence, supervisor: { baseDelayMillis: 0, maxAttempts: 3 } }),
        ),
      );

      const session = yield* fake.session(threadId);
      expect(session).not.toBeUndefined();
      // `resumeSession`, not `startSession`: the ref the first process stored
      // is the one the new session carries.
      expect((yield* fake.sessions).length).toBe(1);
      expect(yield* session!.handle.sessionRef()).toEqual(sessionRef);
      const sends = (yield* session!.calls).filter((call) => call.method === "send");
      expect(sends.map((call) => call.detail.text)).toContain("survive the restart");
    }).pipe(Effect.scoped),
  );

  it.effect("logs every failed resume attempt before declaring the session lost", () =>
    Effect.gen(function* () {
      const { fake, instance } = yield* openFake();
      // Same instance, but resume always fails — the crash below forces the
      // supervisor through its whole retry budget.
      const brokenResume: ConnectorInstance = {
        ...instance,
        resumeSession: () =>
          Effect.fail(
            new SpawnFailed({
              kind: instance.kind,
              instanceId: instance.instanceId,
              message: "process image is gone",
            }),
          ),
      };
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const bound = yield* awaitEvent(engine, isType("thread.session.bound"));
        const completed = yield* awaitEvent(engine, isType("thread.turn.completed"));
        const lost = yield* awaitEvent(engine, isType("thread.session.lost"));
        yield* engine.dispatch(turnStart("hello"));
        yield* Fiber.join(bound);
        yield* Fiber.join(completed);

        const session = yield* fake.session(threadId);
        yield* session!.crash();
        yield* Fiber.join(lost);
      }).pipe(
        Effect.provide(
          stackLayer({
            instance: brokenResume,
            supervisor: { baseDelayMillis: 0, maxAttempts: 3 },
          }),
        ),
      );

      const lines = yield* TestConsole.logLines;
      const attempts = lines.filter(
        (line) => typeof line === "string" && line.includes("resume attempt"),
      );
      expect(attempts).toHaveLength(3);
      expect(attempts[0]).toContain("resume attempt 1 of 3");
    }),
  );

  it.effect("a lost session keeps the queue for the user's next turn to drain", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "poseidon-queue-"))),
        (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
      );
      const persistence = persistenceLayer(NodePath.join(directory, "state.sqlite"));
      const { instance } = yield* openFake();

      // What a killed process leaves on disk: a turn in flight, a message the
      // user queued behind it, and no session anywhere — so nothing will ever
      // produce the `turn.completed` that drains a queue.
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);
        yield* engine.dispatch(turnStart("interrupted work"));
        yield* engine.dispatch(turnStart("queued behind it", true));
        const doc = yield* engine.threadDoc(threadId);
        expect(doc?.currentTurn).not.toBeNull();
        expect(doc?.queue).toHaveLength(1);
      }).pipe(Effect.provide(engineLayer(persistence)));

      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        // The boot scan runs inline while this layer is built — a running
        // thread with no session is declared lost before any client could
        // connect — so it has already happened by the time we get here.

        // The turn and the dead process's open questions go; what the user
        // typed stays. Sending it here would post it into the loss, and
        // re-entering `ensure` with a missing binary loops — so it waits in
        // the strip where they put it.
        const afterLoss = yield* engine.threadDetail(threadId);
        expect(afterLoss?.queue.map((message) => message.text)).toEqual(["queued behind it"]);
        expect(afterLoss?.currentTurnId).toBeNull();
        expect(afterLoss?.pendingApproval).toBeNull();
        expect(afterLoss?.pendingUserInput).toBeNull();
        expect(afterLoss?.status).toBe("error");

        // The next thing the user does is what starts it moving: the turn is
        // accepted — no "a turn is already running" — and its completion runs
        // the drain every other completion runs.
        const drained = yield* awaitEvent(
          engine,
          (event) =>
            event.type === "thread.turn.requested" &&
            (event.payload as { readonly text: string }).text === "queued behind it",
        );
        const receipt = yield* engine.dispatch(turnStart("carry on"));
        expect(receipt.status).toBe("accepted");
        // The dequeue is appended before the request it redispatches, so the
        // request arriving is proof the strip is empty.
        expect(Option.isSome(yield* Fiber.join(drained))).toBe(true);
        expect((yield* engine.threadDetail(threadId))?.queue).toEqual([]);
      }).pipe(
        Effect.provide(
          stackLayer({ instance, persistence, supervisor: { baseDelayMillis: 0, maxAttempts: 2 } }),
        ),
      );
    }).pipe(Effect.scoped),
  );
});

// ── Deterministic projections ────────────────────────────────

/** UUIDv7-shaped ids from a counter — valid for every brand. */
const seededEnv = () => {
  let n = 0;
  const next = () => `00000000-0000-7000-8000-${(++n).toString(16).padStart(12, "0")}`;
  return {
    now: () => "2026-01-02T03:04:05.000Z",
    nextEventId: () => next() as never,
    nextTurnId: () => next() as never,
    nextItemId: () => next() as never,
  };
};

const deterministicRun = () => {
  const env = seededEnv();
  return Effect.gen(function* () {
    const engine = yield* OrchestrationEngine;
    yield* engine.dispatch(createProject);
    yield* engine.dispatch(createThread);
    yield* engine.dispatch(turnStart("hello"));

    const detail = yield* engine.threadDetail(threadId);
    const turnId = detail!.currentTurnId!;

    yield* engine.appendThreadEvents(threadId, [
      {
        eventId: env.nextEventId(),
        streamKind: "thread",
        streamId: threadId,
        occurredAt: env.now(),
        actor: "connector",
        type: "thread.turn.started",
        payload: { turnId },
      } as PlannedEvent,
      {
        eventId: env.nextEventId(),
        streamKind: "thread",
        streamId: threadId,
        occurredAt: env.now(),
        actor: "connector",
        type: "thread.item.upserted",
        payload: {
          item: {
            itemId: env.nextItemId(),
            kind: "assistant_message",
            status: "completed",
            text: "done",
          },
        },
      } as PlannedEvent,
      {
        eventId: env.nextEventId(),
        streamKind: "thread",
        streamId: threadId,
        occurredAt: env.now(),
        actor: "connector",
        type: "thread.turn.completed",
        payload: { turnId, stopReason: "end_turn" },
      } as PlannedEvent,
    ]);
    return yield* engine.threadDoc(threadId);
  }).pipe(Effect.provide(engineLayer()), Effect.provideService(EngineEnv, env));
};

describe("projection determinism", () => {
  it.effect("produces byte-identical documents across two runs", () =>
    Effect.gen(function* () {
      const first = yield* deterministicRun();
      const second = yield* deterministicRun();
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(first?.status).toBe("idle");
      // The user's row from thread.turn.start, then the connector's answer.
      expect(first?.items.map((item) => item.kind)).toEqual(["user_message", "assistant_message"]);
    }),
  );
});
