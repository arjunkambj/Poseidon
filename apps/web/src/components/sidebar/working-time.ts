/**
 * Receding rows: a thread that is only working steps back in the sidebar.
 *
 * A turn that runs in the background needs nothing from the user until it
 * stops, yet its row changed weight on every event it took — `isUnread`
 * compares `updatedAt` with the seen stamp, so a running thread is "unread"
 * for its whole turn — and read as loudly as one that was waiting on them.
 * So a row that is only running, and is not the open thread, draws its title
 * muted and swaps "how long ago it moved" for how long it has been working
 * (`ThreadSummary.runningSince`), and the unread weight comes back when the
 * turn ends. Anything waiting on the user never recedes: `threadStatusMark`
 * already ranks it above a running turn.
 *
 * Minute granularity on purpose: the tree ticks once a minute, so a seconds
 * count (`formatElapsed` in `lib/format`) would sit stale for most of it.
 */

import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { threadStatusMark } from "./thread-status";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "<1m", "3m", "1h 4m", "2h 0m"; negative or not a number reads as "<1m". */
export const formatWorkingDuration = (ms: number): string => {
  if (!(ms >= MINUTE)) {
    return "<1m";
  }
  if (ms < HOUR) {
    return `${Math.floor(ms / MINUTE)}m`;
  }
  return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MINUTE)}m`;
};

const RUNNING_LABELS: ReadonlySet<string> = new Set(["Working", "Thinking"]);

/** Whether the row is only working: running, waiting on nobody, not open. */
export const recedes = (
  thread: Pick<ThreadSummary, "status" | "awaitingInput" | "awaiting" | "activity">,
  active: boolean,
): boolean => {
  if (active) {
    return false;
  }
  const mark = threadStatusMark(thread);
  return mark !== null && RUNNING_LABELS.has(mark.label);
};

/** How long the running turn has been working, or `null` when unknown. */
export const workingLabel = (
  thread: Pick<ThreadSummary, "runningSince">,
  now: number,
): string | null => {
  if (thread.runningSince === undefined) {
    return null;
  }
  const since = Date.parse(thread.runningSince);
  return Number.isNaN(since) ? null : formatWorkingDuration(now - since);
};
