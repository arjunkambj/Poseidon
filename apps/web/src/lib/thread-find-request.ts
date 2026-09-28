/**
 * A request to open a thread's find bar with a query, at a given message.
 *
 * A message hit in the command palette opens its thread, whose timeline may
 * not be mounted yet — or is mounted and showing another thread. So the
 * palette leaves a request here before it navigates, and the thread's find
 * bar (`timeline/use-thread-find.ts`) takes it when that thread's timeline
 * mounts or switches to it, or at once when the thread is already on screen.
 * One request is held at a time; a newer one replaces it.
 */

export interface ThreadFindRequest {
  readonly threadId: string;
  readonly query: string;
  /** The item whose match the bar goes to first; the first match without it. */
  readonly itemId?: string | undefined;
}

let pending: ThreadFindRequest | null = null;
const listeners = new Set<() => void>();

/** Ask the find bar of `request.threadId` to open with `request.query`. */
export const requestThreadFind = (request: ThreadFindRequest): void => {
  pending = request;
  for (const listener of listeners) {
    listener();
  }
};

/** The request waiting for `threadId`, once; it is then spent. Null otherwise. */
export const takeThreadFind = (threadId: string): ThreadFindRequest | null => {
  if (pending === null || pending.threadId !== threadId) {
    return null;
  }
  const request = pending;
  pending = null;
  return request;
};

/** Called on every request, so a mounted timeline can take one for itself. */
export const onThreadFindRequest = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
