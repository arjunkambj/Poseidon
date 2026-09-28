/**
 * The sidebar's Active/Done split, on the client.
 *
 * The server keeps two stamps on every thread summary: `doneAt`, when the user
 * last marked it done, and `lastActivityAt`, the last turn, steer, queued
 * message, completion, unarchive or reopen. A thread is done while its mark is
 * at least as new as its last activity, so a new turn brings it back without
 * an event of its own. On top of that, the `autoDoneAfterDays` setting moves a
 * thread to Done once it has been idle that long; that rule is read here from
 * the clock and never stored. A summary written before `lastActivityAt`
 * existed falls back to `updatedAt`.
 *
 * Some threads are never done, whatever the stamps say: a pinned one (the pin
 * outranks the split, see `./thread-pins`), an archived or deleted one (the
 * sidebar does not list them), and one whose turn is in flight or waiting on
 * the user, which is exactly what the active list is for.
 *
 * Each project's Done section starts collapsed; which ones are expanded is
 * this window's layout, kept in localStorage like the folded projects.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { parseCollapsedProjects } from "@/state/ui";

/** The fields the rule reads, so tests can pass a bare object. */
export type DoneCandidate = Pick<
  ThreadSummary,
  "status" | "updatedAt" | "doneAt" | "lastActivityAt"
>;

export interface DoneContext {
  readonly now: number;
  /** The setting: `undefined` or `null` is off. */
  readonly autoDoneAfterDays?: number | null | undefined;
  readonly pinned: boolean;
}

const DAY_MS = 86_400_000;

/** A thread the Done section can never hold, whatever its stamps. */
const neverDone = (status: ThreadSummary["status"]): boolean =>
  status === "archived" || status === "deleted" || status === "running" || status === "waiting";

/** The thread's last activity, `updatedAt` for a summary without the stamp. */
export const lastActivityOf = (thread: DoneCandidate): string =>
  thread.lastActivityAt ?? thread.updatedAt;

/** Whether the sidebar lists `thread` under its project's Done section. */
export const threadIsDone = (thread: DoneCandidate, context: DoneContext): boolean => {
  if (context.pinned || neverDone(thread.status)) {
    return false;
  }
  const lastActivity = lastActivityOf(thread);
  if (thread.doneAt !== undefined && Date.parse(thread.doneAt) >= Date.parse(lastActivity)) {
    return true;
  }
  const days = context.autoDoneAfterDays;
  return (
    days !== undefined && days !== null && context.now - Date.parse(lastActivity) >= days * DAY_MS
  );
};

/**
 * Whether "Mark done" applies to `thread`: the same threads the section can
 * hold, since a mark on any other would change nothing on screen.
 */
export const canMarkDone = (thread: DoneCandidate, pinned: boolean): boolean =>
  !pinned && !neverDone(thread.status);

/** Why "Mark done" does not apply to `thread`, as short as a menu item's hint; `null` when it does. */
export const markDoneBlockedReason = (thread: DoneCandidate, pinned: boolean): string | null =>
  pinned
    ? "Pinned"
    : thread.status === "running"
      ? "Running"
      : thread.status === "waiting"
        ? "Waiting"
        : thread.status === "archived" || thread.status === "deleted"
          ? "Archived"
          : null;

/**
 * Why the selection bar's "Mark done" would do nothing, or `null`: every
 * picked thread is pinned, busy or done already, and the bar is not offering
 * "Mark active" (which it does only when all of them are done).
 */
export const selectionDoneBlockedReason = <Thread extends DoneCandidate>(
  threads: ReadonlyArray<Thread>,
  isDone: (thread: Thread) => boolean,
  isPinned: (thread: Thread) => boolean,
): string | null => {
  if (threads.every(isDone)) {
    return null;
  }
  return threads.some((thread) => canMarkDone(thread, isPinned(thread)) && !isDone(thread))
    ? null
    : "Pinned, running and waiting threads stay active";
};

const DONE_EXPANDED_KEY = "poseidon:done-expanded";

const readDoneExpanded = (): ReadonlySet<string> => {
  try {
    return parseCollapsedProjects(globalThis.localStorage?.getItem(DONE_EXPANDED_KEY));
  } catch {
    // Reading localStorage itself throws when site data is blocked.
    return new Set();
  }
};

// Stored as the expanded set, so a new project's Done section starts collapsed.
// `keepAlive`: the thread keys read it while no project section is mounted.
const doneExpandedAtom = Atom.keepAlive(Atom.make<ReadonlySet<string>>(readDoneExpanded()));

/** Every project whose Done section is open, for the order the thread keys walk. */
export const useDoneExpandedProjects = (): ReadonlySet<string> => useAtomValue(doneExpandedAtom);

/** `[expanded, setExpanded]` for one project's Done section. */
export const useDoneExpanded = (projectId: string) => {
  const expanded = useAtomValue(
    doneExpandedAtom,
    React.useCallback((ids: ReadonlySet<string>) => ids.has(projectId), [projectId]),
  );
  const setIds = useAtomSet(doneExpandedAtom);
  const setExpanded = React.useCallback(
    (next: boolean) =>
      setIds((current) => {
        if (current.has(projectId) === next) {
          return current;
        }
        const ids = new Set(current);
        if (next) {
          ids.add(projectId);
        } else {
          ids.delete(projectId);
        }
        try {
          globalThis.localStorage?.setItem(DONE_EXPANDED_KEY, JSON.stringify([...ids]));
        } catch {
          // localStorage can throw (private mode, quota); the atom still updates.
        }
        return ids;
      }),
    [setIds, projectId],
  );
  return [expanded, setExpanded] as const;
};
