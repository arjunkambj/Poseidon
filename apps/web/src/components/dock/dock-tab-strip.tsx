/**
 * The dock's top row: the tabs opened in this thread (or project), and the
 * close button.
 *
 * The strip holds only the tabs the user has opened here this session, in the
 * order they were opened (`openTabs`, from `dockStripTabs`) — never every kind
 * the dock offers. With none open the launcher lists them all, and the row
 * holds the close button and nothing else. Each tab is its icon and a short
 * name, with its key in the tooltip.
 *
 * Each tab has its own close button beside it — a sibling, never inside the
 * tab — shown on hover or focus and always on the active tab. A middle-click
 * on a tab, or a bare Delete or Backspace while it has the focus, closes it
 * too; with a modifier held the key is left to the app's chords.
 * Closing the active tab opens its right neighbour, else its left, else the
 * launcher (`closeDockTab`); the dock stays open either way, and the focus
 * goes to the tab that is now active.
 *
 * A `tablist` in the ARIA sense: each tab names the one panel below it
 * (`aria-controls`), a `tabpanel` that names the selected tab back. Only the
 * selected tab (the first, on the launcher) is in the Tab order, and
 * Left/Right move along the open tabs from the focused one, wrapping, opening
 * the tab they land on and keeping the focus on it (`adjacentDockTab`).
 *
 * After the tabs sits whatever the dock puts there (`children`) — the "+"
 * menu of the kinds not open yet.
 *
 * The strip reads nothing of its own: a tab's content loads when it opens.
 */

import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import * as React from "react";

import { CommandKbd } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { Close as CloseIcon } from "@honeyicons/react";

import { DOCK_TAB_META } from "./dock-tab-meta";
import {
  adjacentDockTab,
  dockTabKeyAction,
  isDockTab,
  type DockPane,
  type DockTab,
} from "./dock-toggle";

/** The ids that tie each tab to the dock's one panel. */
export const dockTabId = (baseId: string, tab: DockTab) => `${baseId}-tab-${tab}`;
export const dockPanelId = (baseId: string) => `${baseId}-panel`;

function DockTabButton({
  baseId,
  tab,
  active,
  tabStop,
  onSelect,
  onClose,
}: {
  baseId: string;
  tab: DockTab;
  active: boolean;
  /** Whether this tab is the strip's one Tab stop. */
  tabStop: boolean;
  onSelect: (tab: DockTab) => void;
  onClose: (tab: DockTab) => void;
}) {
  const meta = DOCK_TAB_META[tab];
  return (
    <div className="group/dock-tab flex min-w-0 shrink-0 items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              role="tab"
              id={dockTabId(baseId, tab)}
              data-dock-tab={tab}
              aria-selected={active}
              aria-controls={dockPanelId(baseId)}
              tabIndex={tabStop ? 0 : -1}
              variant={active ? "secondary" : "ghost"}
              tone={active ? "default" : "muted"}
              size="sm"
              className="min-w-0"
              onClick={() => onSelect(tab)}
              onMouseDown={(event) => {
                // A middle press would start the browser's autoscroll.
                if (event.button === 1) {
                  event.preventDefault();
                }
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onClose(tab);
                }
              }}
            />
          }
        >
          <meta.icon variant="bold" />
          <span className="truncate">{meta.label}</span>
        </TooltipTrigger>
        <TooltipContent>
          {meta.label}
          <CommandKbd command={meta.command} />
        </TooltipContent>
      </Tooltip>
      {/* Shown on hover or focus, and always on the active tab. */}
      <span
        className={cn(
          "flex transition-opacity duration-150 ease-out",
          !active &&
            "opacity-0 group-hover/dock-tab:opacity-100 group-focus-within/dock-tab:opacity-100",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                tone="muted"
                size="icon-xs"
                aria-label={`Close ${meta.label}`}
                tabIndex={active ? 0 : -1}
                onClick={() => onClose(tab)}
              />
            }
          >
            <CloseIcon variant="bold" />
          </TooltipTrigger>
          <TooltipContent>Close {meta.label}</TooltipContent>
        </Tooltip>
      </span>
    </div>
  );
}

export function DockTabStrip({
  baseId,
  openTabs,
  pane,
  onTabChange,
  onCloseTab,
  children,
}: {
  baseId: string;
  /** The tabs opened here this session, in opening order. */
  openTabs: ReadonlyArray<DockTab>;
  pane: DockPane;
  onTabChange: (pane: DockPane | null) => void;
  /** Close this tab; the dock stays open. */
  onCloseTab: (tab: DockTab) => void;
  /** What follows the tabs on the row, before the close button. */
  children?: React.ReactNode;
}) {
  const strip = React.useRef<HTMLDivElement>(null);
  // The tab just closed from the strip, until it has left it: the focus then
  // goes to the tab that is active.
  const closed = React.useRef<DockTab | null>(null);

  React.useEffect(() => {
    // Wait for the tab to leave, and for the route to reach the tab that
    // replaces it.
    if (
      closed.current === null ||
      openTabs.includes(closed.current) ||
      (isDockTab(pane) && !openTabs.includes(pane))
    ) {
      return;
    }
    closed.current = null;
    if (isDockTab(pane)) {
      strip.current?.querySelector<HTMLElement>(`[data-dock-tab="${pane}"]`)?.focus();
    }
  }, [openTabs, pane]);

  const close = (tab: DockTab) => {
    closed.current = tab;
    onCloseTab(tab);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Step from (or close) the tab that has the focus, which the keys may
    // have moved ahead of the route.
    // A modified key is a chord, never the strip's: it goes on to the app's
    // keybindings untouched.
    const action = dockTabKeyAction(event);
    const focused = (event.target as HTMLElement).getAttribute("data-dock-tab");
    if (action === "close") {
      if (isDockTab(focused)) {
        event.preventDefault();
        close(focused);
      }
      return;
    }
    const step = action;
    if (step === null || openTabs.length === 0) {
      return;
    }
    event.preventDefault();
    const next = adjacentDockTab(isDockTab(focused) ? focused : pane, step, openTabs);
    onTabChange(next);
    strip.current?.querySelector<HTMLElement>(`[data-dock-tab="${next}"]`)?.focus();
  };

  // On the launcher no tab is selected, and the first is the Tab stop.
  const tabStop = isDockTab(pane) && openTabs.includes(pane) ? pane : openTabs[0];

  return (
    <div className="flex h-11 shrink-0 items-center gap-0.5 px-2">
      {openTabs.length > 0 ? (
        <div
          ref={strip}
          role="tablist"
          aria-label="Dock tabs"
          aria-orientation="horizontal"
          onKeyDown={onKeyDown}
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
        >
          {openTabs.map((tab) => (
            <DockTabButton
              key={tab}
              baseId={baseId}
              tab={tab}
              active={tab === pane}
              tabStop={tab === tabStop}
              onSelect={onTabChange}
              onClose={close}
            />
          ))}
        </div>
      ) : null}
      {children}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close dock"
              className="ml-auto shrink-0"
              onClick={() => onTabChange(null)}
            />
          }
        >
          <CloseIcon variant="bold" />
        </TooltipTrigger>
        <TooltipContent>
          Close dock
          <CommandKbd command="dock.toggle" />
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
