/**
 * The client → server command set and the event log it produces.
 *
 * The server is an event-sourced decider: a client never mutates state, it
 * dispatches a `Command` and gets a `CommandReceipt` back. The decider turns
 * the command into zero or more `OrchestrationEvent`s, which are appended,
 * projected and published. Every id a command needs is minted by the caller, so
 * dispatching twice with the same `commandId` is a no-op rather than a second
 * thread — that is what makes reconnects and retries safe.
 *
 * `ThreadStreamItem` is what a subscriber actually sees: one snapshot, then
 * events, with `synchronized` marking the point where live delivery begins and
 * `resnapshot-required` telling the client its position is no longer replayable.
 */

import * as Schema from "effect/Schema";

import { IsoDateTime, NonEmptyString, NonNegativeInt } from "./base";
import { ApprovalDecision } from "./enums";
import { ThreadWorktree } from "./git";
import {
  CheckpointId,
  CommandId,
  EventId,
  ItemId,
  ProjectId,
  RequestId,
  ThreadId,
  TurnId,
  UuidV7,
} from "./ids";
import {
  ApprovalRequest,
  Attachment,
  ItemSnapshot,
  TurnReference,
  TurnStopReason,
  UserQuestion,
  UserQuestionAnswer,
} from "./runtime";
import {
  CheckpointSummary,
  ContextWindowUsage,
  Mention,
  PlanResponseAction,
  QueuedMessage,
  ThreadFork,
  ThreadForkRequest,
  ThreadImport,
  ThreadSession,
  ThreadSettings,
  ThreadSettingsPatch,
  TurnResend,
  TurnUsage,
} from "./thread";
import { ThreadDetailSnapshot, ThreadSummary } from "./readModels";

/**
 * A file the user attached to a turn, and a skill or plugin they referenced.
 * Defined beside the runtime events because the `user_message` row carries
 * them as the command does; re-exported here because the commands are where
 * a reader looks for them.
 */
export { Attachment, TurnReference } from "./runtime";

// The value objects live in `./thread`; this module is still where they are
// imported from.
export {
  CheckpointRestore,
  CheckpointSummary,
  ContextWindowUsage,
  ForkedFrom,
  ForkSession,
  latestTurnId,
  Mention,
  PlanResponseAction,
  QueuedMessage,
  ThreadActivity,
  ThreadFork,
  ThreadImport,
  ThreadSession,
  ThreadSettings,
  ThreadSettingsPatch,
  ThreadStatus,
  threadLocksConnector,
  TurnResend,
  TurnUsage,
} from "./thread";

// ── Commands ───────────────────────────────────────────────────

const commandBase = {
  commandId: CommandId,
  createdAt: IsoDateTime,
};

/** Builds one command variant: the shared base, a literal `type`, and its fields. */
const command = <const Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields,
) => Schema.Struct({ ...commandBase, type: Schema.Literal(type), ...fields });

const ProjectCreateCommand = command("project.create", {
  projectId: ProjectId,
  name: NonEmptyString,
  workspaceRoot: NonEmptyString,
});

const ProjectRemoveCommand = command("project.remove", { projectId: ProjectId });

const ThreadCreateCommand = command("thread.create", {
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.optional(NonEmptyString),
  settings: Schema.optional(ThreadSettingsPatch),
  /** Absent: a local thread on the project's root. Fixed once created. */
  worktree: Schema.optional(ThreadWorktree),
  /** Fork another thread of the project: title and settings default to its. */
  fork: Schema.optional(ThreadForkRequest),
  /** A session the harness recorded on its own, brought in by `sessions.import`. */
  imported: Schema.optional(ThreadImport),
});

const ThreadRenameCommand = command("thread.rename", {
  threadId: ThreadId,
  title: NonEmptyString,
});

const ThreadArchiveCommand = command("thread.archive", { threadId: ThreadId });

const ThreadUnarchiveCommand = command("thread.unarchive", { threadId: ThreadId });

const ThreadDeleteCommand = command("thread.delete", { threadId: ThreadId });

