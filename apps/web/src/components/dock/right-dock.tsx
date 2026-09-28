/**
 * The right dock: a resizable panel showing the tabs opened in it — kinds
 * from a small registry (Changes, Browser, Files, Pull request today) — and a launcher for
 * when it is open with no tab chosen.
 *
 * It docks beside a thread, or beside the New task page for the picked
 * project (`DockScope`). A project has no thread yet, so its dock offers
 * only the kinds available there (`dockTabsFor`) — Changes over the project
 * folder's own working tree and branch (`ProjectChangesPane`), and Files
 * searching that folder — and no Browser, which is a thread's browser. A
 * thread's dock offers Pull request only once its branch has one
 * (`offeredDockTabs`).
 *
 * The dock is a shell — the tab strip, the drag-to-resize edge and the panel
 * chrome live here; what each tab renders is its own concern, registered per
 * kind (`./dock-tab-meta` for name, icon, key and availability,
 * `./dock-tab-panes` for the pane). What it shows
 * is not component state: it travels in the route's `?pane=` search param — a
 * tab, or `home` for the launcher — so a reload lands on the same view ("pane
 * state in atoms and search params"). The rules for where the keys and buttons
 * take it, and what it remembers per thread (or project), are the pure half in
 * `./dock-toggle`, bound to the view by `./use-dock-state`. Width persists through `dockWidthAtom`
 * (localStorage) — that is presentation, not durable state.
 *
 * The dock starts closed, and opening it without naming a tab (`dock.toggle`,
 * the header's dock button) goes back to the last tab this thread used this
 * session, else to the launcher (`./dock-launcher`): one row per tab with its
 * key, so opening the dock never drops the user into a tab they did not ask
 * for. The launcher reads nothing, so an open dock loads nothing until a tab
 * is picked.
 *
 * The strip (`./dock-tab-strip`) holds only the tabs opened in this thread
 * (or project) this session, in opening order (`openTabs`), each with a close
 * button; closing the last shows the launcher again, with the dock still
 * open. It is a `tablist`: each tab controls the panel below it, and Left and
 * Right move along the open tabs (and open the tab they land on). Only the
 * active tab's pane is mounted; a closed tab is hidden exactly as switching
 * away from it hides it. A "+" after the tabs (`./dock-add-tab-menu`) opens
 * any kind this dock offers that is not open yet.
 *
 * With less than 640px beside the sidebar, the dock overlays the thread
 * column: two columns in that width leave neither readable, and simply
 * hiding the dock (what this used to do) made the changes, browser and files
 * tabs unreachable on a narrow window with no hint that they existed. The
 * resize edge is the one part that stays behind — there is nothing to resize
 * when the panel is already full width.
 *
 * The resize edge is a focusable `separator` whose value is the width: drag
 * it, or focus it and use Left/Right (Shift for bigger steps, `./dock-resize`);
 * a double-click puts the default width back.
 *
 * Each tab has a key (`dock.changes`, `browserPane.toggle`, `dock.files`) and
 * the dock one (`dock.toggle`); `ThreadView` answers them — the New task page
 * all but the Browser's — and the tab and close tooltips show the chords. Opening Files from its key focuses the
 * Files search (`focusFilesSearch`), and opening the dock onto the launcher
 * focuses its first row (`focusLauncher`) — only then, so a dock that
 * reopens on arrival or a reload never takes the focus from the thread. The
 * Files tab keeps its search, open file and scroll per thread or project
 * (`@/components/panes/files/files-view`), so it is unmounted like the others
 * when another tab shows and still comes back as it was left.
 *
 * Opening, the dock grows in from the right edge, and closing it shrinks back
 * (`@/lib/use-presence`, which keeps it mounted until it is gone); overlaid on
 * a narrow row, it slides in and out instead. It eases only while it opens or
 * closes, so dragging its edge still tracks the pointer.
 */

import * as React from "react";

import { useThreadHasPullRequest } from "@/components/panes/pull-request/use-thread-pull-request";
import type { Presence } from "@/lib/use-presence";
import { cn } from "@/lib/utils";
import { useConnectionState } from "@/state/hooks";
import {
  DOCK_WIDTH_MAX_FRACTION,
  THREAD_COLUMN_MIN,
  dockWidthBounds,
  useDockWidth,
} from "@/state/ui";

import { DockAddTabMenu } from "./dock-add-tab-menu";
import { DockLauncher } from "./dock-launcher";
import { dockWidthForKey } from "./dock-resize";
import { dockScopeKind, type DockScope } from "./dock-scope";
import { DockTabStrip, dockPanelId, dockTabId } from "./dock-tab-strip";
import { offeredDockTabs } from "./dock-tab-meta";
import { DOCK_TAB_PANES } from "./dock-tab-panes";
import { DOCK_HOME, isDockTab, type DockPane, type DockTab } from "./dock-toggle";

export type { DockScope } from "./dock-scope";

/**
 * The resize edge: drag it, or focus it and use the arrow keys, and
 * double-click it for the default width. The width atom persists every change.
 */
