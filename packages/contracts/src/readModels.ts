/**
 * The read models a client decodes: a project and a thread as the sidebar
 * lists them, and the snapshot a thread subscription opens with. Their own
 * module so `orchestration.ts` stays within its size limit; it re-exports
 * every one, so importers keep reading them from
 * `@poseidon/contracts/orchestration`.
 */

import * as Schema from "effect/Schema";

import { IsoDateTime, NonEmptyString, NonNegativeInt } from "./base";
import { DecisionKind, ResolvedDecision } from "./decisions";
import { ThreadWorktree } from "./git";
import { ProjectId, RequestId, ThreadId, TurnId } from "./ids";
import { ApprovalRequest, ItemSnapshot, UserQuestion } from "./runtime";
import {
  CheckpointRestore,
  CheckpointSummary,
  ContextWindowUsage,
  ForkedFrom,
  QueuedMessage,
  ThreadActivity,
  ThreadDoneFields,
  ThreadSession,
  ThreadSettings,
  ThreadStatus,
  TurnUsage,
} from "./thread";

/** A project as the sidebar lists it. */
export const ProjectSummary = Schema.Struct({
  projectId: ProjectId,
  name: NonEmptyString,
  workspaceRoot: NonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  threadCount: NonNegativeInt,
});
export type ProjectSummary = typeof ProjectSummary.Type;

/** A thread as the sidebar lists it: enough for the row, never the timeline. */
export const ThreadSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: NonEmptyString,
  status: ThreadStatus,
  settings: ThreadSettings,
  preview: Schema.optional(Schema.String),
  /** True while something is waiting on the user: an approval, a question, a plan. */
  awaitingInput: Schema.Boolean,
  /**
   * Which of those it is — the most urgent when more than one is open: an
   * approval, then a question, then a plan. Absent when nothing waits, and
   * optional so a summary written before this field existed still decodes.
   */
  awaiting: Schema.optional(DecisionKind),
  /**
   * What the turn is doing while the thread is `running`, so the sidebar can
   * tell thinking from working. Absent otherwise, and optional so a summary
   * written before this field existed still decodes.
   */
  activity: Schema.optional(ThreadActivity),
  /**
   * When the turn in flight was requested, while the thread is `running`.
   * Absent otherwise, and optional so a summary written before this field
   * existed still decodes.
   */
  runningSince: Schema.optional(IsoDateTime),
  /** The thread's own worktree; absent for a local thread. */
  worktree: Schema.optional(ThreadWorktree),
  /** `doneAt` and `lastActivityAt`, for the Active/Done split. */
  ...ThreadDoneFields,
  forkedFrom: Schema.optional(ForkedFrom),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadSummary = typeof ThreadSummary.Type;

/**
 * Everything the thread view needs to render from cold, at one event-log
 * position. A subscriber decodes this, then applies events with a greater
 * `sequence` than `snapshotSequence`.
 */
export const ThreadDetailSnapshot = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: NonEmptyString,
  status: ThreadStatus,
  settings: ThreadSettings,
  /** The thread's own worktree; absent for a local thread. */
  worktree: Schema.optional(ThreadWorktree),
  forkedFrom: Schema.optional(ForkedFrom),
  snapshotSequence: NonNegativeInt,
  items: Schema.Array(ItemSnapshot),
  queue: Schema.Array(QueuedMessage),
  checkpoints: Schema.Array(CheckpointSummary),
  /**
   * The checkpoint whose restore is running right now.
   *
   * A restore is a durable work order: the server accepts it, a reactor runs
   * git over the whole worktree, and only then does `restored` or
   * `restore.failed` arrive. The client used to learn about that window only by
   * folding those three events, so a fresh snapshot forgot it — reload the
   * window while git is still working and the "Restoring the worktree…" line
   * was gone, the Restore button was live again, and pressing it was rejected
   * with "is already restoring a checkpoint".
   *
   * Optional, so a snapshot written before this field existed still decodes;
   * absent and `null` both mean "no restore in flight".
   */
  restoring: Schema.optional(Schema.NullOr(CheckpointSummary)),
  /**
   * Every restore that went through, oldest first. A restore moves the
   * worktree back without a checkpoint of its own, so the workspace a turn
   * started from is this, not the turn before's checkpoint, when a restore
   * came between them. Optional, so a snapshot written before this field
   * existed still decodes; absent means none.
   */
  restores: Schema.optional(Schema.Array(CheckpointRestore)),
  session: Schema.NullOr(ThreadSession),
  currentTurnId: Schema.NullOr(TurnId),
  pendingApproval: Schema.NullOr(ApprovalRequest),
  pendingUserInput: Schema.NullOr(
    Schema.Struct({ requestId: RequestId, questions: Schema.Array(UserQuestion) }),
  ),
  pendingPlan: Schema.NullOr(
    Schema.Struct({
      turnId: TurnId,
      planMarkdown: Schema.String,
      planPath: Schema.optional(NonEmptyString),
    }),
  ),
  /**
   * Every decision answered in this thread, oldest first. Optional so a
   * snapshot written before this field existed still decodes; absent means
   * none.
   */
  decisions: Schema.optional(Schema.Array(ResolvedDecision)),
  usage: Schema.NullOr(TurnUsage),
  context: Schema.NullOr(ContextWindowUsage),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadDetailSnapshot = typeof ThreadDetailSnapshot.Type;