/** Move a thread to the sidebar's Done section, or take it back out. */
const ThreadDoneMarkCommand = command("thread.done.mark", { threadId: ThreadId });

const ThreadDoneClearCommand = command("thread.done.clear", { threadId: ThreadId });

/**
 * Start a turn, or queue it. `queued` is the composer's `composer.queue` key
 * (Mod+Enter): with a turn already running the text goes on the queue instead
 * of racing the session. The queue is for harnesses that cannot steer — print-mode ones take no
 * mid-turn message; one that can is sent `thread.turn.steer` instead.
 */
const ThreadTurnStartCommand = command("thread.turn.start", {
  threadId: ThreadId,
  text: Schema.String,
  attachments: Schema.Array(Attachment),
  mentions: Schema.Array(Mention),
  references: Schema.optional(Schema.Array(TurnReference)),
  queued: Schema.Boolean,
});

/**
 * Deliver a message into the running turn, for a thread whose harness can
 * steer (`capabilities.steering` on its bound session). With no turn running
 * it starts one, so a turn that ended while the user typed loses nothing; a
 * turn that is stopping, or whose session has not said whether it steers,
 * queues it; a harness that says it cannot steer is refused.
 */
const ThreadTurnSteerCommand = command("thread.turn.steer", {
  threadId: ThreadId,
  text: Schema.String,
  attachments: Schema.Array(Attachment),
  mentions: Schema.Array(Mention),
  references: Schema.optional(Schema.Array(TurnReference)),
});

const ThreadTurnInterruptCommand = command("thread.turn.interrupt", { threadId: ThreadId });

/**
 * Stop one subagent — the running turn's task row `itemId` — and leave the
 * turn going. Only for a session whose `capabilities.stopTask` is true.
 */
const ThreadTaskStopCommand = command("thread.task.stop", { threadId: ThreadId, itemId: ItemId });

const ThreadSettingsUpdateCommand = Schema.Struct({
  ...commandBase,
  type: Schema.Literal("thread.settings.update"),
  threadId: ThreadId,
  ...ThreadSettingsPatch.fields,
});

/**
 * Answer an approval card. `pattern` carries the rule "allow always" should
 * persist — the card lets the user edit the suggestion before accepting it, so
 * the client sends the final text rather than the server re-deriving it.
 */
const ThreadApprovalRespondCommand = command("thread.approval.respond", {
  threadId: ThreadId,
  requestId: RequestId,
  decision: ApprovalDecision,
  pattern: Schema.optional(NonEmptyString),
});

const ThreadUserInputRespondCommand = command("thread.userInput.respond", {
  threadId: ThreadId,
  requestId: RequestId,
  answers: Schema.Array(UserQuestionAnswer),
});

const ThreadPlanRespondCommand = command("thread.plan.respond", {
  threadId: ThreadId,
  turnId: TurnId,
  action: PlanResponseAction,
  feedback: Schema.optional(Schema.String),
});

/**
 * Take a queued follow-up back out of the queue. Emits
 * `thread.message.dequeued`, the same event the reactor emits when the next
 * turn consumes one, so the read model needs nothing new.
 */
const ThreadQueueRemoveCommand = command("thread.queue.remove", {
  threadId: ThreadId,
  queuedMessageId: ItemId,
});

/**
 * Move a queued follow-up to another position. `toIndex` is where the message
 * ends up once it has been lifted out, so moving the second message to 0 makes
 * it the next one sent. The decider answers with the whole new order rather
 * than the move, so a projector never has to replay arithmetic.
 */
const ThreadQueueReorderCommand = command("thread.queue.reorder", {
  threadId: ThreadId,
  queuedMessageId: ItemId,
  toIndex: NonNegativeInt,
});

const ThreadCheckpointRestoreCommand = command("thread.checkpoint.restore", {
  threadId: ThreadId,
  checkpointId: CheckpointId,
  resend: Schema.optional(TurnResend),
});

