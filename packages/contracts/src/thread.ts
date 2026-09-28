/**
 * The value objects a thread's commands, events and read models share: its
 * settings, the queue's messages, usage and context accounting, checkpoints,
 * the session it is bound to and the status the sidebar shows.
 *
 * `./orchestration` re-exports every one of them, so that is still where a
 * reader imports them from; they live apart only to keep that file readable.
 */

import * as Schema from "effect/Schema";

import { IsoDateTime, NonEmptyString, NonNegativeInt } from "./base";
import { Effort, InteractionMode, RuntimeMode } from "./enums";
import { CheckpointId, ConnectorInstanceId, ConnectorKind, ItemId, ThreadId, TurnId } from "./ids";
import { Attachment, ConnectorCapabilities, TurnReference } from "./runtime";

/** A `#` file mention from the composer: a workspace-relative path. */
export const Mention = NonEmptyString;
export type Mention = typeof Mention.Type;

/**
 * The per-thread controls the header exposes.
 *
 * `connectorInstanceId` is the harness the user picked for this thread. It is
 * optional because every event written before threads could choose one lacks
 * it, and because a thread may leave the choice to routing: absent means "the
 * default rule" — the first enabled connector that is open.
 *
 * `ultracode` is a Claude Code session mode: `xhigh` effort plus standing
 * dynamic-workflow orchestration (the harness's Workflow tool). It is off when
 * absent, which is every event written before it existed, and it only means
 * something on a session whose capabilities carry `ultracode`.
 */
export const ThreadSettings = Schema.Struct({
  model: NonEmptyString,
  effort: Schema.optional(Effort),
  runtimeMode: RuntimeMode,
  interactionMode: InteractionMode,
  connectorInstanceId: Schema.optional(ConnectorInstanceId),
  ultracode: Schema.optional(Schema.Boolean),
});
export type ThreadSettings = typeof ThreadSettings.Type;

/** A partial update of `ThreadSettings`; absent fields are left alone. */
export const ThreadSettingsPatch = Schema.Struct({
  model: Schema.optional(NonEmptyString),
  effort: Schema.optional(Effort),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(InteractionMode),
  connectorInstanceId: Schema.optional(ConnectorInstanceId),
  ultracode: Schema.optional(Schema.Boolean),
});
export type ThreadSettingsPatch = typeof ThreadSettingsPatch.Type;

/**
 * Whether a thread is past the point where it may change connector instance:
 * it has a bound session, a running turn, or any message of the user's. A
 * harness's session cannot be carried to another harness, so from then on the
 * way to use a different connector is a new thread. The decider and the
 * renderer both ask this, so the picker is never enabled for a switch the
 * server would refuse.
 */
export const threadLocksConnector = (thread: {
  readonly session: unknown;
  readonly items: ReadonlyArray<{ readonly kind: string }>;
  readonly currentTurnId?: unknown;
  readonly currentTurn?: unknown;
}): boolean =>
  thread.session != null ||
  thread.currentTurnId != null ||
  thread.currentTurn != null ||
  thread.items.some((item) => item.kind === "user_message");

/** What the user typed while a turn was still running. */
export const QueuedMessage = Schema.Struct({
  queuedMessageId: ItemId,
  text: Schema.String,
  attachments: Schema.Array(Attachment),
  mentions: Schema.Array(Mention),
  references: Schema.optional(Schema.Array(TurnReference)),
  queuedAt: IsoDateTime,
});
export type QueuedMessage = typeof QueuedMessage.Type;

/** Token accounting for one turn. */
export const TurnUsage = Schema.Struct({
  input: NonNegativeInt,
  output: NonNegativeInt,
  cacheRead: NonNegativeInt,
  cacheWrite: NonNegativeInt,
  costUsd: Schema.optional(Schema.Number),
});
export type TurnUsage = typeof TurnUsage.Type;

/** How much of the model's context window the thread is using. */
export const ContextWindowUsage = Schema.Struct({
  used: NonNegativeInt,
  limit: NonNegativeInt,
});
export type ContextWindowUsage = typeof ContextWindowUsage.Type;

/** One per-turn worktree snapshot, stored as a hidden git ref. */
export const CheckpointSummary = Schema.Struct({
  checkpointId: CheckpointId,
  turnId: TurnId,
  ref: NonEmptyString,
  createdAt: IsoDateTime,
});
export type CheckpointSummary = typeof CheckpointSummary.Type;

/**
 * A restore that went through: the checkpoint the worktree went back to, and
 * the thread's latest turn when it did (`latestTurnId`), or `null` before any.
 * A restore runs only between turns and records no checkpoint of its own, so
 * this is the only record that the next turn started from `checkpoint` rather
 * than from the latest turn's own checkpoint.
 */
export const CheckpointRestore = Schema.Struct({
  checkpoint: CheckpointSummary,
  afterTurnId: Schema.NullOr(TurnId),
});
export type CheckpointRestore = typeof CheckpointRestore.Type;

/**
 * The thread's latest turn as its items name them: the last turn id to first
 * appear, or `null` when no item carries one. Items stay in the order they
 * were created and a steered message carries its turn's id, so this is the
 * turn that ran last. The server's fold and the client's both stamp a
 * `CheckpointRestore` with it, so they agree.
 */
export const latestTurnId = (
  items: ReadonlyArray<{ readonly turnId?: TurnId | undefined }>,
): TurnId | null => {
  const seen = new Set<TurnId>();
  let latest: TurnId | null = null;
  for (const item of items) {
    if (item.turnId !== undefined && !seen.has(item.turnId)) {
      seen.add(item.turnId);
      latest = item.turnId;
    }
  }
  return latest;
};

