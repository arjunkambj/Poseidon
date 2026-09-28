/**
 * The "…" menu at the end of a queued-message row: steer it into the running
 * turn, take it back into the composer to edit, or remove it. What each item
 * does lives in `./use-queue-actions`; this decides which items a row offers.
 *
 * "Steer now" is only there while a turn is running on a session that steers
 * (`canSteer`) — otherwise there is nothing to steer into. "Edit" is shown but
 * disabled for a message with images, which cannot go back into the composer.
 */

import { Button } from "@poseidon/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@poseidon/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { QueuedMessage } from "@poseidon/contracts/orchestration";

import { canEditQueued } from "@/components/composer/use-queue-actions";
import { Edit, MoreHorizontal, Send, Trash } from "@honeyicons/react";

export type QueueRowAction = "steer" | "edit" | "remove";

export interface QueueRowItem {
  readonly action: QueueRowAction;
  readonly label: string;
  readonly disabled: boolean;
}

/** The items a row's menu offers, in order. */
export const queueRowItems = (steerable: boolean, message: QueuedMessage): QueueRowItem[] => {
  const editable = canEditQueued(message);
  return [
    ...(steerable ? [{ action: "steer" as const, label: "Steer now", disabled: false }] : []),
    { action: "edit", label: editable ? "Edit" : "Edit (has images)", disabled: !editable },
    { action: "remove", label: "Remove", disabled: false },
  ];
};

const ICONS = { steer: Send, edit: Edit, remove: Trash } as const;

export function QueueRowMenu({
  position,
  message,
  steerable,
  disabled,
  onAction,
}: {
  /** The row's 1-based place in the queue, for the trigger's label. */
  readonly position: number;
  readonly message: QueuedMessage;
  readonly steerable: boolean;
  readonly disabled: boolean;
  readonly onAction: (action: QueueRowAction) => void;
}) {
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
                  className="shrink-0"
                  aria-label={`Actions for queued message ${position}`}
                  disabled={disabled}
                />
              }
            />
          }
        >
          <MoreHorizontal variant="bold" />
        </TooltipTrigger>
        <TooltipContent>More</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-44">
        {queueRowItems(steerable, message).map((item) => {
          const Icon = ICONS[item.action];
          return (
            <DropdownMenuItem
              key={item.action}
              variant={item.action === "remove" ? "destructive" : "default"}
              disabled={disabled || item.disabled}
              onClick={() => onAction(item.action)}
            >
              <Icon variant="bold" />
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
