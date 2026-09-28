/**
 * The sidebar's pinned threads.
 *
 * Pinning keeps a thread in a "Pinned" group above the projects, whatever its
 * project and however that project is folded, and the thread keys walk it
 * first — see `./thread-order`.
 *
 * Pins are this window's, like the unread stamps in `./thread-seen` and the
 * folded projects: they live in localStorage and never reach the server. They
 * say how one person arranges one sidebar, not anything about the thread, so a
 * second client (a web renderer on another machine) keeps its own. Losing them
 * costs a click each.
 *
 * The list holds thread ids, newest pin first. A pin whose thread is gone is
 * left in place and simply matches nothing when the sidebar lists threads; the
 * list stays short enough that pruning it is not worth the bookkeeping.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

/** Pinned thread ids, newest pin first. */
export type Pins = ReadonlyArray<string>;

const PINS_KEY = "poseidon:threads-pinned";

/** Absent, unparseable or foreign-shaped storage all mean "nothing pinned". */
export const parsePins = (raw: string | null | undefined): Pins => {
  if (raw === null || raw === undefined) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return [...new Set(parsed.filter((id): id is string => typeof id === "string"))];
  } catch {
    return [];
  }
};

/**
 * The list after pinning (to the front) or unpinning `threadId`. Returns the
 * *same* array when nothing changed, so a caller can skip the write.
 */
export const withPin = (pins: Pins, threadId: string, pinned: boolean): Pins => {
  if (pins.includes(threadId) === pinned) {
    return pins;
  }
  return pinned ? [threadId, ...pins] : pins.filter((id) => id !== threadId);
};

const readPins = (): Pins => {
  try {
    return parsePins(globalThis.localStorage?.getItem(PINS_KEY));
  } catch {
    // Reading localStorage itself throws when site data is blocked.
    return [];
  }
};

// `keepAlive`: a plain atom is dropped with its last subscriber, and the next
// mount would start again from the load-time value.
const pinsAtom = Atom.keepAlive(Atom.make<Pins>(readPins()));

/** `[pins, setPinned]` — the pinned ids, and pin or unpin one thread. */
export const useThreadPins = () => {
  const pins = useAtomValue(pinsAtom);
  const setPins = useAtomSet(pinsAtom);
  const setPinned = React.useCallback(
    (threadId: string, pinned: boolean) => {
      setPins((current) => {
        const next = withPin(current, threadId, pinned);
        if (next === current) {
          return current;
        }
        try {
          globalThis.localStorage?.setItem(PINS_KEY, JSON.stringify(next));
        } catch {
          // localStorage can throw (private mode, quota); the atom still updates.
        }
        return next;
      });
    },
    [setPins],
  );
  return [pins, setPinned] as const;
};