function useDockResize() {
  const [width, setWidth, resetWidth] = useDockWidth();
  const edge = React.useRef<HTMLDivElement>(null);
  // The width of the row the dock sits in, for the separator's bounds.
  const [available, setAvailable] = React.useState<number | null>(null);
  React.useEffect(() => {
    const row = edge.current?.parentElement?.parentElement;
    if (row === null || row === undefined) {
      return;
    }
    const observer = new ResizeObserver(() => setAvailable(row.getBoundingClientRect().width));
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  const bounds = available === null ? null : dockWidthBounds(available);
  // What is on screen: the CSS bound may be holding the stored width back on
  // a window narrower than the one it was set in.
  const shown = bounds === null ? width : Math.min(width, bounds.max);

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const dock = event.currentTarget.parentElement;
      const startWidth = dock?.getBoundingClientRect().width ?? width;
      const row = dock?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
      const onMove = (move: PointerEvent) => {
        // The dock sits on the right: dragging left widens it.
        setWidth(startWidth + (startX - move.clientX), row);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width, setWidth],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (available === null || bounds === null) {
      return;
    }
    const next = dockWidthForKey(event.key, event.shiftKey, shown, bounds);
    if (next !== null) {
      event.preventDefault();
      setWidth(next, available);
    }
  };

  return { width, shown, bounds, edge, onPointerDown, onKeyDown, onDoubleClick: resetWidth };
}

export function RightDock({
  pane,
  phase,
  onPaneChange,
  openTabs,
  onCloseTab,
  scope,
  focusFilesSearch = false,
  onFilesSearchFocused,
  focusLauncher = false,
  onLauncherFocused,
}: {
  pane: DockPane;
  phase: Presence;
  onPaneChange: (pane: DockPane | null) => void;
  /** The tabs opened here this session, in opening order. */
  openTabs: ReadonlyArray<DockTab>;
  /** Close this tab; the dock stays open. */
  onCloseTab: (tab: DockTab) => void;
  scope: DockScope;
  /** Focus the Files search as the Files tab mounts — set by its key. */
  focusFilesSearch?: boolean;
  onFilesSearchFocused?: () => void;
  /** Focus the launcher's first row — set when the user opens the dock onto it. */
  focusLauncher?: boolean;
  onLauncherFocused?: () => void;
}) {
  const resize = useDockResize();
  const connection = useConnectionState();
  const baseId = React.useId();
  const onPick = React.useCallback((tab: DockTab) => onPaneChange(tab), [onPaneChange]);
  // A tab opened from the "+" menu, for the strip to focus once it shows.
  const [focusTab, setFocusTab] = React.useState<DockTab | null>(null);
  const onAddTab = React.useCallback(
    (tab: DockTab) => {
      setFocusTab(tab);
      onPaneChange(tab);
    },
    [onPaneChange],
  );
  const onTabFocused = React.useCallback(() => setFocusTab(null), []);
  const snapshot = "snapshot" in scope ? scope.snapshot : null;
  const projectId = "snapshot" in scope ? scope.snapshot.projectId : scope.projectId;
  // Pull request only once the branch has one; an open tab stays in the strip.
  const hasPullRequest = useThreadHasPullRequest(projectId, snapshot?.threadId ?? null);
  const tabs = offeredDockTabs(dockScopeKind(scope), hasPullRequest);

  return (
    <aside
      aria-label={snapshot === null ? "Project dock" : "Thread dock"}
      data-font-scope="sidebar"
      inert={phase === "leaving"}
      className={cn(
        // Split only when the row fits a 360px thread and a 280px dock.
        "absolute inset-0 z-20 flex min-h-0 w-full border-l border-border bg-sidebar [&_svg:not([class*='text-'],[class*='opacity-'])]:opacity-80",
        "@min-[640px]/thread:relative @min-[640px]/thread:inset-auto @min-[640px]/thread:z-auto @min-[640px]/thread:w-(--dock-width) @min-[640px]/thread:shrink-0",
        phase !== "shown" &&
          "overflow-hidden transition-all duration-200 ease-out motion-reduce:transition-none",
        phase === "entering" &&
          "starting:translate-x-full @min-[640px]/thread:starting:w-0 @min-[640px]/thread:starting:translate-x-0",
        phase === "leaving" &&
          "translate-x-full @min-[640px]/thread:w-0 @min-[640px]/thread:translate-x-0",
      )}
      style={
        {
          "--dock-width": `min(${resize.width}px, ${DOCK_WIDTH_MAX_FRACTION * 100}%, calc(100% - ${THREAD_COLUMN_MIN}px))`,
        } as React.CSSProperties
      }
    >
      <div
        ref={resize.edge}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize dock"
        aria-valuenow={Math.round(resize.shown)}
        aria-valuemin={resize.bounds?.min}
        aria-valuemax={resize.bounds?.max}
        onPointerDown={resize.onPointerDown}
        onKeyDown={resize.onKeyDown}
        onDoubleClick={resize.onDoubleClick}
        className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize outline-none focus-visible:bg-ring/50 @min-[640px]/thread:block"
      />
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          // While the width eases, hold the content at the dock's floor so it
          // is uncovered rather than squeezed.
          phase !== "shown" && "min-w-70",
        )}
      >
        <DockTabStrip
          baseId={baseId}
          openTabs={openTabs}
          pane={pane}
          onTabChange={onPaneChange}
          onCloseTab={onCloseTab}
          focusTab={focusTab}
          onTabFocused={onTabFocused}
        >
          <DockAddTabMenu offeredTabs={tabs} openTabs={openTabs} onOpen={onAddTab} />
        </DockTabStrip>
        <div
          id={dockPanelId(baseId)}
          role={isDockTab(pane) ? "tabpanel" : undefined}
          aria-labelledby={isDockTab(pane) ? dockTabId(baseId, pane) : undefined}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {pane === DOCK_HOME ? (
            <DockLauncher
              tabs={tabs}
              onPick={onPick}
              focusFirst={focusLauncher}
              onFocused={onLauncherFocused}
            />
          ) : null}
          {isDockTab(pane)
            ? DOCK_TAB_PANES[pane]({
                scope,
                snapshot,
                projectId,
                connected: connection.status === "connected",
                focusFilesSearch,
                onFilesSearchFocused,
              })
            : null}
        </div>
      </div>
    </aside>
  );
}
