/**
 * The one "are you sure" for a destructive action.
 *
 * `RestoreCheckpointDialog` set the precedent — an action that cannot be undone
 * does not happen on a single click — but the settings pages did not follow it:
 * the trash button on a connector card rewrote the settings document on the
 * spot, and so did the one on an MCP server row. There is no undo for either,
 * and a removed connector takes the session binding of every thread on it.
 *
 * Deliberately controlled and trigger-less. The callers are a card header, a
 * list row and an overflow menu, and a menu item that opens its own modal has
 * to render the dialog as a sibling anyway — so the trigger stays with the
 * caller and this owns nothing but the confirmation.
 */

import * as React from "react";

import { Button } from "@poseidon/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@poseidon/ui/components/dialog";

import { DialogActions } from "@/components/dialog-actions";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  /** What is lost, in the caller's own words. */
  readonly description: React.ReactNode;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  /** Anything the choice needs besides the words: a picker, a preview. */
  readonly children?: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogActions>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
