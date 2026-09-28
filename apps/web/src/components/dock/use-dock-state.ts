/**
 * The right dock's state for one view — a thread, or the New task page for a
 * project — around what `?pane=` says it shows: every move the user makes,
 * what it remembers this session, the requests to focus the Files search or
 * the launcher's first row, and the dock staying up through its close.
 *
 * The rules are the pure half (`./dock-toggle`); this binds them to the view's
 * `DockMemory` (`@/state/ui`, keyed by `memoryKey`) and its route:
 *
 * - Every user move is remembered (`rememberDockMove`) and navigated to, and
 *   clears any pending focus request, so a later click on a tab does not take
 *   the focus.
 * - Arriving with no `?pane=` reopens what the dock was left on earlier in the
 *   session, and nothing otherwise (`dockArrivalTarget`); closing the dock
 *   forgets it, so this cannot reopen what the user just closed.
 * - Whatever put a tab on screen makes it the one the toggle goes back to
 *   (`noteDockShown`); only the user's own moves are reopened on arrival.
 * - The toggle opens on the last tab, else on the launcher with its first row
 *   focused; the Files key focuses the Files search.
 * - The strip shows the tabs opened here (`openTabs`, `dockStripTabs`), and
 *   closing one (`closeTab`, `closeDockTab`) only changes the memory — unless
 *   it was the active tab, when the dock moves to the tab that replaces it
 *   through the same path as any other user move, so closing the Browser is
 *   exactly switching away from it.
 *
 * It also publishes `dockOpen` while the dock is open.
 */

import * as React from "react";

import { useKeybindingFlag } from "@/lib/shortcuts";
import { usePresence } from "@/lib/use-presence";
import { useDockMemory } from "@/state/ui";

import {
  DOCK_HOME,
  closeDockTab,
  dockArrivalTarget,
  dockStripTabs,
  dockToggleTarget,
  isDockTab,
  noteDockShown,
  rememberDockMove,
  type DockPane,
  type DockTab,
} from "./dock-toggle";

export const useDockState = ({
  memoryKey,
  dockTab,
  navigateDock,
  onUserMove,
}: {
  /** Whose dock memory this is: a thread's id, or a project's key. */
  memoryKey: string;
  /** What `?pane=` says the dock shows; `undefined` when it is closed. */
  dockTab: DockPane | undefined;
  /** Puts `tab` in `?pane=` (`null` closes the dock), replacing the entry. */
  navigateDock: (tab: DockPane | null) => void;
  /** Told of each user move before it is made, from what the dock showed. */
  onUserMove?: (from: DockPane | undefined, to: DockPane | undefined) => void;
}) => {
  const [dockMemory, updateDockMemory] = useDockMemory(memoryKey);

  // Set by the Files key, read once by the Files pane as it mounts; any other
  // move of the dock clears it, so a later click on the tab does not focus.
  const [focusFilesSearch, setFocusFilesSearch] = React.useState(false);
  // The same for the launcher's first row: set only when the user opens the
  // dock onto it, so arriving at a dock left on the launcher (or reloading
  // onto one) leaves the focus where it is.
  const [focusLauncher, setFocusLauncher] = React.useState(false);

  // The active tab the user just closed, until the route moves off it: the
  // memory drops it at once, but `?pane=` still names it for a render or two,
  // and the strip must not put it back meanwhile.
  const closing = React.useRef<DockTab | null>(null);
  if (closing.current !== null && dockTab !== closing.current) {
    closing.current = null;
  }

  /** Every dock move the user makes: remembered, and noted. */
  const setDockTab = React.useCallback(
    (tab: DockPane | null) => {
      closing.current = null;
      setFocusFilesSearch(false);
      setFocusLauncher(false);
      onUserMove?.(dockTab, tab ?? undefined);
      updateDockMemory((memory) => rememberDockMove(memory, tab));
      navigateDock(tab);
    },
    [dockTab, onUserMove, updateDockMemory, navigateDock],
  );

  const arrival = dockArrivalTarget(dockMemory);
  React.useEffect(() => {
    if (dockTab === undefined && arrival !== undefined) {
      navigateDock(arrival);
    }
  }, [dockTab, navigateDock, arrival]);

  React.useEffect(() => {
    updateDockMemory((memory) => noteDockShown(memory, dockTab));
  }, [dockTab, updateDockMemory]);

  const toggleDock = () => {
    const target = dockToggleTarget(dockTab, dockMemory?.lastTab);
    setDockTab(target);
    setFocusLauncher(target === DOCK_HOME);
  };
  const showDockTab = (tab: DockTab | null, focus = false) => {
    setDockTab(tab);
    setFocusFilesSearch(focus && tab === "files");
  };
  /**
   * Closes `tab`. Closing another tab than the one shown touches the memory
   * only; closing the one shown is a user move to its neighbour (or the
   * launcher, focusing its first row).
   */
  const closeTab = React.useCallback(
    (tab: DockTab) => {
      if (dockTab === undefined) {
        return;
      }
      const { pane: next } = closeDockTab(dockMemory, tab, dockTab);
      if (next === dockTab) {
        updateDockMemory((memory) => closeDockTab(memory, tab, dockTab).memory);
        return;
      }
      setFocusFilesSearch(false);
      setFocusLauncher(next === DOCK_HOME);
      onUserMove?.(dockTab, next);
      updateDockMemory((memory) => closeDockTab(memory, tab, dockTab).memory);
      closing.current = isDockTab(dockTab) ? dockTab : null;
      navigateDock(next);
    },
    [dockTab, dockMemory, onUserMove, updateDockMemory, navigateDock],
  );
  const onFilesSearchFocused = React.useCallback(() => setFocusFilesSearch(false), []);
  const onLauncherFocused = React.useCallback(() => setFocusLauncher(false), []);

  useKeybindingFlag("dockOpen", dockTab !== undefined);

  // The dock stays up through its close, showing the tab it closed on.
  const phase = usePresence(dockTab !== undefined);
  const heldDockTab = React.useRef(dockTab);
  if (dockTab !== undefined) {
    heldDockTab.current = dockTab;
  }
  const shownDockTab = dockTab ?? heldDockTab.current;
  const openTabs =
    closing.current !== null && closing.current === shownDockTab
      ? (dockMemory?.openTabs ?? [])
      : dockStripTabs(dockMemory, shownDockTab);

  return {
    setDockTab,
    toggleDock,
    showDockTab,
    focusFilesSearch,
    onFilesSearchFocused,
    focusLauncher,
    onLauncherFocused,
    /** The dock's presence, `null` once it has closed. */
    phase,
    /** What the dock shows, held through its close. */
    shownDockTab,
    /** The tabs the strip shows: those opened here, in opening order. */
    openTabs,
    closeTab,
  };
};
