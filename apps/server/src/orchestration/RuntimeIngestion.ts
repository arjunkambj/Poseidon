/**
 * Runtime events → orchestration events, and the per-session consumer.
 *
 * `translateRuntimeEvent` is pure except for the per-session `items` map it
 * carries: `content.delta` frames fold into the item they belong to, so the
 * log gets whole `item.upserted` snapshots instead of a delta stream.
 *
 * `ingestSession` is the reactor loop: it drains a session's (turn-scoped)
 * event stream into `append`, tags each appended event with the runtime event
 * that caused it, and reports the session's end on the lifecycle channel the
 * supervisor watches.
 */

import type { ConnectorInstanceId, ConnectorKind, ItemId, ThreadId } from "@poseidon/contracts/ids";
import { makeEventId, makeItemId } from "@poseidon/contracts/ids";
import type { ItemSnapshot, RuntimeEvent } from "@poseidon/contracts/runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { TurnScopedSessionHandle } from "@poseidon/connector-sdk/turnScopedHandle";

import type { PlannedEvent } from "../persistence/EventStore";

/** Per-session translator state — the item snapshots deltas fold into. */
export interface IngestState {
  readonly items: Map<string, ItemSnapshot>;
}

const makeIngestState = (): IngestState => ({ items: new Map() });

const base = (
  event: RuntimeEvent,
  ctx: { readonly threadId: ThreadId; readonly nextEventId: () => PlannedEvent["eventId"] },
): Pick<
  PlannedEvent,
  | "eventId"
  | "streamKind"
  | "streamId"
  | "occurredAt"
  | "causationEventId"
  | "correlationId"
  | "actor"
> => ({
  eventId: ctx.nextEventId(),
  streamKind: "thread",
  streamId: ctx.threadId,
  occurredAt: event.createdAt,
  causationEventId: event.eventId,
  correlationId: event.eventId,
  actor: "connector",
});

/**
 * One runtime event → the orchestration events it produces. `turnId` fields
 * come from the envelope — the turn-scoped handle has already stamped our
 * turnId there.
 */
