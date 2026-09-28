/**
 * A request to scroll a thread's timeline to one of its items.
 *
 * The Agents tab (`panes/agents`) asks the timeline to show a subagent's task
 * row. The two are separate trees, so the tab leaves a request here and the
 * timeline (`timeline/use-timeline-reveal.ts`) takes it for the thread it
 * shows: at once when that thread is on screen, or when the timeline mounts or
 * switches to it. One request is held at a time; a newer one replaces it.
 */

export interface TimelineRevealRequest {
  readonly threadId: string;
  readonly itemId: string;
}

let pending: TimelineRevealRequest | null = null;
const listeners = new Set<() => void>();

/** Ask the timeline of `request.threadId` to scroll to `request.itemId`. */
export const requestTimelineReveal = (request: TimelineRevealRequest): void => {
  pending = request;
  for (const listener of listeners) {
    listener();
  }
};

/** The request waiting for `threadId`, once; it is then spent. Null otherwise. */
export const takeTimelineReveal = (threadId: string): TimelineRevealRequest | null => {
  if (pending === null || pending.threadId !== threadId) {
    return null;
  }
  const request = pending;
  pending = null;
  return request;
};

/** Called on every request, so a mounted timeline can take one for itself. */
export const onTimelineRevealRequest = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
