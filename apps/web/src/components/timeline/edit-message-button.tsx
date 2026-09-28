/**
 * "Edit and resend" under a user message: puts the message's text in the
 * composer and opens an edit there (`@/state/message-edit`), whose banner
 * says what sending will undo. Sending restores the workspace to before this
 * message — the point "Restore to here" goes to, worked out now from the
 * timeline's checkpoints — and resends (`composer/use-edit-resend`).
 *
 * A draft already in the composer is not thrown away on a click: it asks
 * first. The message's attachments are not carried over, and its skill and
 * plugin references are. Disabled, saying why, whenever a restore could not
 * start (`restoreBlockedReason`), like Restore; it keeps its focus stop then
 * (`aria-disabled`). Left out outside a timeline, and for a message with no
 * text to edit.
 */

import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import * as React from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { type TimelineThread, useTimelineThread } from "@/components/timeline/thread-context";
import { restorePointBefore } from "@/components/timeline/turn-checkpoints";
import { requestComposerFocus } from "@/lib/composer-focus";
import { useMessageEdit } from "@/state/message-edit";
import { cn } from "@/lib/utils";
import { useComposerDraft } from "@/state/ui";
import { Edit } from "@honeyicons/react";

export function EditMessageButton({
  item,
  steered,
}: {
  readonly item: ItemSnapshot;
  readonly steered: boolean;
}) {
  const thread = useTimelineThread();
  if (thread === null || (item.text ?? "").trim() === "") {
    return null;
  }
  return <EditButton thread={thread} item={item} steered={steered} />;
}

function EditButton({
  thread,
  item,
  steered,
}: {
  readonly thread: TimelineThread;
  readonly item: ItemSnapshot;
  readonly steered: boolean;
}) {
  const draft = useComposerDraft(thread.threadId);
  const { setEdit } = useMessageEdit(thread.threadId);
  const [confirming, setConfirming] = React.useState(false);
  const reasonId = React.useId();
  const text = item.text ?? "";
  const blocked = thread.restoreBlockedReason;

  const start = () => {
    setEdit({
      itemId: item.itemId,
      turnId: item.turnId,
      steered,
      text,
      point: restorePointBefore(item.turnId, thread.turnOrder, thread.checkpoints, thread.restores),
    });
    draft.setText(text);
    draft.setMentions([]);
    draft.setReferences(item.references ?? []);
    draft.setFiles([]);
    requestComposerFocus(thread.threadId);
  };
  const hasDraft =
    (draft.text.trim() !== "" && draft.text !== text) ||
    draft.mentions.length > 0 ||
    draft.files.length > 0;

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
              aria-label="Edit and resend this message"
              disabled={blocked !== null}
              focusableWhenDisabled
              aria-describedby={blocked === null ? undefined : reasonId}
              onClick={() => (hasDraft ? setConfirming(true) : start())}
            />
          }
        >
          <Edit variant="bold" />
        </TooltipTrigger>
        <TooltipContent>{blocked ?? "Edit and resend"}</TooltipContent>
      </Tooltip>
      {blocked === null ? null : (
        <span id={reasonId} className="sr-only">
          {blocked}
        </span>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Replace your draft?"
        description="The composer already has a message in it. Editing puts this message's text there instead, and the draft is discarded."
        confirmLabel="Replace"
        onConfirm={start}
      />
    </span>
  );
}
