/**
 * The fixture pages' client (`/dev/composer`, `/dev/timeline`): a `Connection` layer over an in-process fake
 * whose `orchestration.dispatch` runs a tiny decider — `approval.respond`
 * emits `approval.resolved`, `turn.start` emits `message.queued` or
 * `turn.requested`, the user's `item.upserted` row and `turn.started`, and so
 * on — so the cards, the queue strip and the sent bubbles exercise the real
 * round trip: the UI changes only when the event lands on the subscription,
 * never optimistically.
 *
 * `fixture.emit(type, payload)` folds the event into the fixture's doc and
 * pushes it onto the stream, which is how the page's scenario buttons drive
 * states the server would normally produce (a mid-turn approval, a plan, a
 * question). `fixture.onCommand` is the page's dispatch log.
 * `fixture.setSteering` flips the connector's `steering` capability and
 * rebinds the fixture session with it, as the server copies capabilities onto
 * `thread.session.bound`, so the composer's steer state can be seen; the page
 * refreshes `connectors.list`. `fixture.load` swaps in a whole document — the
 * timeline fixture's scenarios — as a server resnapshot would.
 *
 * Checkpoints behave as the server's do, without git: a completed turn
 * records one (`thread.checkpoint.created`), `checkpoints.list` answers the
 * document's list, and an accepted `thread.checkpoint.restore` is followed a
 * moment later by `thread.checkpoint.restored`, so the timeline's restore
 * controls go through their blocked and settled states.
 *
 * The other RPC answers — files, models, skills, plugins, attachments,
 * keybindings — live in `fixture-rpc.ts`; this module lends it the thread
 * stream and the decider.
 */

import { applyThreadStreamItem } from "@poseidon/client-runtime/clientState";
import type { ConnectionLayer } from "@poseidon/client-runtime/atoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
} from "@poseidon/client-runtime/connection";
import type {
  Command,
  CommandReceipt,
  OrchestrationEvent,
  OrchestrationEventType,
  ThreadDetailSnapshot,
  ThreadStreamItem,
} from "@poseidon/contracts/orchestration";
import {
  makeConnectorInstanceId,
  makeEventId,
  makeItemId,
  makeProjectId,
  makeThreadId,
  makeCheckpointId,
  makeTurnId,
} from "@poseidon/contracts/ids";
import type { ConnectorInstanceId, ProjectId, ThreadId, TurnId } from "@poseidon/contracts/ids";
import type { ConnectorSummary } from "@poseidon/contracts/connectors";
import type { ConnectorCapabilities } from "@poseidon/contracts/runtime";
import { uuidV7 } from "@poseidon/shared/ids";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { FIXTURE_NOW as NOW, makeFixtureRpc } from "@/lib/fixture-rpc";

type EventPayload<T extends OrchestrationEventType> = Extract<
  OrchestrationEvent,
  { type: T }
>["payload"];

/** How long the fixture's "git work" takes between a restore's request and its outcome. */
const RESTORE_PAUSE_MS = 1_500;

const baseDoc = (
  threadId: ThreadId,
  projectId: ProjectId,
  connectorInstanceId: ConnectorInstanceId,
): ThreadDetailSnapshot => ({
  threadId,
  projectId,
  title: "fixture thread",
  status: "idle",
  settings: {
    model: "fixture/mid",
    effort: "medium",
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
  },
  snapshotSequence: 0,
  items: [
    {
      itemId: makeItemId(),
      kind: "user_message",
      status: "completed",
      text: "Sketch the composer fixture states.",
    },
    {
      itemId: makeItemId(),
      kind: "assistant_message",
      status: "completed",
      text: "Working through them — every card and trigger lives below.",
    },
  ],
  queue: [],
  checkpoints: [],
  session: {
    connectorInstanceId,
    connectorKind: "fixture",
    sessionRef: { ref: "fixture" },
  },
  currentTurnId: null,
  pendingApproval: null,
  pendingUserInput: null,
  pendingPlan: null,
  usage: null,
  context: { used: 42000, limit: 200000 },
  createdAt: NOW,
  updatedAt: NOW,
});

/** The command fields the `thread.settings.update` event payload carries. */
const settingsPatch = (command: Extract<Command, { type: "thread.settings.update" }>) =>
  Object.fromEntries(
    [
      ["model", command.model],
      ["effort", command.effort],
      ["runtimeMode", command.runtimeMode],
      ["interactionMode", command.interactionMode],
      ["connectorInstanceId", command.connectorInstanceId],
    ].filter(([, value]) => value !== undefined),
  );

