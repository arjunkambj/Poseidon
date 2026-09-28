/**
 * The dock's tab kinds: what each is called, its icon, the key that opens it,
 * and which docks offer it — shared by the tab strip, the launcher's rows and
 * their tooltips, so they never drift apart. What each kind renders is in
 * `./dock-tab-panes`; this half stays free of the panes so route validation
 * and node tests can read it cheaply.
 *
 * Adding a dock tab kind:
 * 1. add its id to `DOCK_TABS` in `./dock-toggle` (the order there is the
 *    registry's order: the launcher's rows and the "Open a tab" menu);
 * 2. add an entry here in `DOCK_TAB_META` — `icon` (a Honeyicons export),
 *    `label`, `command` (the catalog command that opens it) and `available`
 *    (which dock scopes offer it);
 * 3. add its renderer to `DOCK_TAB_PANES` in `./dock-tab-panes`;
 * 4. if `available("project")` is true, add its id to `projectDockTabs` in
 *    `./dock-toggle` too — the New task route checks `?pane=` against that
 *    list, and a test holds it equal to the project's kinds here;
 * 5. if it has a chord, add the command to the command catalog — it must pass
 *    the default-collision test — and answer it where the other dock keys are.
 *
 * Both maps are `Record<DockTab, …>`, so the compiler refuses a kind that is
 * missing from either; `projectDockTabs` is a plain list, kept in step by the
 * registry test instead. The strip, launcher and dock need no change.
 */

import { type HoneyIcon, Bot, Folder, GitDiff, Globe } from "@honeyicons/react";

import type { DockScopeKind } from "./dock-scope";
import { dockTabs, type DockTab } from "./dock-toggle";

export interface DockTabMeta {
  readonly icon: HoneyIcon;
  readonly label: string;
  /** The catalog command that opens this tab; its chord shows in tooltips. */
  readonly command: string;
  /** Whether a dock beside this kind of scope offers the tab. */
  readonly available: (scope: DockScopeKind) => boolean;
}

const always = () => true;

export const DOCK_TAB_META: Record<DockTab, DockTabMeta> = {
  changes: { icon: GitDiff, label: "Changes", command: "dock.changes", available: always },
  // A thread's browser: there is none before the thread exists.
  browser: {
    icon: Globe,
    label: "Browser",
    command: "browserPane.toggle",
    available: (scope) => scope === "thread",
  },
  files: { icon: Folder, label: "Files", command: "dock.files", available: always },
  // A thread's subagents, from its snapshot's task rows.
  agents: {
    icon: Bot,
    label: "Agents",
    command: "dock.agents",
    available: (scope) => scope === "thread",
  },
};

/** The tab kinds a dock beside this kind of scope offers, in registry order. */
export const dockTabsFor = (scope: DockScopeKind): ReadonlyArray<DockTab> =>
  dockTabs.filter((tab) => DOCK_TAB_META[tab].available(scope));
