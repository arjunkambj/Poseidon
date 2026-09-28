/**
 * What the right dock shows, and where its keys and buttons take it — the pure
 * half of the dock, tested without a DOM.
 *
 * The dock is either closed (`?pane=` absent), open on one of its tabs
 * (`changes | browser | files`), or open with no tab chosen yet: the
 * launcher, `?pane=home`, a short list of the tabs and their keys.
 * `DockPane` is that open state; `DockTab` is only the tabs.
 *
 * A thread's dock has all three tabs. The New task page's dock, for a project
 * with no thread yet, has `projectDockTabs`: Changes (the project folder's
 * working tree and branch) and Files. The Browser tab is a thread's browser,
 * so there is none to show before the thread exists.
 *
 * The dock starts closed. Nothing about it survives a relaunch: a thread
 * reached with no `?pane=` (a sidebar link, a fresh start) opens with the
 * dock shut, unless this session already left that thread's dock open —
 * `DockMemory`, kept per thread in memory only (`@/state/ui`).
 *
 * - `dock.toggle` (and the header's dock button) closes an open dock, and
 *   opens a closed one on the last tab used in this thread this session,
 *   else on the launcher (`dockToggleTarget`).
 * - `dock.changes`, `dock.files` and `browserPane.toggle` open their tab,
 *   from a closed dock, the launcher or another tab, or close the dock when
 *   it is already showing that tab (`dockTabTarget`).
 * - A thread the user left with its dock open reopens on what it showed
 *   (`dockArrivalTarget`); closing the dock forgets that, so arriving can
 *   never reopen what was just closed. The last tab used is kept apart from
 *   it (`lastTab`) so the toggle can still go back to it after a close.
 * - Each thread keeps the tabs opened in it this session, in opening order
 *   (`openTabs`): any way a tab comes up — a chord, a link, the browser
 *   opening itself — adds it once. The strip shows those (`dockStripTabs`),
 *   and closing one (`closeDockTab`) moves to its right neighbour, else its
 *   left, else the launcher; the dock itself stays open. `lastTab` is always
 *   one of the open tabs or nothing, so the toggle never reopens a closed tab.
 */

const DOCK_TABS = ["changes", "browser", "files"] as const;
export type DockTab = (typeof DOCK_TABS)[number];

/** The tabs, in strip order. */
export const dockTabs: ReadonlyArray<DockTab> = DOCK_TABS;

/**
 * The tabs a project's dock offers before any thread exists, in strip order —
 * the kinds `./dock-tab-meta` marks available to a project (a test holds the
 * two equal). A literal here keeps route validation free of the registry.
 */
export const projectDockTabs: ReadonlyArray<DockTab> = ["changes", "files"];

/** The launcher: the dock open with no tab chosen. */
export const DOCK_HOME = "home";

/** Everything an open dock can show: a tab, or the launcher. */
export type DockPane = DockTab | typeof DOCK_HOME;

export const isDockTab = (value: unknown): value is DockTab =>
  typeof value === "string" && (DOCK_TABS as ReadonlyArray<string>).includes(value);

/** What `?pane=` may carry; anything else reads as a closed dock. */
export const isDockPane = (value: unknown): value is DockPane =>
  value === DOCK_HOME || isDockTab(value);

/** What the New task page's `?pane=` may carry: the launcher, or a tab a project's dock offers. */
export const isProjectDockPane = (value: unknown): value is DockPane =>
  value === DOCK_HOME || (isDockTab(value) && projectDockTabs.includes(value));

export const dockToggleTarget = (
  open: DockPane | undefined,
  lastTab: DockTab | undefined,
): DockPane | null => (open !== undefined ? null : (lastTab ?? DOCK_HOME));

export const dockTabTarget = (open: DockPane | undefined, tab: DockTab): DockTab | null =>
  open === tab ? null : tab;

/**
 * One thread's dock this session. `shown` is what the user left it on, and is
 * gone once they close it; `lastTab` is the last tab shown at all, and stays
 * while that tab is open; `openTabs` are the tabs opened, in opening order.
 */
export interface DockMemory {
  readonly shown?: DockPane | undefined;
  readonly lastTab?: DockTab | undefined;
  readonly openTabs?: ReadonlyArray<DockTab> | undefined;
}

