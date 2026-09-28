/**
 * The window's memory of each thread's agent browser use, and requests to
 * reveal a thread's browser pane — presentation state, in memory only.
 *
 * - **Activity.** Whether the agent was using the thread's browser when last
 *   seen, and whether the user closed the pane on it; the rules that read it
 *   are `@/components/panes/browser/auto-open`. Kept per thread across thread
 *   switches, so returning to a thread does not count as the agent starting,
 *   and the first sight of a thread is only a baseline (`seen`), so arriving
 *   at one does not either.
 * - **Reveal requests.** `openInThreadBrowser` asks for a thread's pane from
 *   outside the thread view (a terminal link); the thread view shows it and
 *   clears the request, now or when that thread is next on screen.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import type { AtomRegistry } from "effect/unstable/reactivity";
import * as React from "react";

/** What the window remembers about one thread's agent and its pane. */
export interface ThreadAgentActivity {
  /** The agent was using the browser when last observed. */
  readonly active: boolean;
  /** The user closed the pane while the agent was active, and has not reopened it. */
  readonly closedByUser: boolean;
  /**
   * The thread has been on screen since the window opened. Only a thread on
   * screen is observed, so the first observation is a baseline, not a start:
   * arriving at a thread whose agent already uses the browser opens nothing.
   */
  readonly seen: boolean;
}

export const idleActivity: ThreadAgentActivity = {
  active: false,
  closedByUser: false,
  seen: false,
};

type Activities = Readonly<Record<string, ThreadAgentActivity>>;

// `keepAlive`: the one subscriber is the thread on screen, and the record has
// to outlive it.
const agentActivityAtom = Atom.keepAlive(Atom.make<Activities>({}));

/** One thread's record, and an updater that runs synchronously against the latest. */
export const useThreadAgentActivity = (threadId: string) => {
  const activity = useAtomValue(
    agentActivityAtom,
    React.useCallback((all: Activities) => all[threadId] ?? idleActivity, [threadId]),
  );
  const setAll = useAtomSet(agentActivityAtom);
  const update = React.useCallback(
    (change: (current: ThreadAgentActivity) => ThreadAgentActivity) =>
      setAll((all) => {
        const current = all[threadId] ?? idleActivity;
        const next = change(current);
        return next === current ? all : { ...all, [threadId]: next };
      }),
    [setAll, threadId],
  );
  return [activity, update] as const;
};

const revealRequestsAtom = Atom.keepAlive(Atom.make<ReadonlySet<string>>(new Set<string>()));

/** Ask for the thread's browser pane to be shown. */
export const requestBrowserReveal = (registry: AtomRegistry.AtomRegistry, threadId: string) => {
  registry.update(revealRequestsAtom, (current) =>
    current.has(threadId) ? current : new Set([...current, threadId]),
  );
};

/** Calls `reveal` whenever the thread has a request pending, and clears it. */
export const useBrowserRevealRequests = (threadId: string, reveal: () => void) => {
  const pending = useAtomValue(
    revealRequestsAtom,
    React.useCallback((requests: ReadonlySet<string>) => requests.has(threadId), [threadId]),
  );
  const setRequests = useAtomSet(revealRequestsAtom);
  React.useEffect(() => {
    if (!pending) return;
    setRequests((current) => {
      const next = new Set(current);
      next.delete(threadId);
      return next;
    });
    reveal();
  }, [pending, reveal, setRequests, threadId]);
};
