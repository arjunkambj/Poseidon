/**
 * Running and stopping scripts in an owner's terminal drawer — a thread's, or
 * on the New task page a project's (`ownerKey`, its `terminalOwnerKey`).
 *
 * A script runs as a terminal's own process (`terminal.open` with `script`),
 * in a new tab titled with its name, and the drawer opens on it. Running a
 * script whose tab is still running brings that tab to the front instead;
 * one whose tab has exited gets a fresh tab, and the old one is closed
 * (`planRun`); a second Run of a script whose terminal is still being
 * opened starts nothing (`launchOnce`). Stop writes Ctrl-C
 * (`@/components/terminal/use-stop-script`); the tab's close button stays the
 * hard kill.
 *
 * Only the tab in front has an xterm attached, so a script in another tab —
 * or in a drawer that is closed — is seen to exit only on a listing. The hook
 * reads the owner's `terminal.list`, folds it into the tabs while the drawer
 * is closed (the open drawer folds it itself), and `relist` reads it again,
 * as the Run menu does when it opens. While such an unwatched script runs
 * (`hasUnwatchedScript`), the listing is read again every
 * `UNWATCHED_RELIST_MS`, so a build that ends behind a closed drawer turns
 * the header's Stop back into Run on its own.
 *
 * The order of `run` matters: the terminal is opened over RPC, its tab added
 * to the drawer's state, and only then is the drawer opened. A drawer opened
 * first would find its owner with no tabs and start a shell of its own. The
 * drawer mounts with the listing from before the open, which cannot show the
 * new terminal; its tab survives that listing as one opened ahead of it
 * (`openedAhead` in `@/components/terminal/drawer-state`).
 */

import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { makeTerminalId } from "@poseidon/contracts/ids";
import { decodeTerminalOwnerKey } from "@poseidon/contracts/terminal";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";
import { toast } from "sonner";

import { useForgetDevServer } from "@/components/terminal/dev-servers";
import { useDrawerState } from "@/components/terminal/drawer-state";
import { useOpenTerminal, useTerminalAtoms } from "@/components/terminal/terminal-atoms";
import { useStopScript } from "@/components/terminal/use-stop-script";
import { describeExitError } from "@/lib/app-runtime";
import { useTerminalOpen } from "@/state/terminal-ui";

import {
  hasUnwatchedScript,
  launchOnce,
  planRun,
  runningTerminalOf,
  type RunnableScript,
} from "./project-scripts";

/** How often the listing is read while a script runs where no xterm watches it. */
const UNWATCHED_RELIST_MS = 2000;

export function useRunScript(ownerKey: string) {
  const atoms = useTerminalAtoms();
  const [state, dispatch] = useDrawerState(ownerKey);
  const [drawerOpen, setOpen] = useTerminalOpen(ownerKey);
  const openTerminal = useOpenTerminal();
  const stop = useStopScript(ownerKey);
  const closeTerminal = useAtomSet(atoms.closeTerminal);
  const forgetDevServer = useForgetDevServer();
  const refreshList = useAtomRefresh(atoms.terminalListAtom(ownerKey));
  const refreshRunning = useAtomRefresh(atoms.runningTerminalsAtom);
  const tabsRef = React.useRef(state.tabs);
  tabsRef.current = state.tabs;
  // Scripts whose `terminal.open` has not answered yet (`launchOnce`).
  const launching = React.useRef(new Set<string>());

  const list = useAtomValue(atoms.terminalListAtom(ownerKey));
  const listed = AsyncResult.isSuccess(list) ? list.value : null;
  React.useEffect(() => {
    if (!drawerOpen && listed?._tag === "ok") {
      dispatch({ type: "synced", terminals: listed.terminals });
    }
  }, [dispatch, drawerOpen, listed]);

  const relist = React.useCallback(() => {
    refreshList();
    refreshRunning();
  }, [refreshList, refreshRunning]);

  const unwatched = hasUnwatchedScript(state.tabs, state.activeId, drawerOpen);
  React.useEffect(() => {
    if (!unwatched) return;
    const timer = window.setInterval(relist, UNWATCHED_RELIST_MS);
    return () => window.clearInterval(timer);
  }, [relist, unwatched]);

  const run = React.useCallback(
    async (script: RunnableScript) => {
      const owner = decodeTerminalOwnerKey(ownerKey);
      const plan = planRun(tabsRef.current, script);
      if (plan.kind === "focus") {
        dispatch({ type: "activated", terminalId: plan.terminalId });
        setOpen(true);
        return;
      }
      await launchOnce(launching.current, script.id, async () => {
        const exit = await openTerminal({
          ...owner,
          terminalId: makeTerminalId(),
          title: script.name,
          cols: 80,
          rows: 24,
          script,
        });
        if (exit._tag !== "Success") {
          toast.error(describeExitError(exit, `Could not run ${script.name}`));
          return;
        }
        dispatch({ type: "opened", terminal: exit.value });
        // Closed only once the new tab is in: closing it first could leave the
        // drawer with no tabs for a moment, and an open drawer starts a shell.
        if (plan.replace !== null) {
          dispatch({ type: "closed", terminalId: plan.replace });
          closeTerminal({ ...owner, terminalId: plan.replace });
          forgetDevServer(plan.replace);
        }
        relist();
        setOpen(true);
      });
    },
    [closeTerminal, dispatch, forgetDevServer, openTerminal, ownerKey, relist, setOpen],
  );

  const runningOf = React.useCallback(
    (scriptId: string) => runningTerminalOf(state.tabs, scriptId),
    [state.tabs],
  );

  return { run, stop, runningOf, relist };
}
