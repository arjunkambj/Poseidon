/**
 * Requests to show a thread's Agents tab — presentation state, in memory
 * only, the way `file-reveal.ts` asks for the Files tab.
 *
 * The agents strip above the composer asks with `useRequestAgentsTab`; the
 * thread view answers with `useAgentsTabRequests`, which opens the dock on
 * Agents and clears the request, now or when the thread is next on screen.
 * One pending request per thread: a second click before the first is
 * answered is the same request.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

type Requests = Readonly<Record<string, true>>;

// `keepAlive`: the request is written by the strip and read by the thread
// view, and has to outlive the moment between the two.
const agentsTabRequestsAtom = Atom.keepAlive(Atom.make<Requests>({}));

/** A function that asks for a thread's Agents tab to be shown. */
export const useRequestAgentsTab = () => {
  const setRequests = useAtomSet(agentsTabRequestsAtom);
  return React.useCallback(
    (threadId: string) => setRequests((current) => ({ ...current, [threadId]: true })),
    [setRequests],
  );
};

/** Calls `show` whenever the thread has a request pending, and clears it. */
export const useAgentsTabRequests = (threadId: string, show: () => void) => {
  const pending = useAtomValue(
    agentsTabRequestsAtom,
    React.useCallback((requests: Requests) => requests[threadId] === true, [threadId]),
  );
  const setRequests = useAtomSet(agentsTabRequestsAtom);
  React.useEffect(() => {
    if (!pending) return;
    setRequests((current) => {
      const { [threadId]: _answered, ...rest } = current;
      return rest;
    });
    show();
  }, [pending, show, setRequests, threadId]);
};
