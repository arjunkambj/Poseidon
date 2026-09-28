/**
 * What a plan offers besides its answers, on the pending card and on the
 * timeline's record of it: three icon buttons, each with its tooltip.
 *
 * - **Implement in new thread** opens the branch-off dialog
 *   (`@/components/thread/branch-off-dialog`) for a new thread in the same
 *   project, here or in a new worktree, whose first message is the plan.
 *   From the pending card (`handoffTurnId`) the plan is then answered
 *   `handoff`, so the card closes without running it in this thread.
 * - **Copy** puts the plan's Markdown on the clipboard.
 * - **Save as .md** writes it to a new file in the thread's workspace
 *   (`./save-plan-dialog`).
 *
 * Copy comes first, since it always works. Implement and Save need the
 * server; offline they are disabled and say why. Outside a thread the thread
 * list knows (a row rendered on its own) only Copy is offered.
 */

import * as React from "react";

import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { ThreadId, TurnId } from "@poseidon/contracts/ids";
import type { HoneyIcon } from "@honeyicons/react";

import { SavePlanDialog } from "@/components/approvals/save-plan-dialog";
import { CopyButton } from "@/components/copy-button";
import { useRequestBranchOff } from "@/components/thread/use-branch-off";
import { cn } from "@/lib/utils";
import { useConnectionState, useThreadList } from "@/state/hooks";
import { GitBranch, Save } from "@honeyicons/react";

const OFFLINE = "Not connected to the server.";

function PlanActionButton({
  icon: Glyph,
  label,
  blocked,
  onClick,
}: {
  readonly icon: HoneyIcon;
  readonly label: string;
  /** Why the action cannot run now, else `null`. */
  readonly blocked: string | null;
  readonly onClick: () => void;
}) {
  const reasonId = React.useId();
  return (
    // Dimmed by its wrapper while disabled: the button keeps its focus stop
    // (`aria-disabled`), so the keyboard reaches the reason too.
    <span className={cn("inline-flex", blocked !== null && "opacity-50")}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              tone="muted"
              size="icon-xs"
              aria-label={label}
              disabled={blocked !== null}
              focusableWhenDisabled
              aria-describedby={blocked === null ? undefined : reasonId}
              onClick={onClick}
            />
          }
        >
          <Glyph variant="bold" />
        </TooltipTrigger>
        <TooltipContent>{blocked ?? label}</TooltipContent>
      </Tooltip>
      {blocked === null ? null : (
        <span id={reasonId} className="sr-only">
          {blocked}
        </span>
      )}
    </span>
  );
}

/** Implement and Save, for a plan whose thread the list knows. */
function ThreadPlanActions({
  threadId,
  markdown,
  handoffTurnId,
}: {
  readonly threadId: ThreadId;
  readonly markdown: string;
  readonly handoffTurnId: TurnId | undefined;
}) {
  const requestBranchOff = useRequestBranchOff();
  const connected = useConnectionState().status === "connected";
  const source = useThreadList().find((thread) => thread.threadId === threadId);
  const [saving, setSaving] = React.useState(false);
  if (source === undefined) {
    return null;
  }
  const blocked = connected ? null : OFFLINE;
  return (
    <>
      <PlanActionButton
        icon={GitBranch}
        label="Implement in new thread"
        blocked={blocked}
        onClick={() =>
          requestBranchOff({
            threadId,
            plan: { markdown, ...(handoffTurnId === undefined ? {} : { handoffTurnId }) },
          })
        }
      />
      <PlanActionButton
        icon={Save}
        label="Save as .md"
        blocked={blocked}
        onClick={() => setSaving(true)}
      />
      <SavePlanDialog
        open={saving}
        onOpenChange={setSaving}
        projectId={source.projectId}
        threadId={threadId}
        markdown={markdown}
      />
    </>
  );
}

export function PlanActions({
  threadId,
  markdown,
  handoffTurnId,
  className,
}: {
  /** The plan's thread; `null` outside one, which leaves only Copy. */
  readonly threadId: ThreadId | null;
  readonly markdown: string;
  /** The pending plan's turn, answered `handoff` once the new thread exists. */
  readonly handoffTurnId?: TurnId;
  readonly className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <CopyButton text={markdown} label="Copy plan" tooltip="Copy plan" tone="muted" />
      {threadId === null ? null : (
        <ThreadPlanActions threadId={threadId} markdown={markdown} handoffTurnId={handoffTurnId} />
      )}
    </div>
  );
}
