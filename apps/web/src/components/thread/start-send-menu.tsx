/**
 * The chevron beside New task's send button: other ways to start the task.
 * Its one item, "Start in background", is `composer.startInBackground`, so it
 * shows that command's keys. It is disabled whenever the send button is, and
 * closing the menu puts the focus back in the composer for the next task.
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
import type * as React from "react";

import { CommandKbd } from "@/lib/shortcuts";

import { ChevronDown, Rocket } from "@honeyicons/react";

export function StartSendMenu({
  disabled,
  onStartInBackground,
  returnFocus,
}: {
  readonly disabled: boolean;
  readonly onStartInBackground: () => void;
  /** Where the focus goes when the menu closes: the composer's textarea. */
  readonly returnFocus: React.RefObject<HTMLTextAreaElement | null>;
}) {
  // Once the menu has finished closing: the item keeps the focus while it
  // fades out, so moving it any earlier does not hold.
  const onOpenChangeComplete = (open: boolean) => {
    if (!open) {
      returnFocus.current?.focus();
    }
  };
  return (
    <DropdownMenu onOpenChangeComplete={onOpenChangeComplete}>
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
                  className="order-2 shrink-0"
                  aria-label="More ways to start"
                  disabled={disabled}
                />
              }
            />
          }
        >
          <ChevronDown variant="bold" />
        </TooltipTrigger>
        <TooltipContent>More ways to start</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="top" className="w-auto">
        <DropdownMenuItem disabled={disabled} onClick={onStartInBackground}>
          <Rocket variant="bold" />
          Start in background
          <DropdownMenuShortcut>
            <CommandKbd command="composer.startInBackground" />
          </DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