const NO_TABS: ReadonlyArray<DockTab> = [];

/** `open` with `pane` added at the end when it is a tab not in it yet; else `open` itself. */
const withOpenTab = (
  open: ReadonlyArray<DockTab> | undefined,
  pane: DockPane | null | undefined,
): ReadonlyArray<DockTab> | undefined =>
  isDockTab(pane) && !(open ?? NO_TABS).includes(pane) ? [...(open ?? NO_TABS), pane] : open;

/** The user moved the dock to `pane` (`null` closes it). */
export const rememberDockMove = (
  memory: DockMemory | undefined,
  pane: DockPane | null,
): DockMemory => ({
  shown: pane ?? undefined,
  lastTab: isDockTab(pane) ? pane : memory?.lastTab,
  openTabs: withOpenTab(memory?.openTabs, pane),
});

/**
 * The dock is showing `pane`, whoever put it there — a link to a turn's
 * changes, the browser opening itself for the agent. The tab joins the open
 * tabs and becomes the last tab; reopening on arrival is only for what the
 * user chose. Returns `memory` itself when nothing changes.
 */
export const noteDockShown = (
  memory: DockMemory | undefined,
  pane: DockPane | undefined,
): DockMemory | undefined => {
  if (!isDockTab(pane)) {
    return memory;
  }
  const openTabs = withOpenTab(memory?.openTabs, pane);
  return memory?.lastTab === pane && openTabs === memory.openTabs
    ? memory
    : { ...memory, lastTab: pane, openTabs };
};

/**
 * The tabs the strip shows: the open tabs, and `pane` after them when it is a
 * tab the memory has not caught up with yet (the memory is written after the
 * render that shows it).
 */
export const dockStripTabs = (
  memory: DockMemory | undefined,
  pane: DockPane | undefined,
): ReadonlyArray<DockTab> => withOpenTab(memory?.openTabs, pane) ?? NO_TABS;

/** The kinds in `offered` that are not in `open`, in `offered`'s order. */
export const unopenedDockTabs = (
  offered: ReadonlyArray<DockTab>,
  open: ReadonlyArray<DockTab>,
): ReadonlyArray<DockTab> => offered.filter((tab) => !open.includes(tab));

/**
 * Closes `tab` in a dock showing `pane`. Closing the tab on show moves to its
 * right neighbour, else its left, else the launcher; closing another tab
 * leaves the pane alone. `lastTab` becomes the tab now shown, else stays when
 * still open, else falls to the last open tab or nothing.
 */
export const closeDockTab = (
  memory: DockMemory | undefined,
  tab: DockTab,
  pane: DockPane,
): { readonly memory: DockMemory; readonly pane: DockPane } => {
  const open = dockStripTabs(memory, pane);
  const index = open.indexOf(tab);
  if (index === -1) {
    return { memory: memory ?? {}, pane };
  }
  const openTabs = open.filter((each) => each !== tab);
  const next = pane === tab ? (open[index + 1] ?? open[index - 1] ?? DOCK_HOME) : pane;
  const lastTab = isDockTab(next)
    ? next
    : memory?.lastTab !== undefined && openTabs.includes(memory.lastTab)
      ? memory.lastTab
      : openTabs.at(-1);
  return { memory: { shown: next, lastTab, openTabs }, pane: next };
};

/** Where arriving at a thread with no `?pane=` puts its dock; `undefined` leaves it shut. */
export const dockArrivalTarget = (memory: DockMemory | undefined): DockPane | undefined =>
  memory?.shown;

/**
 * The tab `step` places from `from` along a strip of `tabs`, wrapping at
 * either end. The launcher selects no tab, but the strip's one Tab stop is
 * then its first tab, so the arrows step from there: Right to the second, Left
 * round to the last — the same as from a selected first tab. A tab the strip
 * does not hold steps from its first tab too.
 */
export const adjacentDockTab = (
  from: DockPane,
  step: 1 | -1,
  tabs: ReadonlyArray<DockTab> = dockTabs,
): DockTab => {
  const index = isDockTab(from) ? Math.max(0, tabs.indexOf(from)) : 0;
  return tabs[(index + step + tabs.length) % tabs.length] as DockTab;
};
