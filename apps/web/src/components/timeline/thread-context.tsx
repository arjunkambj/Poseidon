/**
 * Which thread the rows on screen belong to, its project, and what a row
 * needs to offer a restore: the pair a row needs to read the thread's
 * workspace (`files.stat` for file chips), the checkpoints still in the
 * repository, the restores that went through, the order of the thread's
 * turns, and why a restore cannot
 * start right now (`use-timeline-thread.ts` derives all of it from the
 * snapshot).
 *
 * Rows are dispatched by kind through `TimelineItemView`, and nesting (tasks,
 * work groups) recurses through the same dispatcher — so threading a thread id
 * down as a prop would touch every row component and every recursion site for
 * the sake of the few rows that need it. A context costs one wrapper. Its
 * value only changes when a turn starts or ends, a checkpoint lands, or the
 * connection drops — never on a streamed delta.
 *
 * `null` outside a timeline: a row rendered on the fixture page has no thread
 * to fetch from, and says so by not fetching.
 */

import type { ProjectId, ThreadId, TurnId } from "@poseidon/contracts/ids";
import type { CheckpointRestore, CheckpointSummary } from "@poseidon/contracts/orchestration";
import * as React from "react";

export interface TimelineThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** The fold's checkpoints that `checkpoints.list` still has. */
  readonly checkpoints: ReadonlyArray<CheckpointSummary>;
  /** The restores that went through, oldest first: where a turn after one started. */
  readonly restores: ReadonlyArray<CheckpointRestore>;
  /** Why no restore can start now (offline, restoring, a turn running), else `null`. */
  readonly restoreBlockedReason: string | null;
  /** The thread's turn ids, first seen first (`turn-checkpoints.ts`). */
  readonly turnOrder: ReadonlyArray<TurnId>;
  /**
   * The state of the workspace's files, as a name: it changes each time a
   * turn or a restore settles, so the file chips ask `files.stat` again
   * instead of reading an answer from before files were created or removed.
   */
  readonly workspaceRevision: string;
  /** Whether the server is reachable; absent reads as connected. */
  readonly connected?: boolean;
  /** The turn in flight, whose messages cannot be forked from yet. */
  readonly runningTurnId?: TurnId | null;
}

const TimelineThreadContext = React.createContext<TimelineThread | null>(null);

export function TimelineThreadProvider({
  value,
  children,
}: {
  /** Memoised by the caller: every row reading the context rerenders when it changes. */
  readonly value: TimelineThread;
  readonly children: React.ReactNode;
}) {
  return <TimelineThreadContext.Provider value={value}>{children}</TimelineThreadContext.Provider>;
}

export const useTimelineThread = (): TimelineThread | null =>
  React.useContext(TimelineThreadContext);

export const useTimelineThreadId = (): ThreadId | null => useTimelineThread()?.threadId ?? null;
