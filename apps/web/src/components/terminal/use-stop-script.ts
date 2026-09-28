/**
 * Stopping a script's terminal: Ctrl-C, which the pty turns into SIGINT for
 * the script's foreground process group, then the owner's listing read again
 * a moment later. A script in a tab not in front — or in a drawer that is
 * closed — has no xterm attached, so its exit is seen only on a listing; the
 * header's Stop and the drawer tab's own Stop both go through here, so either
 * one turns back into Run once the script has ended.
 */

import { useAtomRefresh, useAtomSet } from "@effect/atom-react";
import type { TerminalId } from "@poseidon/contracts/ids";
import { decodeTerminalOwnerKey } from "@poseidon/contracts/terminal";
import * as React from "react";

import { useTerminalAtoms } from "@/components/terminal/terminal-atoms";

/** How long after a Stop the listing is read again; most scripts end well within it. */
const STOP_RELIST_MS = 750;

export function useStopScript(ownerKey: string) {
  const atoms = useTerminalAtoms();
  const writeTerminal = useAtomSet(atoms.writeTerminal);
  const refreshList = useAtomRefresh(atoms.terminalListAtom(ownerKey));
  const refreshRunning = useAtomRefresh(atoms.runningTerminalsAtom);

  return React.useCallback(
    (terminalId: TerminalId) => {
      writeTerminal({ ...decodeTerminalOwnerKey(ownerKey), terminalId, data: "\u0003" });
      window.setTimeout(() => {
        refreshList();
        refreshRunning();
      }, STOP_RELIST_MS);
    },
    [ownerKey, refreshList, refreshRunning, writeTerminal],
  );
}
