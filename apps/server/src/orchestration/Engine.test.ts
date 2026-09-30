import { describe, expect, it } from "@effect/vitest";
import {
  makeCheckpointId,
  makeCommandId,
  makeConnectorInstanceId,
  makeEventId,
  makeProjectId,
  makeItemId,
  makeThreadId,
  makeTurnId,
} from "@poseidon/contracts/ids";
import type { ThreadId } from "@poseidon/contracts/ids";
import type { Command } from "@poseidon/contracts/orchestration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngine } from "./Engine";
import { ConnectorModels } from "../settings/connectorRouting";
import { engineLayer, persistenceLayer } from "../../test/layers";

const NOW = "2026-01-02T03:04:05.000Z";

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

const ingested = (
  type: "thread.turn.started" | "thread.turn.completed",
  payload: Record<string, unknown>,
) =>
  ({
    eventId: makeEventId(),
    streamKind: "thread" as const,
    streamId: threadId,
    occurredAt: NOW,
    actor: "connector" as const,
    type,
    payload,
  }) as unknown as import("../persistence/EventStore").PlannedEvent;

describe("OrchestrationEngine", () => {
  it.effect("dispatches commands, projects them, and receipts idempotently", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;

      const receipt = yield* engine.dispatch(createProject);
      expect(receipt.status).toBe("accepted");
      expect(receipt.lastSequence).toBe(1);

      // Same commandId → the stored receipt, not a second append.
      const again = yield* engine.dispatch(createProject);
      expect(again).toEqual(receipt);

      yield* engine.dispatch(createThread);
      yield* engine.dispatch(turnStart("hello"));

      const projects = yield* engine.listProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]?.name).toBe("demo");
      expect(projects[0]?.threadCount).toBe(1);

      const detail = yield* engine.threadDetail(threadId);
      expect(detail?.status).toBe("running");
      expect(detail?.currentTurnId).not.toBeNull();
    }).pipe(Effect.provide(engineLayer())),
  );

  it.effect("rejects invalid commands and receipts the rejection", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      const bad: Command = {
        commandId: makeCommandId(),
        createdAt: NOW,
        type: "thread.create",
        threadId: makeThreadId(),
        projectId: makeProjectId(), // never created
        settings: { model: "fake/model" },
      };
      const receipt = yield* engine.dispatch(bad);
      expect(receipt.status).toBe("rejected");
      expect(receipt.reason).toContain("does not exist");

      const again = yield* engine.dispatch(bad);
      expect(again).toEqual(receipt);
    }).pipe(Effect.provide(engineLayer())),
  );

  it.effect("plans an append from the thread doc as it is at append time", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      yield* engine.dispatch(createProject);
      yield* engine.dispatch(createThread);
      yield* engine.dispatch(turnStart("first"));
      yield* engine.dispatch(turnStart("second", true));

      const queued = (yield* engine.threadDoc(threadId))?.queue ?? [];
      expect(queued).toHaveLength(1);
      const removed = yield* engine.dispatch({
        commandId: makeCommandId(),
        createdAt: NOW,
        type: "thread.queue.remove",
        threadId,
        queuedMessageId: queued[0]!.queuedMessageId,
      });
      expect(removed.status).toBe("accepted");

      // This is what keeps the queue drain honest: the reactor decides what to
      // dequeue from the doc the transaction holds, so a removal accepted in
      // the meantime is already visible and nothing is redispatched.
      const seen: Array<number> = [];
      const last = yield* engine.appendThreadEvents(threadId, (doc) => {
        seen.push(doc.queue.length);
        return doc.queue.length === 0
          ? []
          : [ingested("thread.turn.completed", { turnId: makeTurnId(), stopReason: "end_turn" })];
      });
      expect(seen).toEqual([0]);
      expect(last).toBe(removed.lastSequence);
    }).pipe(Effect.provide(engineLayer())),
  );

  it.effect("projects a queue reorder into the thread document", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      yield* engine.dispatch(createProject);
      yield* engine.dispatch(createThread);
      yield* engine.dispatch(turnStart("first"));
      yield* engine.dispatch(turnStart("queued one", true));
      yield* engine.dispatch(turnStart("queued two", true));

      const before = (yield* engine.threadDoc(threadId))?.queue ?? [];
      expect(before.map((message) => message.text)).toEqual(["queued one", "queued two"]);

      const receipt = yield* engine.dispatch({
        commandId: makeCommandId(),
        createdAt: NOW,
        type: "thread.queue.reorder",
        threadId,
        queuedMessageId: before[1]!.queuedMessageId,
        toIndex: 0,
      });
      expect(receipt.status).toBe("accepted");
      const after = (yield* engine.threadDoc(threadId))?.queue ?? [];
      expect(after.map((message) => message.text)).toEqual(["queued two", "queued one"]);
    }).pipe(Effect.provide(engineLayer())),
  );

  it.effect("streams snapshot → synchronized → live events to subscribers", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      yield* engine.dispatch(createProject);
      yield* engine.dispatch(createThread);

      const stream = yield* engine.subscribeThread(threadId, { coalesceWindow: 0 });
      const fiber = yield* stream.pipe(Stream.take(4), Stream.runCollect, Effect.forkChild);

      yield* engine.dispatch(turnStart("hello"));
      yield* engine.appendThreadEvents(threadId, [
        ingested("thread.turn.completed", {
          turnId: makeTurnId(),
          stopReason: "end_turn",
        }),
      ]);

      const items = yield* Fiber.join(fiber);
      expect(items[0]?.kind).toBe("snapshot");
      expect(items[1]?.kind).toBe("synchronized");
      expect(items[2]?.kind).toBe("event");
      expect(items[3]?.kind).toBe("event");
    }).pipe(Effect.provide(engineLayer())),
  );

  it.effect("replays from afterSequence for reconnecting subscribers", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      yield* engine.dispatch(createProject);
      yield* engine.dispatch(createThread);
      const turn = yield* engine.dispatch(turnStart("hello"));
      const cutoff = turn.lastSequence;

      yield* engine.appendThreadEvents(threadId, [
        ingested("thread.turn.started", { turnId: makeTurnId() }),
        ingested("thread.turn.completed", {
          turnId: makeTurnId(),
          stopReason: "end_turn",
        }),
      ]);

      const stream = yield* engine.subscribeThread(threadId, {
        afterSequence: cutoff,
        coalesceWindow: 0,
      });
      const list = yield* stream.pipe(Stream.take(3), Stream.runCollect);
      expect(list[0]?.kind).toBe("event");
      expect(list[1]?.kind).toBe("event");
      expect(list[2]?.kind).toBe("synchronized");
    }).pipe(Effect.provide(engineLayer())),
  );

  it.effect("fails an over-budget subscription with resnapshot-required", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      yield* engine.dispatch(createProject);
      yield* engine.dispatch(createThread);

      // Tiny budget: 3 retained items max.
      const stream = yield* engine.subscribeThread(threadId, {
        coalesceWindow: 0,
        maxItems: 3,
      });

      // Produce before consuming: nothing drains the buffer, so the budget
      // fills deterministically.
      for (let i = 0; i < 8; i++) {
        yield* engine.appendThreadEvents(threadId, [
          {
            eventId: makeEventId(),
            streamKind: "thread",
            streamId: threadId,
            occurredAt: NOW,
            actor: "connector",
            type: "thread.item.upserted",
            payload: {
              item: {
                itemId: makeItemId(),
                kind: "assistant_message",
                status: "completed",
                text: `chunk ${i}`,
              },
            },
          },
        ]);
      }

      const collected = yield* stream.pipe(Stream.runCollect);
      const items = collected;
      expect(items.at(-1)?.kind).toBe("resnapshot-required");

      // Resubscribing recovers from the last valid position.
      const replay = yield* engine.subscribeThread(threadId, {
        afterSequence: 1,
        coalesceWindow: 0,
        maxItems: 100,
      });
      const list = yield* replay.pipe(
        Stream.takeWhile((item) => item.kind !== "synchronized"),
        Stream.runCollect,
      );
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((item) => item.kind === "event")).toBe(true);
    }).pipe(Effect.provide(engineLayer())),
  );

  it.effect("projects the thread list and publishes upserts", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      yield* engine.dispatch(createProject);
      yield* engine.dispatch(createThread);

      const stream = yield* engine.subscribeThreadList({ coalesceWindow: 0 });
      const fiber = yield* stream.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);

      yield* engine.dispatch(turnStart("hi"));

      const items = yield* Fiber.join(fiber);
      expect(items[0]?.kind).toBe("snapshot");
      const first = items[0];
      if (first?.kind === "snapshot") {
        expect(first.threads).toHaveLength(1);
        expect(first.threads[0]?.title).toBe("New thread");
      }
      expect(items[1]?.kind).toBe("synchronized");
      expect(items[2]?.kind).toBe("upserted");
    }).pipe(Effect.provide(engineLayer())),
  );

  it.effect("marks a thread done and clears it, on the summaries the list publishes", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      yield* engine.dispatch(createProject);
      yield* engine.dispatch(createThread);
      const done = (type: "thread.done.mark" | "thread.done.clear"): Command => ({
        commandId: makeCommandId(),
        createdAt: NOW,
        type,
        threadId,
      });

      const stream = yield* engine.subscribeThreadList({ coalesceWindow: 0 });
      const fiber = yield* stream.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      expect((yield* engine.dispatch(done("thread.done.mark"))).status).toBe("accepted");
      const items = yield* Fiber.join(fiber);
      const upserted = items[2];
      expect(upserted?.kind).toBe("upserted");
      if (upserted?.kind === "upserted") {
        expect(upserted.thread.doneAt).toBeDefined();
        expect(upserted.thread.lastActivityAt).toBeDefined();
        expect(upserted.thread.doneAt! >= upserted.thread.lastActivityAt!).toBe(true);
      }

      expect((yield* engine.dispatch(done("thread.done.clear"))).status).toBe("accepted");
      const [cleared] = yield* engine.listThreads(projectId);
      expect(cleared).not.toHaveProperty("doneAt");
      expect(cleared?.lastActivityAt).toBeDefined();
    }).pipe(Effect.provide(engineLayer())),
  );

  it.effect("starts a thread on the connector instance's own default model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const persistence = Layer.succeedContext(yield* Layer.build(persistenceLayer()));
        const preferred = makeConnectorInstanceId();

        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // The app-wide default is null until a probe has reported models,
          // which is exactly when the connector's own setting has to carry it.
          yield* sql`
            INSERT INTO settings (key, value_json, updated_at)
            VALUES (
              'settings',
              ${JSON.stringify({
                defaults: { model: null },
                connectors: [
                  {
                    connectorInstanceId: makeConnectorInstanceId(),
                    enabled: false,
                    config: { defaultModel: "acme/disabled" },
                  },
                  {
                    connectorInstanceId: preferred,
                    enabled: true,
                    config: { defaultModel: "acme/preferred" },
                  },
                  {
                    connectorInstanceId: makeConnectorInstanceId(),
                    enabled: true,
                    config: { defaultModel: "acme/second" },
                  },
                ],
              })},
              ${NOW}
            )
          `;
          const engine = yield* OrchestrationEngine;
          yield* engine.dispatch(createProject);
          yield* engine.dispatch({
            commandId: makeCommandId(),
            createdAt: NOW,
            type: "thread.create",
            threadId,
            projectId,
            settings: {},
          });
          // The first *enabled* entry of the document, which is the one
          // `ConnectorSelection` routes to — a disabled connector's model must
          // not win, and neither must a later enabled one's. The thread is
          // pinned there, so a probe landing before its first turn cannot
          // send that turn to a harness without the model.
          const settings = (yield* engine.threadDoc(threadId))?.settings;
          expect(settings?.model).toBe("acme/preferred");
          expect(settings?.connectorInstanceId).toBe(preferred);
        }).pipe(Effect.provide(OrchestrationEngine.layer.pipe(Layer.provideMerge(persistence))));
      }),
    ),
  );

  it.effect("starts a thread that chose its connector on that connector's model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const persistence = Layer.succeedContext(yield* Layer.build(persistenceLayer()));
        const chosen = makeConnectorInstanceId();

        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO settings (key, value_json, updated_at)
            VALUES (
              'settings',
              ${JSON.stringify({
                defaults: { model: "acme/shared" },
                connectors: [
                  {
                    connectorInstanceId: makeConnectorInstanceId(),
                    enabled: true,
                    config: { defaultModel: "acme/first" },
                  },
                  {
                    connectorInstanceId: chosen,
                    enabled: true,
                    config: { defaultModel: "acme/chosen" },
                  },
                ],
              })},
              ${NOW}
            )
          `;
          const engine = yield* OrchestrationEngine;
          yield* engine.dispatch(createProject);
          yield* engine.dispatch({
            commandId: makeCommandId(),
            createdAt: NOW,
            type: "thread.create",
            threadId,
            projectId,
            settings: { connectorInstanceId: chosen },
          });
          // Neither the app-wide default nor the first enabled connector: the
          // shared model may belong to another harness entirely.
          const settings = (yield* engine.threadDoc(threadId))?.settings;
          expect(settings?.model).toBe("acme/chosen");
          expect(settings?.connectorInstanceId).toBe(chosen);
        }).pipe(Effect.provide(OrchestrationEngine.layer.pipe(Layer.provideMerge(persistence))));
      }),
    ),
  );

  it.effect("asks the instances for their models before it takes the write lock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const persistence = Layer.succeedContext(yield* Layer.build(persistenceLayer()));
        const lister = makeConnectorInstanceId();
        const asked = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<ReadonlyArray<string>>();
        // A connector whose list takes as long as a harness start does.
        const models = Layer.succeed(ConnectorModels, () =>
          Effect.andThen(Deferred.succeed(asked, undefined), Deferred.await(answer)),
        );

        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO settings (key, value_json, updated_at)
            VALUES (
              'settings',
              ${JSON.stringify({
                defaults: { model: "acme/shared" },
                connectors: [{ connectorInstanceId: lister, enabled: true, config: {} }],
              })},
              ${NOW}
            )
          `;
          const engine = yield* OrchestrationEngine;
          yield* engine.dispatch(createProject);
          const create = yield* Effect.forkChild(
            engine.dispatch({
              commandId: makeCommandId(),
              createdAt: NOW,
              type: "thread.create",
              threadId,
              projectId,
              settings: {},
            }),
          );
          yield* Deferred.await(asked);
          // Every other write goes through while the create waits on the list.
          const other = yield* engine.dispatch({
            ...createProject,
            commandId: makeCommandId(),
            projectId: makeProjectId(),
            workspaceRoot: "/other",
          });
          expect(other.status).toBe("accepted");

          yield* Deferred.succeed(answer, ["acme/shared"]);
          expect((yield* Fiber.join(create)).status).toBe("accepted");
          const settings = (yield* engine.threadDoc(threadId))?.settings;
          expect(settings?.model).toBe("acme/shared");
          expect(settings?.connectorInstanceId).toBe(lister);
        }).pipe(
          Effect.provide(
            OrchestrationEngine.layer.pipe(Layer.provide(models), Layer.provideMerge(persistence)),
          ),
        );
      }),
    ),
  );
});