export const Command = Schema.Union([
  ProjectCreateCommand,
  ProjectRemoveCommand,
  ThreadCreateCommand,
  ThreadRenameCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadDeleteCommand,
  ThreadTurnStartCommand,
  ThreadTurnSteerCommand,
  ThreadTurnInterruptCommand,
  ThreadTaskStopCommand,
  ThreadSettingsUpdateCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadPlanRespondCommand,
  ThreadQueueRemoveCommand,
  ThreadQueueReorderCommand,
  ThreadCheckpointRestoreCommand,
  ThreadDoneMarkCommand,
  ThreadDoneClearCommand,
]);
export type Command = typeof Command.Type;

/**
 * The type tags of `Command`, as data. A test keeps this list and the union's
 * members in lockstep.
 */
export const CommandType = Schema.Literals([
  "project.create",
  "project.remove",
  "thread.create",
  "thread.rename",
  "thread.archive",
  "thread.unarchive",
  "thread.delete",
  "thread.turn.start",
  "thread.turn.steer",
  "thread.turn.interrupt",
  "thread.task.stop",
  "thread.settings.update",
  "thread.approval.respond",
  "thread.userInput.respond",
  "thread.plan.respond",
  "thread.queue.remove",
  "thread.queue.reorder",
  "thread.checkpoint.restore",
  "thread.done.mark",
  "thread.done.clear",
]);
export type CommandType = typeof CommandType.Type;

/** The `type` tag of each command, in declaration order. */
export const commandTypes: ReadonlyArray<CommandType> = Command.members.map(
  (member) => member.fields.type.literal,
);

/**
 * The answer to a dispatch. `lastSequence` is the event-log position the
 * command's effects are visible at, so a client can wait for its own write to
 * appear on the subscription before acting on it.
 */
export const CommandReceipt = Schema.Struct({
  commandId: CommandId,
  status: Schema.Literals(["accepted", "rejected"]),
  reason: Schema.optional(NonEmptyString),
  lastSequence: NonNegativeInt,
});
export type CommandReceipt = typeof CommandReceipt.Type;

// ── Events ─────────────────────────────────────────────────────

/** Which aggregate an event belongs to. */
export const StreamKind = Schema.Literals(["project", "thread"]);
export type StreamKind = typeof StreamKind.Type;

/** Who caused an event: a person, the server itself, or a connector's output. */
export const Actor = Schema.Literals(["user", "system", "connector"]);
export type Actor = typeof Actor.Type;

/**
 * The fields every event carries. `sequence` is the global append order the
 * subscription pages on; `streamVersion` is the per-aggregate version the
 * optimistic-concurrency check uses. `causationEventId` and `correlationId`
 * make a reactor's downstream events traceable back to the command that caused
 * them.
 */
const eventBase = {
  sequence: NonNegativeInt,
  eventId: EventId,
  streamKind: StreamKind,
  streamId: UuidV7,
  streamVersion: NonNegativeInt,
  occurredAt: IsoDateTime,
  commandId: Schema.optional(CommandId),
  causationEventId: Schema.optional(EventId),
  correlationId: Schema.optional(UuidV7),
  actor: Actor,
};

/** Builds one event variant: the shared base, a literal `type`, and its payload. */
const orchestrationEvent = <
  const Type extends string,
  Payload extends Schema.Struct<Schema.Struct.Fields>,
>(
  type: Type,
  payload: Payload,
) => Schema.Struct({ ...eventBase, type: Schema.Literal(type), payload });

const ProjectCreatedEvent = orchestrationEvent(
  "project.created",
  Schema.Struct({
    projectId: ProjectId,
    name: NonEmptyString,
    workspaceRoot: NonEmptyString,
  }),
);

const ProjectRemovedEvent = orchestrationEvent(
  "project.removed",
  Schema.Struct({ projectId: ProjectId }),
);

const ThreadCreatedEvent = orchestrationEvent(
  "thread.created",
  Schema.Struct({
    threadId: ThreadId,
    projectId: ProjectId,
    title: NonEmptyString,
    settings: ThreadSettings,
    // Optional: every event written before threads had worktrees lacks it.
    worktree: Schema.optional(ThreadWorktree),
    fork: Schema.optional(ThreadFork),
    // Optional: only an imported thread has it, and older events lack it.
    imported: Schema.optional(ThreadImport),
  }),
);

