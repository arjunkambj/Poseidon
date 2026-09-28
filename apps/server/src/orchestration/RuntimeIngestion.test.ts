/**
 * What reaches the log while an answer is still streaming.
 *
 * Every `content.delta` used to become its own `thread.item.upserted` carrying
 * the whole accumulated snapshot, and every append rewrote the thread's entire
 * document: an answer of N frames wrote O(N²) bytes plus N full-document
 * rewrites. The read side already coalesces on the same window, so the frames
 * are coalesced on the way in too — without ever losing a character, and
 * without reordering the session's stream.
 */

import { describe, expect, it } from "@effect/vitest";
import {
  makeConnectorInstanceId,
  makeEventId,
  makeItemId,
  makeThreadId,
  type ItemId,
} from "@poseidon/contracts/ids";
import type { ConnectorCapabilities, RuntimeEvent } from "@poseidon/contracts/runtime";
import type { TurnScopedSessionHandle } from "@poseidon/connector-sdk/turnScopedHandle";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { PlannedEvent } from "../persistence/EventStore";
import { ingestSession } from "./RuntimeIngestion";

const threadId = makeThreadId();
const connectorInstanceId = makeConnectorInstanceId();
const NOW = "2026-01-02T03:04:05.000Z";

const envelope = (itemId: ItemId) => ({
  eventId: makeEventId(),
  connectorInstanceId,
  threadId,
  createdAt: NOW,
  itemId,
});

const delta = (itemId: ItemId, text: string): RuntimeEvent =>
  ({
    ...envelope(itemId),
    type: "content.delta",
    payload: { itemId, kind: "text", delta: text },
  }) as RuntimeEvent;

const started = (itemId: ItemId): RuntimeEvent =>
  ({
    ...envelope(itemId),
    type: "item.started",
    payload: { item: { itemId, kind: "assistant_message", status: "in_progress" } },
  }) as RuntimeEvent;

/** Runs the ingestion over a fixed stream and answers everything it appended. */
const ingest = (events: ReadonlyArray<RuntimeEvent>, deltaWindowMillis?: number) =>
  Effect.gen(function* () {
    const appended = yield* Ref.make<ReadonlyArray<PlannedEvent>>([]);
    const handle = {
      events: Stream.fromIterable(events),
    } as unknown as TurnScopedSessionHandle;
    yield* ingestSession(
      handle,
      { threadId, connectorInstanceId, connectorKind: "fake" as never },
      {
        append: (_, planned) => Ref.update(appended, (all) => [...all, ...planned]),
        report: () => Effect.void,
        ...(deltaWindowMillis === undefined ? {} : { deltaWindowMillis }),
      },
    );
    return yield* Ref.get(appended);
  });

/** Runs the ingestion over a fixed stream and answers the texts it appended. */
const run = (events: ReadonlyArray<RuntimeEvent>, deltaWindowMillis?: number) =>
  ingest(events, deltaWindowMillis).pipe(
    Effect.map((appended) =>
      appended.map((event) => {
        const payload = event.payload as { readonly item?: { readonly text?: string } };
        return payload.item?.text ?? "";
      }),
    ),
  );

describe("ingestSession", () => {
  it.effect("writes one snapshot per window, and the last one always lands", () =>
    Effect.gen(function* () {
      // The test clock does not move, so every frame after the first falls
      // inside the window — which is exactly the shape of a real burst.
      const itemId = makeItemId();
      const texts = yield* run([
        started(itemId),
        delta(itemId, "Hel"),
        delta(itemId, "lo "),
        delta(itemId, "wor"),
        delta(itemId, "ld"),
      ]);
      // The started item, the first delta, and the held snapshot flushed when
      // the stream ended. Nothing in between, and nothing lost.
      expect(texts).toEqual(["", "Hel", "Hello world"]);
    }),
  );

  it.effect("writes every frame when the window is off", () =>
    Effect.gen(function* () {
      const itemId = makeItemId();
      const texts = yield* run([delta(itemId, "a"), delta(itemId, "b"), delta(itemId, "c")], 0);
      expect(texts).toEqual(["a", "ab", "abc"]);
    }),
  );

  it.effect("flushes a held frame before anything else of the session", () =>
    Effect.gen(function* () {
      // Coalescing may not reorder the stream: an item's text has to be in the
      // log before the tool call or the next item that followed it.
      const first = makeItemId();
      const second = makeItemId();
      const texts = yield* run([
        delta(first, "one"),
        delta(first, "!"),
        started(second),
        delta(second, "two"),
      ]);
      expect(texts).toEqual(["one", "one!", "", "two"]);
    }),
  );

  it.effect("keeps a task row's call when its lifecycle events update it", () =>
    Effect.gen(function* () {
      const taskId = makeItemId();
      const tool = {
        name: "Task",
        input: { description: "Audit the router", prompt: "List every unmounted handler." },
      };
      const lifecycle = (type: "task.started" | "task.completed", status: string) =>
        ({
          ...envelope(taskId),
          type,
          payload: { taskId, title: "Audit the router", status },
        }) as RuntimeEvent;
      const appended = yield* ingest([
        {
          ...envelope(taskId),
          type: "item.started",
          payload: { item: { itemId: taskId, kind: "task", status: "in_progress", tool } },
        } as RuntimeEvent,
        lifecycle("task.started", "in_progress"),
        lifecycle("task.completed", "completed"),
      ]);
      const last = appended.at(-1);
      expect(last?.type).toBe("thread.item.upserted");
      const payload = last?.payload as { readonly item?: unknown } | undefined;
      expect(payload?.item).toEqual({
        itemId: taskId,
        kind: "task",
        status: "completed",
        text: "Audit the router",
        tool,
      });
    }),
  );

  it.effect("binds the session with the capabilities its harness announced", () =>
    Effect.gen(function* () {
      const capabilities: ConnectorCapabilities = {
        modelSwitch: "in-session",
        effortSwitch: "in-session",
        steering: true,
        planMode: true,
        subagents: true,
        images: true,
        resume: true,
        fork: false,
        interrupt: "turn",
        rollback: false,
        compaction: true,
        questions: true,
        runtimeModes: ["approval-required"],
        attachments: "images",
      };
      const appended = yield* ingest([
        {
          eventId: makeEventId(),
          connectorInstanceId,
          threadId,
          createdAt: NOW,
          type: "session.started",
          payload: { sessionRef: { sessionId: "s-1" }, model: "fake/model", capabilities },
        },
      ]);
      expect(appended.map((event) => event.type)).toEqual(["thread.session.bound"]);
      expect(appended[0]?.payload).toEqual({
        connectorInstanceId,
        connectorKind: "fake",
        sessionRef: { sessionId: "s-1" },
        capabilities,
      });
    }),
  );

  it.effect("carries the ultracode a model.changed reports, and leaves it out otherwise", () =>
    Effect.gen(function* () {
      const changed = (payload: Record<string, unknown>) =>
        ({
          eventId: makeEventId(),
          connectorInstanceId,
          threadId,
          createdAt: NOW,
          type: "model.changed",
          payload,
        }) as RuntimeEvent;
      const appended = yield* ingest([
        changed({ model: "claude/sonnet", ultracode: false }),
        changed({ model: "claude/opus", effort: "high" }),
      ]);
      expect(appended.map((event) => event.type)).toEqual([
        "thread.settings.updated",
        "thread.settings.updated",
      ]);
      expect(appended[0]?.payload).toEqual({ model: "claude/sonnet", ultracode: false });
      expect(appended[1]?.payload).toEqual({ model: "claude/opus", effort: "high" });
    }),
  );
});
