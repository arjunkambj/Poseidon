/**
 * "Fork from here" under a user message: opens the fork dialog
 * (`@/components/thread/branch-off-dialog`) for a new thread that starts with
 * the conversation through the end of this message's turn.
 *
 * Left out outside a timeline, as Restore is. While the message's turn is
 * still running, or the server is out of reach, it is disabled and says why;
 * it keeps its focus stop then (`aria-disabled`), so the keyboard reaches the
 * reason too.
 */

import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import * as React from "react";

import { forkBlockedReason } from "@/components/thread/branch-off";
import { useRequestBranchOff } from "@/components/thread/use-branch-off";
import { useTimelineThread } from "@/components/timeline/thread-context";
import { cn } from "@/lib/utils";
import { GitFork } from "@honeyicons/react";

export function ForkFromMessage({ item }: { readonly item: ItemSnapshot }) {
  const thread = useTimelineThread();
  const requestBranchOff = useRequestBranchOff();
  const reasonId = React.useId();
  if (thread === null) {
    return null;
  }
  const blocked = forkBlockedReason({
    connected: thread.connected !== false,
    runningTurnId: thread.runningTurnId ?? null,
    turnId: item.turnId,
  });
  return (
    // Dimmed by its wrapper while disabled: the button is `aria-disabled`,
    // not natively disabled, so its own disabled look does not apply.
    <span className={cn("inline-flex", blocked !== null && "opacity-50")}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              tone="muted"
              size="icon-xs"
              aria-label="Fork from this message"
              disabled={blocked !== null}
              focusableWhenDisabled
              aria-describedby={blocked === null ? undefined : reasonId}
              onClick={() =>
                requestBranchOff({ threadId: thread.threadId, throughItemId: item.itemId })
              }
            />
          }
        >
          <GitFork variant="bold" />
        </TooltipTrigger>
        <TooltipContent>{blocked ?? "Fork from here"}</TooltipContent>
      </Tooltip>
      {blocked === null ? null : (
        <span id={reasonId} className="sr-only">
          {blocked}
        </span>
      )}
    </span>
  );
}