/**
 * The connector session a thread is currently bound to, if any.
 *
 * `capabilities` is what that session's harness said it can do when it
 * started — the decider reads `steering` off it to decide whether a message
 * sent mid-turn goes into the running turn or onto the queue. Optional, so a
 * session bound before the field existed still decodes; absent reads as "no
 * steering".
 */
export const ThreadSession = Schema.Struct({
  connectorInstanceId: ConnectorInstanceId,
  connectorKind: ConnectorKind,
  sessionRef: Schema.Unknown,
  capabilities: Schema.optional(ConnectorCapabilities),
});
export type ThreadSession = typeof ThreadSession.Type;

/**
 * What the sidebar pill shows. `deleted` is produced by the client fold when a
 * `thread.deleted` event arrives for a thread that is open — the server never
 * sends it, because a deleted thread leaves the read model entirely. It exists
 * so an open timeline can say the thread is gone instead of quietly claiming
 * it was archived.
 */
export const ThreadStatus = Schema.Literals([
  "idle",
  "running",
  "waiting",
  "error",
  "archived",
  "deleted",
]);
export type ThreadStatus = typeof ThreadStatus.Type;

/**
 * What a `running` thread is doing right now: `working` while a tool call,
 * a command or a file change is in flight, `thinking` otherwise — the model
 * reasoning or writing between them.
 */
export const ThreadActivity = Schema.Literals(["thinking", "working"]);
export type ThreadActivity = typeof ThreadActivity.Type;

/**
 * What the user chose on a proposed plan. `handoff` closes the plan without
 * running it here: it went to a new thread to be implemented there, so this
 * thread leaves plan mode and starts no turn.
 */
export const PlanResponseAction = Schema.Literals(["accept", "accept-auto", "revise", "handoff"]);
export type PlanResponseAction = typeof PlanResponseAction.Type;

/**
 * The sidebar's Active/Done split, as `ThreadSummary` carries it. `doneAt` is
 * when the user last marked the thread done, absent when they never did or a
 * later `thread.done.cleared` or unarchive took it back. `lastActivityAt` is
 * the last time the thread was created, sent a turn, steered, queued to,
 * finished a turn, unarchived or reopened. A thread is marked done while
 * `doneAt >= lastActivityAt`, so any newer activity brings it back without an
 * event of its own; the auto-done rule reads `lastActivityAt` against the
 * `autoDoneAfterDays` setting on the client. Both optional, so a summary
 * written before they existed still decodes.
 */
export const ThreadDoneFields = {
  doneAt: Schema.optional(IsoDateTime),
  lastActivityAt: Schema.optional(IsoDateTime),
};

/**
 * What `thread.create` asks for to fork a thread: the source, and the user
 * message to fork from. The fork carries the source's conversation through
 * the end of that message's turn; without `throughItemId`, the whole thread.
 */
export const ThreadForkRequest = Schema.Struct({
  threadId: ThreadId,
  throughItemId: Schema.optional(ItemId),
});
export type ThreadForkRequest = typeof ThreadForkRequest.Type;

/**
 * The harness session a fork continues natively, when it does: the source's
 * connector instance, the session reference it had bound, and its latest turn
 * then (`afterTurnId`). Its first turn resumes that session with `fork: true`,
 * so the harness itself copies the conversation into a new session and leaves
 * the source's alone — but only while the source is still where it was, since
 * the harness copies the session as it stands when the fork's turn runs.
 */
export const ForkSession = Schema.Struct({
  connectorInstanceId: ConnectorInstanceId,
  sessionRef: Schema.Unknown,
  afterTurnId: Schema.optional(TurnId),
});
export type ForkSession = typeof ForkSession.Type;

/**
 * A fork as `thread.created` records it: the source and its title when the
 * fork was made, the message it was forked from, and the transcript the
 * server built from the source at that moment. The transcript is kept here,
 * not read from the source later, so the fork's first turn still has it after
 * the source is renamed, changed or deleted. It is sent to the harness ahead
 * of the fork's first message and never shown as a row — unless `session` is
 * set and the harness forked that session itself, in which case it already
 * holds the conversation and the transcript is only the fallback.
 */
export const ThreadFork = Schema.Struct({
  threadId: ThreadId,
  title: NonEmptyString,
  throughItemId: Schema.optional(ItemId),
  transcript: Schema.String,
  session: Schema.optional(ForkSession),
});
export type ThreadFork = typeof ThreadFork.Type;

/**
 * The "Forked from" link a forked thread's summary and snapshot carry: the
 * source and its title when the fork was made. Absent on every thread that
 * is not a fork, and on everything written before forks existed.
 */
export const ForkedFrom = Schema.Struct({ threadId: ThreadId, title: NonEmptyString });
export type ForkedFrom = typeof ForkedFrom.Type;

/**
 * The edited message an "Edit and resend" carries on its restore: once the
 * worktree is back at the checkpoint before the original message, the server
 * starts a turn with this, exactly as `thread.turn.start` would. It rides on
 * the durable restore work order, so a restart between the restore and the
 * send loses nothing, and a restore that fails sends nothing.
 */
export const TurnResend = Schema.Struct({
  text: NonEmptyString,
  attachments: Schema.Array(Attachment),
  mentions: Schema.Array(Mention),
  references: Schema.optional(Schema.Array(TurnReference)),
});
export type TurnResend = typeof TurnResend.Type;