describe("the restore exclusion", () => {
  const create = (id: ThreadId, worktree?: { path: string; branch: string }): Command => ({
    commandId: makeCommandId(),
    createdAt: NOW,
    type: "thread.create",
    threadId: id,
    projectId,
    settings: { model: "fake/model" },
    ...(worktree === undefined ? {} : { worktree }),
  });

  const start = (id: ThreadId): Command => ({ ...turnStart("go"), threadId: id }) as Command;

  /** Gives the thread a checkpoint and orders a restore nobody carries out. */
  const restoreInFlight = (id: ThreadId) =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      const checkpointId = makeCheckpointId();
      yield* engine.appendThreadEvents(id, [
        {
          eventId: makeEventId(),
          streamKind: "thread",
          streamId: id,
          occurredAt: NOW,
          actor: "system",
          type: "thread.checkpoint.created",
          payload: {
            checkpoint: {
              checkpointId,
              turnId: makeTurnId(),
              ref: `refs/poseidon/checkpoints/${id}/x`,
              createdAt: NOW,
            },
          },
        } as unknown as import("../persistence/EventStore").PlannedEvent,
      ]);
      const receipt = yield* engine.dispatch({
        commandId: makeCommandId(),
        createdAt: NOW,
        type: "thread.checkpoint.restore",
        threadId: id,
        checkpointId,
      });
      expect(receipt.status).toBe("accepted");
    });

  it.effect("covers only the threads that share the restoring thread's directory", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      const worktree = { path: "/worktrees/demo/fix", branch: "poseidon/fix" };
      const inWorktree = makeThreadId();
      const sameWorktree = makeThreadId();
      const local = makeThreadId();
      const otherLocal = makeThreadId();
      yield* engine.dispatch(createProject);
      yield* engine.dispatch(create(inWorktree, worktree));
      yield* engine.dispatch(create(sameWorktree, worktree));
      yield* engine.dispatch(create(local));
      yield* engine.dispatch(create(otherLocal));

      yield* restoreInFlight(inWorktree);
      // The worktree's restore rewrites the worktree, not the project's root.
      expect((yield* engine.dispatch(start(local))).status).toBe("accepted");
      const blocked = yield* engine.dispatch(start(sameWorktree));
      expect(blocked.status).toBe("rejected");
      expect(blocked.reason).toContain("restoring a checkpoint");

      // And the other way round: a local restore holds every local thread.
      yield* restoreInFlight(otherLocal);
      const held = yield* engine.dispatch({ ...start(local), queued: true } as Command);
      expect(held.status).toBe("rejected");
      expect(held.reason).toContain("restoring a checkpoint");
    }).pipe(Effect.provide(engineLayer())),
  );
});

