/**
 * The sidebar's unread dot.
 *
 * There is no `unread` flag on the wire and there should not be one — whether
 * a user has looked at a thread is this window's business, not the server's.
 * So the renderer remembers the `updatedAt` it last had each thread open at,
 * and a thread whose `updatedAt` has moved past that stamp is unread.
 *
 * A thread with no stamp is *not* unread. The dot means "changed since you last
 * had this open", so a fresh install restoring twenty old threads does not
 * light every one of them up.
 *
 * "Mark unread" stores the empty stamp `""`: every ISO `updatedAt` sorts after
 * it, so the row shows the dot and the bold title until the thread is opened
 * again and the open row stamps it afresh. That works for a thread that was
 * never stamped too.
 *
 * The map lives in localStorage like the dock's width and per-thread tab: it is
 * presentation state, it never reaches the server, and losing it costs nothing.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

/** `threadId -> the updatedAt the user last had that thread open at`. */
export type SeenMap = Readonly<Record<string, string>>;

/** Enough history to cover any realistic sidebar without growing forever. */
export const SEEN_LIMIT = 200;

const SEEN_KEY = "poseidon:threads-seen";

/** Absent, unparseable or foreign-shaped storage all mean "no memory yet". */
export const parseSeen = (raw: string | null | undefined): SeenMap => {
  if (raw === null || raw === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
};

export interface SeenThread {
  readonly threadId: string;
  readonly updatedAt: string;
}

/**
 * ISO-8601 with a fixed offset sorts lexicographically, and every `updatedAt`
 * on the wire is `IsoDateTime`, so a string compare is the whole test.
 */
export const isUnread = (seen: SeenMap, thread: SeenThread): boolean => {
  const stamp = seen[thread.threadId];
  return stamp !== undefined && thread.updatedAt > stamp;
};

/**
 * The map after the user has looked at `threadId` as of `updatedAt`. Returns
 * the *same* object when nothing changed, so a caller can write it from an
 * effect without re-rendering itself forever.
 */
export const markSeen = (seen: SeenMap, threadId: string, updatedAt: string): SeenMap => {
  if (seen[threadId] === updatedAt) {
    return seen;
  }
  const next: Record<string, string> = { ...seen, [threadId]: updatedAt };
  const keys = Object.keys(next);
  if (keys.length <= SEEN_LIMIT) {
    return next;
  }
  // Drop the oldest stamps first, but never the one just written, and never a
  // "mark unread" stamp (`""`) before an ordinary one: it sorts oldest of all,
  // yet it is a mark the user asked for, and only opening the thread clears it.
  const rank = (key: string) => (next[key] === "" ? "\uffff" : next[key]!);
  const kept = keys
    .filter((key) => key !== threadId)
    .sort((a, b) => rank(b).localeCompare(rank(a)))
    .slice(0, SEEN_LIMIT - 1);
  return Object.fromEntries([...kept, threadId].map((key) => [key, next[key]!]));
};

/**
 * The map after "mark unread": the empty stamp, older than any `updatedAt`, so
 * the thread reads as unread until it is opened again. The same map when the
 * thread is already marked.
 */
export const markUnread = (seen: SeenMap, threadId: string): SeenMap =>
  markSeen(seen, threadId, "");

/**
 * The map with `threadId`'s stamp put back to `stamp` — for undoing a "mark
 * unread" — or dropped when it had none. The same map when nothing changed.
 */
export const restoreSeen = (
  seen: SeenMap,
  threadId: string,
  stamp: string | undefined,
): SeenMap => {
  if (stamp !== undefined) {
    return markSeen(seen, threadId, stamp);
  }
  if (seen[threadId] === undefined) {
    return seen;
  }
  const rest: Record<string, string> = { ...seen };
  delete rest[threadId];
  return rest;
};

const readSeen = (): SeenMap => {
  try {
    return parseSeen(globalThis.localStorage?.getItem(SEEN_KEY));
  } catch {
    // Reading localStorage itself throws when site data is blocked.
    return {};
  }
};

// `keepAlive`: nothing reads the map on routes without the sidebar (Settings),
// and a dropped atom would come back from its load-time value — losing every
// stamp and "mark unread" since, and writing that stale map over storage.
const seenAtom = Atom.keepAlive(Atom.make<SeenMap>(readSeen()));

/**
 * `[seen, remember, controls]` — read the map, stamp a thread the user is
 * looking at, and `controls.markUnread` / `controls.restore` for the sidebar's
 * "Mark unread" and its undo. Every setter is stable.
 */
export const useThreadSeen = () => {
  const seen = useAtomValue(seenAtom);
  const setSeen = useAtomSet(seenAtom);
  const update = React.useCallback(
    (step: (current: SeenMap) => SeenMap) => {
      setSeen((current) => {
        const next = step(current);
        if (next === current) {
          return current;
        }
        try {
          globalThis.localStorage?.setItem(SEEN_KEY, JSON.stringify(next));
        } catch {
          // localStorage can throw (private mode, quota); the atom still updates.
        }
        return next;
      });
    },
    [setSeen],
  );
  const remember = React.useCallback(
    (threadId: string, updatedAt: string) =>
      update((current) => markSeen(current, threadId, updatedAt)),
    [update],
  );
  const controls = React.useMemo(
    () => ({
      markUnread: (threadId: string) => update((current) => markUnread(current, threadId)),
      restore: (threadId: string, stamp: string | undefined) =>
        update((current) => restoreSeen(current, threadId, stamp)),
    }),
    [update],
  );
  return [seen, remember, controls] as const;
};