export interface FixtureClient {
  readonly layer: ConnectionLayer;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** Emit an orchestration event: folds the fixture doc and pushes it to subscribers. */
  readonly emit: <T extends OrchestrationEventType>(type: T, payload: EventPayload<T>) => void;
  /** Push a non-event stream frame (`resnapshot-required`, a fresh snapshot). */
  readonly emitItem: (item: ThreadStreamItem) => void;
  /** Start a running turn, or return the running one's id. */
  readonly startTurn: () => TurnId;
  /** Settle the running turn: drain the queue, then `turn.completed`. */
  readonly completeTurn: () => void;
  /** The fixture's current doc — scenario buttons read pending fields from it. */
  readonly doc: () => ThreadDetailSnapshot;
  /** Whether the fixture connector reports that it can steer a running turn. */
  readonly steering: () => boolean;
  /**
   * Flip the steering capability: `connectors.list` answers the new value and
   * the session rebinds with it, since the composer steers by the session's.
   */
  readonly setSteering: (on: boolean) => void;
  /** Restore the base document and resnapshot. */
  readonly reset: () => void;
  /**
   * Replace the document with `snapshot` — restamped with the fixture's own
   * thread, project and session so every RPC keyed by them still answers —
   * and resnapshot. The timeline fixture loads its scenarios this way.
   */
  readonly load: (snapshot: ThreadDetailSnapshot) => void;
  /** Called after every dispatch — the page renders this as the command log. */
  onCommand: ((command: Command, receipt: CommandReceipt) => void) | undefined;
}