const ThreadRenamedEvent = orchestrationEvent(
  "thread.renamed",
  Schema.Struct({ title: NonEmptyString }),
);

const ThreadArchivedEvent = orchestrationEvent("thread.archived", Schema.Struct({}));

const ThreadUnarchivedEvent = orchestrationEvent("thread.unarchived", Schema.Struct({}));

const ThreadDeletedEvent = orchestrationEvent("thread.deleted", Schema.Struct({}));

/**
 * The session a thread now runs on, exactly as `ThreadSession` stores it —
 * `capabilities` included when the connector announced them, which every
 * session bound before the field existed did not.
 */
const ThreadSessionBoundEvent = orchestrationEvent("thread.session.bound", ThreadSession);

const ThreadSessionLostEvent = orchestrationEvent(
  "thread.session.lost",
  Schema.Struct({ reason: NonEmptyString }),
);

const ThreadTurnRequestedEvent = orchestrationEvent(
  "thread.turn.requested",
  Schema.Struct({
    turnId: TurnId,
    text: Schema.String,
    attachments: Schema.Array(Attachment),
    mentions: Schema.Array(Mention),
    references: Schema.optional(Schema.Array(TurnReference)),
  }),
);

const ThreadTurnStartedEvent = orchestrationEvent(
  "thread.turn.started",
  Schema.Struct({ turnId: TurnId }),
);

const ThreadTurnCompletedEvent = orchestrationEvent(
  "thread.turn.completed",
  Schema.Struct({ turnId: TurnId, stopReason: TurnStopReason }),
);

/**
 * A message delivered into `turnId` while it runs. The turn keeps its
 * boundary — no new turn starts — and the user's row follows once the message
 * is delivered, as a `thread.item.upserted` stamped with the same turn.
 */
const ThreadTurnSteeredEvent = orchestrationEvent(
  "thread.turn.steered",
  Schema.Struct({
    turnId: TurnId,
    text: Schema.String,
    attachments: Schema.Array(Attachment),
    mentions: Schema.Array(Mention),
    references: Schema.optional(Schema.Array(TurnReference)),
  }),
);

const ThreadTurnInterruptedEvent = orchestrationEvent(
  "thread.turn.interrupted",
  Schema.Struct({ turnId: TurnId }),
);

/** A request to stop task row `itemId`; the harness settles the row itself. */
const ThreadTaskStopRequestedEvent = orchestrationEvent(
  "thread.task.stopRequested",
  Schema.Struct({ itemId: ItemId }),
);

const ThreadMessageQueuedEvent = orchestrationEvent(
  "thread.message.queued",
  Schema.Struct({ message: QueuedMessage }),
);

const ThreadMessageDequeuedEvent = orchestrationEvent(
  "thread.message.dequeued",
  Schema.Struct({ queuedMessageId: ItemId, turnId: Schema.optional(TurnId) }),
);

/**
 * The queue's new order, as the full list of `queuedMessageId`s. Carrying the
 * result rather than the move keeps the projection a lookup: an id the doc no
 * longer holds is skipped, and anything the order does not mention keeps its
 * place behind what it does.
 */
const ThreadQueueReorderedEvent = orchestrationEvent(
  "thread.queue.reordered",
  Schema.Struct({ order: Schema.Array(ItemId) }),
);

const ThreadItemUpsertedEvent = orchestrationEvent(
  "thread.item.upserted",
  Schema.Struct({ item: ItemSnapshot, turnId: Schema.optional(TurnId) }),
);

const ThreadApprovalOpenedEvent = orchestrationEvent(
  "thread.approval.opened",
  Schema.Struct({ request: ApprovalRequest }),
);

const ThreadApprovalResolvedEvent = orchestrationEvent(
  "thread.approval.resolved",
  Schema.Struct({
    requestId: RequestId,
    decision: ApprovalDecision,
    pattern: Schema.optional(NonEmptyString),
  }),
);

