/**
 * The confirmation before an edited message restores the workspace and is
 * resent (`./use-edit-resend`). It says what the composer's banner says —
 * what is undone and what stays — plus what a restore always costs, since it
 * rewrites the worktree just as "Restore to here" does. Its own dialog rather
 * than the Changes pane's restore dialog: that one dispatches a bare restore,
 * and this one carries the message with it.
 */

import { Button } from "@poseidon/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@poseidon/ui/components/dialog";

import type { EditCopy } from "@/components/composer/edit-resend";
import type { EditResend } from "@/components/composer/use-edit-resend";
import { DialogActions } from "@/components/dialog-actions";

export function EditResendDialog({
  copy,
  dialog,
}: {
  readonly copy: EditCopy;
  readonly dialog: EditResend["dialog"];
}) {
  return (
    <Dialog open={dialog.open} onOpenChange={dialog.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore and resend?</DialogTitle>
          <DialogDescription>{copy.summary}</DialogDescription>
        </DialogHeader>
        {copy.skippedNote === null ? null : (
          <p className="type-body text-muted-foreground">{copy.skippedNote}</p>
        )}
        <p className="type-micro text-muted-foreground">
          Every tracked file returns to that checkpoint and files created since are removed.
          Uncommitted work that is not in a checkpoint is lost. If git refuses the restore, nothing
          is sent and the message comes back to the composer.
        </p>
        {dialog.error === null ? null : (
          <p role="alert" className="type-body text-destructive">
            {dialog.error}
          </p>
        )}
        <DialogActions>
          <Button
            type="button"
            variant="ghost"
            disabled={dialog.pending}
            onClick={() => dialog.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" disabled={dialog.pending} onClick={dialog.confirm}>
            {dialog.pending ? "Sending…" : "Restore and send"}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
