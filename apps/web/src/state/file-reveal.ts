/**
 * Requests to open a file in a workspace's Files tab — presentation state, in
 * memory only, the way `browser-activity.ts` asks for the browser pane.
 *
 * Requests are keyed by `workspaceKey` (`@/lib/workspace-key`): a thread's
 * bare id, or on the New task page the project's own key. A file chip in the
 * timeline, or a file link in a terminal, asks with `useRequestFileReveal`;
 * the thread view — or the New task page, for its project — answers with
 * `useFileRevealRequests`, which opens the dock on Files at that file and
 * line and clears the request, now or when the workspace is next on screen.
 * One pending request per workspace: a second click before the first is
 * answered replaces it.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

/** A workspace file to show, and the 1-based line to show it at. */
export interface FileRevealTarget {
  /** Relative to the workspace root, as `files.read` takes it. */
  readonly path: string;
  readonly line?: number;
}

type Requests = Readonly<Record<string, FileRevealTarget>>;

// `keepAlive`: the request is written by a row and read by the thread view,
// and has to outlive the moment between the two.
const fileRevealRequestsAtom = Atom.keepAlive(Atom.make<Requests>({}));

/**
 * A function that asks for a file to be shown in a workspace's Files tab, by
 * its `workspaceKey` (a thread's bare id).
 */
export const useRequestFileReveal = () => {
  const setRequests = useAtomSet(fileRevealRequestsAtom);
  return React.useCallback(
    (key: string, target: FileRevealTarget) =>
      setRequests((current) => ({ ...current, [key]: target })),
    [setRequests],
  );
};

/** Calls `reveal` whenever the workspace has a request pending, and clears it. */
export const useFileRevealRequests = (key: string, reveal: (target: FileRevealTarget) => void) => {
  const pending = useAtomValue(
    fileRevealRequestsAtom,
    React.useCallback((requests: Requests) => requests[key], [key]),
  );
  const setRequests = useAtomSet(fileRevealRequestsAtom);
  React.useEffect(() => {
    if (pending === undefined) return;
    setRequests((current) => {
      const { [key]: _answered, ...rest } = current;
      return rest;
    });
    reveal(pending);
  }, [key, pending, reveal, setRequests]);
};