const ThreadUserInputRequestedEvent = orchestrationEvent(
  "thread.userInput.requested",
  Schema.Struct({ requestId: RequestId, questions: Schema.Array(UserQuestion) }),
);

const ThreadUserInputResolvedEvent = orchestrationEvent(
  "thread.userInput.resolved",
  Schema.Struct({ requestId: RequestId, answers: Schema.Array(UserQuestionAnswer) }),
);

const ThreadPlanProposedEvent = orchestrationEvent(
  "thread.plan.proposed",
  Schema.Struct({
    turnId: TurnId,
    planMarkdown: Schema.String,
    planPath: Schema.optional(NonEmptyString),
  }),
);

/**
 * `planPath` is the plan file the answer is about, copied from the pending
 * plan as it is answered. The accept turn names the file ("Implement the
 * approved plan at <path>"), and by the time a reactor sees this event the
 * fold has already cleared `pendingPlan` — carrying it on the event is what
 * lets that turn survive a restart between proposing a plan and accepting it.
 */
const ThreadPlanRespondedEvent = orchestrationEvent(
  "thread.plan.responded",
  Schema.Struct({
    turnId: TurnId,
    action: PlanResponseAction,
    feedback: Schema.optional(Schema.String),
    planPath: Schema.optional(NonEmptyString),
  }),
);

const ThreadSettingsUpdatedEvent = orchestrationEvent(
  "thread.settings.updated",
  ThreadSettingsPatch,
);

const ThreadUsageUpdatedEvent = orchestrationEvent(
  "thread.usage.updated",
  Schema.Struct({ turnId: TurnId, usage: TurnUsage }),
);

const ThreadContextUpdatedEvent = orchestrationEvent("thread.context.updated", ContextWindowUsage);

const ThreadCheckpointCreatedEvent = orchestrationEvent(
  "thread.checkpoint.created",
  Schema.Struct({ checkpoint: CheckpointSummary }),
);

/**
 * The durable work order: an accepted `thread.checkpoint.restore`, recorded
 * before any git runs. The CheckpointReactor acts on this event, and replays
 * any that has no `restored`/`restore.failed` successor at boot, so a crash
 * between command receipt and the git work cannot silently drop the request.
 */
const ThreadCheckpointRestoreRequestedEvent = orchestrationEvent(
  "thread.checkpoint.restore.requested",
  Schema.Struct({ checkpoint: CheckpointSummary, resend: Schema.optional(TurnResend) }),
);

/** The worktree really moved — emitted only after the git work succeeded. */
const ThreadCheckpointRestoredEvent = orchestrationEvent(
  "thread.checkpoint.restored",
  Schema.Struct({ checkpoint: CheckpointSummary }),
);

/**
 * The restore did not happen: a locked directory, a garbage-collected ref, a
 * dirty submodule. Carries the checkpoint it was for, so a client can put the
 * failure on the right row instead of showing a stray error line.
 */
const ThreadCheckpointRestoreFailedEvent = orchestrationEvent(
  "thread.checkpoint.restore.failed",
  Schema.Struct({ checkpointId: CheckpointId, message: NonEmptyString }),
);

const ThreadDoneMarkedEvent = orchestrationEvent("thread.done.marked", Schema.Struct({}));

const ThreadDoneClearedEvent = orchestrationEvent("thread.done.cleared", Schema.Struct({}));

const ThreadErrorEvent = orchestrationEvent(
  "thread.error",
  Schema.Struct({ message: NonEmptyString, fatal: Schema.Boolean }),
);

