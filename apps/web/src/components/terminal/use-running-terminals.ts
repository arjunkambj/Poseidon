/**
 * Running terminals, as the sidebar and the New task header show them.
 *
 * `useRunningTerminals(owner)` reads one owner's `terminal.list` atom, the one
 * the drawer and the other readers of that owner share — the project badge's
 * source. `useThreadRunningTerminals(threadId)` reads a thread's from the one
 * `terminal.listRunning` listing every thread row shares, so a long sidebar
 * costs one call per refetch, not one per row.
 *
 * Both listings are refetched on connecting, after every open, close and
 * hand-over, and on a return to the window, since a shell nobody is watching
 * can exit without the client hearing of it; the return refetch is shared by
 * the atom (`useSharedWindowReturn`), so it runs once however many readers
 * show it.
 */

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { TerminalListQuery } from "@poseidon/client-runtime/terminalAtoms";
import type { ThreadId } from "@poseidon/contracts/ids";
import {
  terminalOwnerKey,
  type TerminalOwner,
  type TerminalSummary,
} from "@poseidon/contracts/terminal";
import type * as Atom from "effect/unstable/reactivity/Atom";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { runningTerminals } from "@/components/terminal/running-terminals";
import { useTerminalAtoms } from "@/components/terminal/terminal-atoms";
import { useSharedWindowReturn } from "@/lib/window-return";

/** A listing atom's current answer, refetched on a return to the window. */
const useListing = (
  atom: Atom.Atom<AsyncResult.AsyncResult<TerminalListQuery, unknown>>,
): TerminalListQuery | null => {
  const list = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  useSharedWindowReturn(atom, refresh);
  return AsyncResult.isSuccess(list) ? list.value : null;
};

export function useRunningTerminals(owner: TerminalOwner): ReadonlyArray<TerminalSummary> {
  return runningTerminals(useListing(useTerminalAtoms().terminalListAtom(terminalOwnerKey(owner))));
}

export function useThreadRunningTerminals(threadId: ThreadId): ReadonlyArray<TerminalSummary> {
  const listed = useListing(useTerminalAtoms().runningTerminalsAtom);
  return React.useMemo(
    () => runningTerminals(listed).filter((terminal) => terminal.threadId === threadId),
    [listed, threadId],
  );
}
