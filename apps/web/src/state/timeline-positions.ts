/**
 * Where the reader was in each thread's timeline — presentation state, in
 * memory only, for this session.
 *
 * Leaving a thread unmounts its timeline, and the next visit would open at
 * the end again. The timeline saves the row the reader was on and how far
 * below the viewport top it sat as it unmounts, and puts it back before the
 * first paint when the thread reopens (`components/timeline/reading-position.ts`).
 * A thread left at its end saves nothing, so it opens at its end and keeps
 * following, exactly as before.
 *
 * The map is bounded: once it holds `MAX_TIMELINE_POSITIONS` threads, saving
 * another drops the one saved longest ago. Saving a thread again moves it to
 * the newest place. Nothing here reaches localStorage — a relaunch opens every
 * thread at its end.
 */

import * as Atom from "effect/unstable/reactivity/Atom";

/** A row of the timeline and where its top sat, px below the viewport top. */
export interface TimelinePosition {
  /** The row's id in the timeline projection (`TimelineRow.id`). */
  readonly rowKey: string;
  /** Px from the viewport top to the row's top; negative when it starts above. */
  readonly offset: number;
}

/** The most threads whose position the session keeps. */
export const MAX_TIMELINE_POSITIONS = 100;

type TimelinePositions = Readonly<Record<string, TimelinePosition>>;

// `keepAlive`, and it is the whole point: the only reader and writer is the
// timeline of the thread on screen, and a plain atom is disposed with its last
// subscriber — the very unmount the position has to survive.
export const timelinePositionsAtom = Atom.keepAlive(Atom.make<TimelinePositions>({}));

/**
 * `positions` with `threadId` at `position`, as the newest entry, or without
 * it when `position` is null. Returns `positions` itself when there is nothing
 * to delete, and drops the oldest threads past `MAX_TIMELINE_POSITIONS`.
 */
export const withTimelinePosition = (
  positions: TimelinePositions,
  threadId: string,
  position: TimelinePosition | null,
): TimelinePositions => {
  if (position === null) {
    if (!Object.hasOwn(positions, threadId)) {
      return positions;
    }
    const { [threadId]: _dropped, ...rest } = positions;
    return rest;
  }
  // Delete first, so the thread lands last in insertion order: the newest.
  // Thread ids are UUIDs, never integer-like keys, so the order holds.
  const { [threadId]: _previous, ...rest } = positions;
  const entries = Object.entries(rest);
  const kept = entries.slice(Math.max(0, entries.length - (MAX_TIMELINE_POSITIONS - 1)));
  return { ...Object.fromEntries(kept), [threadId]: position };
};