export const OrchestrationEvent = Schema.Union([
  ProjectCreatedEvent,
  ProjectRemovedEvent,
  ThreadCreatedEvent,
  ThreadRenamedEvent,
  ThreadArchivedEvent,
  ThreadUnarchivedEvent,
  ThreadDeletedEvent,
  ThreadSessionBoundEvent,
  ThreadSessionLostEvent,
  ThreadTurnRequestedEvent,
  ThreadTurnStartedEvent,
  ThreadTurnCompletedEvent,
  ThreadTurnSteeredEvent,
  ThreadTurnInterruptedEvent,
  ThreadTaskStopRequestedEvent,
  ThreadMessageQueuedEvent,
  ThreadMessageDequeuedEvent,
  ThreadQueueReorderedEvent,
  ThreadItemUpsertedEvent,
  ThreadApprovalOpenedEvent,
  ThreadApprovalResolvedEvent,
  ThreadUserInputRequestedEvent,
  ThreadUserInputResolvedEvent,
  ThreadPlanProposedEvent,
  ThreadPlanRespondedEvent,
  ThreadSettingsUpdatedEvent,
  ThreadUsageUpdatedEvent,
  ThreadContextUpdatedEvent,
  ThreadCheckpointCreatedEvent,
  ThreadCheckpointRestoreRequestedEvent,
  ThreadCheckpointRestoredEvent,
  ThreadCheckpointRestoreFailedEvent,
  ThreadErrorEvent,
  ThreadDoneMarkedEvent,
  ThreadDoneClearedEvent,
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

/**
 * The type tags of `OrchestrationEvent`, as data. A test keeps this list and
 * the union's members in lockstep.
 */
export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.removed",
  "thread.created",
  "thread.renamed",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.session.bound",
  "thread.session.lost",
  "thread.turn.requested",
  "thread.turn.started",
  "thread.turn.completed",
  "thread.turn.steered",
  "thread.turn.interrupted",
  "thread.task.stopRequested",
  "thread.message.queued",
  "thread.message.dequeued",
  "thread.queue.reordered",
  "thread.item.upserted",
  "thread.approval.opened",
  "thread.approval.resolved",
  "thread.userInput.requested",
  "thread.userInput.resolved",
  "thread.plan.proposed",
  "thread.plan.responded",
  "thread.settings.updated",
  "thread.usage.updated",
  "thread.context.updated",
  "thread.checkpoint.created",
  "thread.checkpoint.restore.requested",
  "thread.checkpoint.restored",
  "thread.checkpoint.restore.failed",
  "thread.error",
  "thread.done.marked",
  "thread.done.cleared",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

/** The `type` tag of each event variant, in declaration order. */
export const orchestrationEventTypes: ReadonlyArray<OrchestrationEventType> =
  OrchestrationEvent.members.map((member) => member.fields.type.literal);

// ── Read models ────────────────────────────────────────────────

// The summaries and the thread snapshot live in `./readModels`; this module is
// still where they are imported from.
export { ProjectSummary, ThreadDetailSnapshot, ThreadSummary } from "./readModels";

/**
 * One frame of a thread subscription.
 *
 * `synchronized` is sent once, after the snapshot or catch-up replay, so the UI
 * knows it is live rather than still loading. `resnapshot-required` is how a
 * stream gives up on incremental delivery — the client's `afterSequence` has
 * aged out, or the subscription blew its budget — and the client reacts by
 * re-subscribing from scratch instead of rendering a gap.
 */
export const ThreadStreamItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snapshot"), snapshot: ThreadDetailSnapshot }),
  Schema.Struct({ kind: Schema.Literal("event"), event: OrchestrationEvent }),
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
  Schema.Struct({
    kind: Schema.Literal("resnapshot-required"),
    reason: NonEmptyString,
  }),
]);
export type ThreadStreamItem = typeof ThreadStreamItem.Type;

/** One frame of a thread-list subscription. */
export const ThreadListStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshotSequence: NonNegativeInt,
    threads: Schema.Array(ThreadSummary),
  }),
  Schema.Struct({ kind: Schema.Literal("upserted"), thread: ThreadSummary }),
  Schema.Struct({ kind: Schema.Literal("removed"), threadId: ThreadId }),
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
  Schema.Struct({
    kind: Schema.Literal("resnapshot-required"),
    reason: NonEmptyString,
  }),
]);
export type ThreadListStreamItem = typeof ThreadListStreamItem.Type;