export const makeFixtureClient = (): FixtureClient => {
  const threadId = makeThreadId();
  const projectId = makeProjectId();
  const connectorInstanceId = makeConnectorInstanceId();
  const secondInstanceId = makeConnectorInstanceId();
  const serverInstanceId = uuidV7();

  const queue = Effect.runSync(Queue.unbounded<ThreadStreamItem>());
  let doc = baseDoc(threadId, projectId, connectorInstanceId);
  let streamVersion = 0;
  let steering = false;
  let handle: FixtureClient;

  const offer = (item: ThreadStreamItem) => Effect.runSync(Queue.offer(queue, item));

  /** Build, fold and publish one event. */
  const next = <T extends OrchestrationEventType>(
    type: T,
    payload: EventPayload<T>,
    commandId?: Command["commandId"],
  ): void => {
    const event = {
      sequence: doc.snapshotSequence + 1,
      eventId: makeEventId(),
      streamKind: "thread" as const,
      streamId: threadId,
      streamVersion: ++streamVersion,
      occurredAt: new Date().toISOString(),
      // As on the server: the decider's events answer a command and carry
      // the user as actor; everything else arrives from the connector.
      actor: commandId === undefined ? ("connector" as const) : ("user" as const),
      ...(commandId === undefined ? {} : { commandId }),
      type,
      payload,
    } as OrchestrationEvent;
    doc = applyThreadStreamItem(doc, { kind: "event", event }) ?? doc;
    offer({ kind: "event", event });
  };

  const startTurn = (): TurnId => {
    const existing = doc.currentTurnId;
    if (existing !== null) {
      return existing;
    }
    const turnId = makeTurnId();
    next("thread.turn.requested", {
      turnId,
      text: "fixture turn",
      attachments: [],
      mentions: [],
    });
    next("thread.turn.started", { turnId });
    return turnId;
  };

  const completeTurn = (): void => {
    const turnId = doc.currentTurnId;
    if (turnId === null) {
      return;
    }
    for (const message of doc.queue) {
      next("thread.message.dequeued", { queuedMessageId: message.queuedMessageId, turnId });
    }
    next("thread.turn.completed", { turnId, stopReason: "end_turn" });
    // As the checkpoint reactor does off `turn.completed`.
    next("thread.checkpoint.created", {
      checkpoint: {
        checkpointId: makeCheckpointId(),
        turnId,
        ref: `refs/poseidon/checkpoints/${threadId}/${turnId}`,
        createdAt: new Date().toISOString(),
      },
    });
  };

  /**
   * The smallest honest decider for the commands the composer and cards send:
   * accept → the events a real engine would emit, reject → a reason string.
   */
  const decide = (command: Command): { events: () => void; reason?: string } => {
    switch (command.type) {
      case "thread.turn.start": {
        if (command.queued || doc.currentTurnId !== null) {
          return {
            events: () =>
              next("thread.message.queued", {
                message: {
                  queuedMessageId: makeItemId(),
                  text: command.text,
                  attachments: command.attachments,
                  mentions: command.mentions,
                  ...(command.references === undefined ? {} : { references: command.references }),
                  queuedAt: new Date().toISOString(),
                },
              }),
          };
        }
        return {
          events: () => {
            const turnId = makeTurnId();
            next("thread.turn.requested", {
              turnId,
              text: command.text,
              attachments: command.attachments,
              mentions: command.mentions,
              ...(command.references === undefined ? {} : { references: command.references }),
            });
            // The user's own row, minted beside the request as the server's
            // decider does, so the page can show the sent bubble.
            next("thread.item.upserted", {
              turnId,
              item: {
                itemId: makeItemId(),
                kind: "user_message",
                status: "completed",
                turnId,
                text: command.text,
                ...(command.attachments.length === 0 ? {} : { attachments: command.attachments }),
                ...(command.references === undefined ? {} : { references: command.references }),
              },
            });
            next("thread.turn.started", { turnId });
          },
        };
      }
      // As the server's decider: an idle steer starts a turn, a harness that
      // cannot steer is refused, and a steered message joins the running turn
      // as a user row stamped with it.
      case "thread.turn.steer": {
        const turnId = doc.currentTurnId;
        if (turnId === null) {
          return {
            events: () => {
              const started = makeTurnId();
              next("thread.turn.requested", {
                turnId: started,
                text: command.text,
                attachments: command.attachments,
                mentions: command.mentions,
              });
              next("thread.turn.started", { turnId: started });
            },
          };
        }
        if (!steering) {
          return {
            events: () => {},
            reason: "this thread's harness cannot take a message mid-turn; queue it instead",
          };
        }
        return {
          events: () => {
            const { text, attachments, mentions } = command;
            next("thread.turn.steered", { turnId, text, attachments, mentions }, command.commandId);
            next(
              "thread.item.upserted",
              {
                turnId,
                item: {
                  itemId: makeItemId(),
                  kind: "user_message",
                  status: "completed",
                  turnId,
                  text,
                },
              },
              command.commandId,
            );
          },
        };
      }
      case "thread.turn.interrupt": {
        const turnId = doc.currentTurnId;
        return turnId === null
          ? { events: () => {}, reason: "no turn is running" }
          : { events: () => next("thread.turn.interrupted", { turnId }) };
      }
      case "thread.approval.respond": {
        const pending = doc.pendingApproval;
        return pending === null || pending.requestId !== command.requestId
          ? { events: () => {}, reason: "no matching approval request" }
          : {
              events: () =>
                next(
                  "thread.approval.resolved",
                  {
                    requestId: command.requestId,
                    decision: command.decision,
                    ...(command.pattern === undefined ? {} : { pattern: command.pattern }),
                  },
                  command.commandId,
                ),
            };
      }
      case "thread.userInput.respond": {
        const pending = doc.pendingUserInput;
        return pending === null || pending.requestId !== command.requestId
          ? { events: () => {}, reason: "no matching question request" }
          : {
              events: () =>
                next(
                  "thread.userInput.resolved",
                  {
                    requestId: command.requestId,
                    answers: command.answers,
                  },
                  command.commandId,
                ),
            };
      }
      case "thread.plan.respond": {
        const pending = doc.pendingPlan;
        return pending === null || pending.turnId !== command.turnId
          ? { events: () => {}, reason: "no pending plan" }
          : {
              events: () =>
                next(
                  "thread.plan.responded",
                  {
                    turnId: command.turnId,
                    action: command.action,
                    ...(command.feedback === undefined ? {} : { feedback: command.feedback }),
                  },
                  command.commandId,
                ),
            };
      }
      case "thread.queue.remove": {
        return doc.queue.some((message) => message.queuedMessageId === command.queuedMessageId)
          ? {
              events: () =>
                next("thread.message.dequeued", { queuedMessageId: command.queuedMessageId }),
            }
          : { events: () => {}, reason: "no such queued message" };
      }
      case "thread.queue.reorder": {
        const from = doc.queue.findIndex(
          (message) => message.queuedMessageId === command.queuedMessageId,
        );
        if (from === -1 || command.toIndex >= doc.queue.length) {
          return { events: () => {}, reason: "no such queue position" };
        }
        const order = doc.queue.map((message) => message.queuedMessageId);
        order.splice(from, 1);
        order.splice(command.toIndex, 0, command.queuedMessageId);
        return { events: () => next("thread.queue.reordered", { order }) };
      }
      // As the server's decider: never during a turn or another restore, and
      // only a checkpoint the thread recorded. The git work is a pause here.
      case "thread.checkpoint.restore": {
        const checkpoint = doc.checkpoints.find(
          (entry) => entry.checkpointId === command.checkpointId,
        );
        if (doc.currentTurnId !== null || doc.status === "running") {
          return { events: () => {}, reason: "the thread has a running turn" };
        }
        if ((doc.restoring ?? null) !== null) {
          return { events: () => {}, reason: "the thread is already restoring a checkpoint" };
        }
        if (checkpoint === undefined) {
          return { events: () => {}, reason: `no checkpoint ${command.checkpointId}` };
        }
        return {
          events: () => {
            next("thread.checkpoint.restore.requested", { checkpoint }, command.commandId);
            setTimeout(() => next("thread.checkpoint.restored", { checkpoint }), RESTORE_PAUSE_MS);
          },
        };
      }
      case "thread.settings.update": {
        return {
          events: () => next("thread.settings.updated", settingsPatch(command)),
        };
      }
      case "thread.done.mark":
        return { events: () => next("thread.done.marked", {}, command.commandId) };
      case "thread.done.clear":
        return { events: () => next("thread.done.cleared", {}, command.commandId) };
      default:
        return { events: () => {}, reason: `fixture does not handle ${command.type}` };
    }
  };

  /** What the fixture connector says it can do; `steering` follows the toggle. */
  const capabilities = (): ConnectorCapabilities => ({
    modelSwitch: "per-turn",
    effortSwitch: "per-turn",
    steering,
    planMode: true,
    subagents: true,
    images: true,
    resume: true,
    fork: false,
    interrupt: "turn",
    rollback: false,
    compaction: false,
    questions: true,
    runtimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    attachments: "files",
  });

  const connector = (): ConnectorSummary => ({
    connectorInstanceId,
    kind: "fixture",
    displayName: "Fixture connector",
    enabled: true,
    capabilities: capabilities(),
    extensions: { skills: true, plugins: true, mcpServers: false },
    probe: { status: "ready", probedAt: NOW },
  });

  /** Rebind the session with the connector's current capabilities. */
  const bindSession = (): void =>
    next("thread.session.bound", {
      connectorInstanceId,
      connectorKind: "fixture",
      sessionRef: { ref: "fixture" },
      capabilities: capabilities(),
    });

  /**
   * A second instance of the same kind, so the model picker has two sections.
   * The fixture thread is bound to the first, so this one shows disabled.
   */
  const secondConnector = (): ConnectorSummary => ({
    ...connector(),
    connectorInstanceId: secondInstanceId,
    displayName: "Second fixture connector",
    extensions: { skills: false, plugins: false, mcpServers: false },
  });

  /** The dispatch RPC: decide, emit, then report the receipt to the page's log. */
  const dispatch = (command: Command): CommandReceipt => {
    const outcome = decide(command);
    outcome.events();
    const receipt: CommandReceipt = {
      commandId: command.commandId,
      status: outcome.reason === undefined ? "accepted" : "rejected",
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      lastSequence: doc.snapshotSequence,
    };
    handle.onCommand?.(command, receipt);
    return receipt;
  };

  const client = makeFixtureRpc({
    serverInstanceId,
    projectId,
    connectorInstanceId,
    subscribe: () =>
      Stream.suspend(() =>
        Stream.concat(
          Stream.succeed({ kind: "snapshot" as const, snapshot: doc }),
          Stream.fromQueue(queue),
        ),
      ),
    dispatch,
    connectors: () => [connector(), secondConnector()],
    checkpoints: () => doc.checkpoints,
  });

  /** Swap the whole document, as a resnapshot from the server would. */
  const replace = (next: ThreadDetailSnapshot, reason: string): void => {
    doc = next;
    streamVersion = 0;
    offer({ kind: "resnapshot-required", reason });
    offer({ kind: "snapshot", snapshot: doc });
    bindSession();
  };

  const state = Effect.runSync(
    SubscriptionRef.make<ConnectionState>({ status: "connected", serverInstanceId }),
  );

  handle = {
    layer: Layer.mergeAll(
      Layer.succeed(Connection, { client: Effect.succeed(client), state }),
      Layer.succeed(ConnectionStateRef, state),
    ),
    threadId,
    projectId,
    emit: (type, payload) => next(type, payload),
    emitItem: offer,
    startTurn,
    completeTurn,
    doc: () => doc,
    steering: () => steering,
    setSteering: (on) => {
      steering = on;
      bindSession();
    },
    reset: () => replace(baseDoc(threadId, projectId, connectorInstanceId), "fixture reset"),
    load: (snapshot) =>
      replace(
        {
          ...snapshot,
          threadId,
          projectId,
          session: baseDoc(threadId, projectId, connectorInstanceId).session,
        },
        "fixture scenario",
      ),
    onCommand: undefined,
  };
  return handle;
};
