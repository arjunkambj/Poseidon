/**
 * The running terminals of one owner — a project or a thread — read from its
 * `terminal.list` atom, the one the drawer and the other readers of that owner
 * share. The listing is refetched on connecting, after every open, close and
 * hand-over, and on a return to the window, since a shell nobody is watching
 * can exit without the client hearing of it; the return refetch is shared by
 * the atom (`useSharedWindowReturn`), so it runs once however many readers
 * show it.
 */

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  terminalOwnerKey,
  type TerminalOwner,
  type TerminalSummary,
} from "@poseidon/contracts/terminal";
import { AsyncResult } from "effect/unstable/reactivity";

import { runningTerminals } from "@/components/terminal/running-terminals";
import { useTerminalAtoms } from "@/components/terminal/terminal-atoms";
import { useSharedWindowReturn } from "@/lib/window-return";

export function useRunningTerminals(owner: TerminalOwner): ReadonlyArray<TerminalSummary> {
  const listAtom = useTerminalAtoms().terminalListAtom(terminalOwnerKey(owner));
  const list = useAtomValue(listAtom);
  const refresh = useAtomRefresh(listAtom);
  useSharedWindowReturn(listAtom, refresh);
  return runningTerminals(AsyncResult.isSuccess(list) ? list.value : null);
}