const translateRuntimeEvent = (
  event: RuntimeEvent,
  ctx: {
    readonly threadId: ThreadId;
    readonly connectorInstanceId: ConnectorInstanceId;
    readonly connectorKind: ConnectorKind;
    readonly state: IngestState;
    readonly nextEventId?: () => PlannedEvent["eventId"];
  },
): ReadonlyArray<PlannedEvent> => {
  const identity = { threadId: ctx.threadId, nextEventId: ctx.nextEventId ?? makeEventId };
  const at = base(event, identity);
  /** A second envelope, for the rare translation that plans two events. */
  const alsoAt = () => base(event, identity);
  const turnId = event.turnId;

  switch (event.type) {
    case "session.started":
      return [
        {
          ...at,
          type: "thread.session.bound",
          payload: {
            connectorInstanceId: ctx.connectorInstanceId,
            connectorKind: ctx.connectorKind,
            sessionRef: event.payload.sessionRef,
            // What the harness can do goes onto the thread with its session:
            // the decider reads `steering` there to route a mid-turn message.
            capabilities: event.payload.capabilities,
          },
        },
      ];

    case "session.ended":
      // The supervisor reacts through the lifecycle channel; nothing to log.
      return [];

    case "session.warning":
      return [
        {
          ...at,
          type: "thread.error",
          payload: { message: event.payload.message, fatal: false },
        },
      ];

    case "turn.started":
      return turnId === undefined
        ? []
        : [
            {
              ...at,
              type: "thread.turn.started",
              payload: { turnId },
            },
          ];

    case "turn.completed":
      return turnId === undefined
        ? []
        : [
            {
              ...at,
              type: "thread.turn.completed",
              payload: { turnId, stopReason: event.payload.stopReason },
            },
          ];

    case "turn.plan.proposed":
      return [
        {
          ...at,
          type: "thread.plan.proposed",
          payload: {
            turnId: turnId ?? event.payload.turnId,
            planMarkdown: event.payload.planMarkdown,
            ...(event.payload.planPath === undefined ? {} : { planPath: event.payload.planPath }),
          },
        },
      ];

    case "item.started":
    case "item.updated":
    case "item.completed": {
      ctx.state.items.set(event.payload.item.itemId, event.payload.item);
      return [
        {
          ...at,
          type: "thread.item.upserted",
          payload: {
            item: event.payload.item,
            ...(turnId === undefined ? {} : { turnId }),
          },
        },
      ];
    }

    case "content.delta": {
      const itemId = event.payload.itemId as ItemId;
      const existing = ctx.state.items.get(itemId) ?? {
        itemId,
        kind: "assistant_message" as const,
        status: "in_progress" as const,
      };
      const merged: ItemSnapshot = {
        ...existing,
        text: `${existing.text ?? ""}${event.payload.delta}`,
      };
      ctx.state.items.set(itemId, merged);
      return [
        {
          ...at,
          type: "thread.item.upserted",
          payload: { item: merged, ...(turnId === undefined ? {} : { turnId }) },
        },
      ];
    }

    case "request.opened":
      return [
        {
          ...at,
          type: "thread.approval.opened",
          payload: { request: event.payload.request },
        },
      ];

    case "request.resolved":
      return [
        {
          ...at,
          type: "thread.approval.resolved",
          payload: {
            requestId: event.payload.requestId,
            decision: event.payload.decision,
          },
        },
      ];

    case "user-input.requested":
      return [
        {
          ...at,
          type: "thread.userInput.requested",
          payload: {
            requestId: event.payload.requestId,
            questions: event.payload.questions,
          },
        },
      ];

    case "user-input.resolved":
      return [
        {
          ...at,
          type: "thread.userInput.resolved",
          payload: { requestId: event.payload.requestId, answers: [] },
        },
      ];

    case "task.started":
    case "task.updated":
    case "task.completed": {
      // A task's lifecycle events update the row the connector already opened
      // for the Task/Agent call rather than replace it, so the call (its
      // `tool` input with the subagent's prompt, and any output) survives.
      const itemId = event.payload.taskId as ItemId;
      const item: ItemSnapshot = {
        ...ctx.state.items.get(itemId),
        itemId,
        kind: "task",
        status: event.payload.status,
        text: event.payload.title,
        ...(event.payload.parentItemId === undefined
          ? {}
          : { parentItemId: event.payload.parentItemId }),
      };
      ctx.state.items.set(item.itemId, item);
      return [
        {
          ...at,
          type: "thread.item.upserted",
          payload: { item, ...(turnId === undefined ? {} : { turnId }) },
        },
      ];
    }

    case "usage.updated":
      return [
        {
          ...at,
          type: "thread.usage.updated",
          payload: {
            turnId: turnId ?? event.payload.turnId,
            usage: {
              input: event.payload.input,
              output: event.payload.output,
              cacheRead: event.payload.cacheRead,
              cacheWrite: event.payload.cacheWrite,
              ...(event.payload.costUsd === undefined ? {} : { costUsd: event.payload.costUsd }),
            },
          },
        },
      ];

    case "context.updated":
      return [
        {
          ...at,
          type: "thread.context.updated",
          payload: { used: event.payload.used, limit: event.payload.limit },
        },
      ];

    case "model.changed":
      return [
        {
          ...at,
          type: "thread.settings.updated",
          payload: {
            model: event.payload.model,
            ...(event.payload.effort === undefined ? {} : { effort: event.payload.effort }),
            ...(event.payload.ultracode === undefined
              ? {}
              : { ultracode: event.payload.ultracode }),
          },
        },
      ];

    case "mcp.status.updated":
      // No read-model slot for MCP status yet; the browser layer owns the
      // surface it lands on.
      return [];

    case "runtime.error":
      // A fatal error is a row as well as a state change. `thread.error` moves
      // the thread's status and nothing else — no item, no text — so a turn
      // that died on a 400 from the provider, an exhausted account or a
      // crashed harness simply stopped, and the timeline said nothing at all
      // about why. `error` is one of the fifteen ItemKinds and the renderer
      // has a row for it; this is what fills it.
      return [
        {
          ...at,
          type: "thread.error",
          payload: { message: event.payload.message, fatal: event.payload.fatal },
        },
        ...(event.payload.fatal
          ? [
              {
                ...alsoAt(),
                type: "thread.item.upserted" as const,
                payload: {
                  item: {
                    itemId: makeItemId(),
                    kind: "error" as const,
                    status: "failed" as const,
                    text: event.payload.message,
                  } satisfies ItemSnapshot,
                },
              },
            ]
          : []),
      ];

    case "event.unmapped":
      // Unknown frames stay debuggability-only: the harness moved first, and
      // the raw frame lives in the connector's logs rather than the timeline.
      return [];
  }
};