describe("projection rebuild", () => {
  it.effect("re-folds every stream when the stored rows are from an older projector", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const persistence = Layer.succeedContext(yield* Layer.build(persistenceLayer()));

        yield* Effect.gen(function* () {
          const engine = yield* OrchestrationEngine;
          const sql = yield* SqlClient.SqlClient;
          yield* engine.dispatch(createProject);
          yield* engine.dispatch(createThread);
          yield* engine.dispatch(turnStart("hello"));

          // A row a previous release wrote: the projector version predates
          // this build, and the document itself is missing fields.
          yield* sql`UPDATE projection_state SET projector_version = 0`;
          yield* sql`UPDATE threads SET doc_json = ${JSON.stringify({ stale: true })}`;
          yield* sql`DELETE FROM projects`;
        }).pipe(Effect.provide(OrchestrationEngine.layer.pipe(Layer.provideMerge(persistence))));

        // Building a second engine over the same database rebuilds from the log.
        yield* Effect.gen(function* () {
          const engine = yield* OrchestrationEngine;
          const doc = yield* engine.threadDoc(threadId);
          expect(doc?.threadId).toBe(threadId);
          expect(doc?.currentTurn).not.toBeNull();
          expect(doc?.restoring).toBe(false);
          expect(doc?.decisions).toEqual([]);
          expect((yield* engine.listProjects()).map((project) => project.projectId)).toEqual([
            projectId,
          ]);
        }).pipe(Effect.provide(OrchestrationEngine.layer.pipe(Layer.provideMerge(persistence))));
      }),
    ),
  );

  it.effect("leaves current rows alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const persistence = Layer.succeedContext(yield* Layer.build(persistenceLayer()));

        yield* Effect.gen(function* () {
          const engine = yield* OrchestrationEngine;
          yield* engine.dispatch(createProject);
          yield* engine.dispatch(createThread);
        }).pipe(Effect.provide(OrchestrationEngine.layer.pipe(Layer.provideMerge(persistence))));

        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // Stamp a row the rebuild would drop; a matching version must keep it.
          yield* sql`UPDATE threads SET title = ${"kept"}`;
          const engine = yield* OrchestrationEngine;
          expect((yield* engine.threadDoc(threadId))?.threadId).toBe(threadId);
          const rows = yield* sql<{ readonly title: string }>`SELECT title FROM threads`;
          expect(rows[0]?.title).toBe("kept");
        }).pipe(Effect.provide(OrchestrationEngine.layer.pipe(Layer.provideMerge(persistence))));
      }),
    ),
  );
});
