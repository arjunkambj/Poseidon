/**
 * The "+" after the dock's tabs: a menu of the kinds this dock offers that are
 * not open yet, each with its icon, name and key. Picking one opens it — the
 * same move as its key or a launcher row, so it joins the strip at the end and
 * becomes the active tab.
 *
 * It shows only while some tab is open (the launcher lists every kind when
 * none is) and some offered kind is not. Like the strip, it reads nothing: the
 * tab loads what it shows once it opens.
 */

import { Button } from "@poseidon/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@poseidon/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { CommandKbd } from "@/lib/shortcuts";
import { Add } from "@honeyicons/react";

import { DOCK_TAB_META } from "./dock-tab-meta";
import { unopenedDockTabs, type DockTab } from "./dock-toggle";

export function DockAddTabMenu({
  offeredTabs,
  openTabs,
  onOpen,
}: {
  /** The kinds this dock offers, in registry order. */
  offeredTabs: ReadonlyArray<DockTab>;
  /** The tabs open in the strip. */
  openTabs: ReadonlyArray<DockTab>;
  /** Open this tab. */
  onOpen: (tab: DockTab) => void;
}) {
  const unopened = unopenedDockTabs(offeredTabs, openTabs);
  if (openTabs.length === 0 || unopened.length === 0) {
    return null;
  }
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  tone="muted"
                  size="icon-sm"
                  aria-label="Open a tab"
                  className="shrink-0"
                />
              }
            />
          }
        >
          <Add variant="bold" />
        </TooltipTrigger>
        <TooltipContent>Open a tab</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-48">
        {unopened.map((tab) => {
          const meta = DOCK_TAB_META[tab];
          return (
            <DropdownMenuItem key={tab} onClick={() => onOpen(tab)}>
              <meta.icon variant="bold" />
              {meta.label}
              <DropdownMenuShortcut>
                <CommandKbd command={meta.command} />
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