/** What the session driver reports on the lifecycle channel. */
export type SessionLifecycle =
  | {
      readonly kind: "started";
      readonly threadId: ThreadId;
      readonly connectorInstanceId: ConnectorInstanceId;
    }
  | {
      readonly kind: "ended";
      readonly threadId: ThreadId;
      readonly connectorInstanceId: ConnectorInstanceId;
      readonly reason: "stopped" | "crashed" | "interrupted";
      readonly exitCode?: number;
    };

/**
 * How long one item's streamed text may be held back before it is written.
 *
 * Every `content.delta` used to become its own `thread.item.upserted` carrying
 * the *whole* accumulated snapshot, and every append rewrote the thread's whole
 * `doc_json`: an answer of N delta frames wrote O(N²) bytes of payload plus N
 * full-document rewrites whose cost grew with everything else in the thread.
 * The read side already coalesces on the same window (`LiveBuffer`), so holding
 * a delta this long costs the renderer nothing it was ever shown — and the next
 * frame supersedes the one held, because the snapshot is cumulative.
 */
const DELTA_WINDOW_MS = 50;

/** The item a `content.delta` belongs to, or `null` for anything else. */
const deltaItemIdOf = (event: RuntimeEvent): string | null =>
  event.type === "content.delta" ? (event.payload.itemId as string) : null;

/**
 * Drains one session's events into the log. Resolves when the stream ends;
 * reports `ended` on the lifecycle channel as it goes.
 *
 * Streamed text is coalesced on the way in (see `DELTA_WINDOW_MS`). Nothing
 * else is: a held delta is flushed before any other event of the session, so
 * the log's order is still the connector's order, and the last one is flushed
 * by the `item.completed` / `turn.completed` that always follows it.
 */
export const ingestSession = (
  handle: TurnScopedSessionHandle,
  ctx: {
    readonly threadId: ThreadId;
    readonly connectorInstanceId: ConnectorInstanceId;
    readonly connectorKind: ConnectorKind;
  },
  deps: {
    readonly nextEventId?: () => PlannedEvent["eventId"];
    readonly append: (
      threadId: ThreadId,
      events: ReadonlyArray<PlannedEvent>,
    ) => Effect.Effect<unknown, unknown>;
    readonly report: (lifecycle: SessionLifecycle) => Effect.Effect<unknown>;
    /** Tests pin this to 0 to get an append per delta, as before. */
    readonly deltaWindowMillis?: number;
  },
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const state = makeIngestState();
    const window = deps.deltaWindowMillis ?? DELTA_WINDOW_MS;
    const now = Effect.clockWith((clock) => clock.currentTimeMillis);

    /** The newest snapshot of one item, not yet written. */
    let held: { readonly itemId: string; readonly events: ReadonlyArray<PlannedEvent> } | null =
      null;
    let lastDeltaAppendAt: number | null = null;

    const flushHeld = Effect.suspend(() => {
      if (held === null) {
        return Effect.void;
      }
      const events = held.events;
      held = null;
      return Effect.asVoid(deps.append(ctx.threadId, events));
    });

    yield* Stream.runForEach(handle.events, (event) =>
      Effect.gen(function* () {
        if (event.type === "session.ended") {
          yield* deps.report({
            kind: "ended",
            threadId: ctx.threadId,
            connectorInstanceId: ctx.connectorInstanceId,
            reason: event.payload.reason,
            ...(event.payload.exitCode === undefined ? {} : { exitCode: event.payload.exitCode }),
          });
        }
        const planned = translateRuntimeEvent(event, {
          ...ctx,
          state,
          nextEventId: deps.nextEventId,
        });
        const deltaItemId = deltaItemIdOf(event);
        // A held delta of another item — or anything that is not a delta at
        // all — has to reach the log first, or the stream's order changes.
        if (held !== null && held.itemId !== deltaItemId) {
          yield* flushHeld;
        }
        if (planned.length === 0) {
          return;
        }
        if (deltaItemId === null) {
          yield* deps.append(ctx.threadId, planned);
          return;
        }
        const at = yield* now;
        if (lastDeltaAppendAt === null || at - lastDeltaAppendAt >= window) {
          held = null;
          lastDeltaAppendAt = at;
          yield* deps.append(ctx.threadId, planned);
          return;
        }
        // Inside the window: hold the newest snapshot, which already contains
        // every character the one it replaces did.
        held = { itemId: deltaItemId, events: planned };
      }),
    ).pipe(Effect.ensuring(Effect.ignore(flushHeld)));
  });
