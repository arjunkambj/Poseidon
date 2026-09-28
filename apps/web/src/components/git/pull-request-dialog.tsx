/**
 * The pull request's title and body, asked for when "Commit, push & create
 * PR" has nothing to commit — the branch is already committed (and maybe
 * pushed), so there is no commit message to take them from. When the same
 * run commits, the control takes the title and body from the commit message
 * instead and this dialog never opens.
 *
 * Mounted fresh (a new `key`) for each opening, like the commit dialog.
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
import { Input } from "@poseidon/ui/components/input";
import { Label } from "@poseidon/ui/components/label";
import { Textarea } from "@poseidon/ui/components/textarea";

import { DialogActions } from "@/components/dialog-actions";
import { DialogBody } from "@/components/dialog-body";

export function PullRequestDialog({
  open,
  onOpenChange,
  actionLabel,
  initialTitle,
  branch,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly actionLabel: string;
  readonly initialTitle: string;
  readonly branch: string | null;
  readonly onSubmit: (pullRequest: { readonly title: string; readonly body: string }) => void;
}) {
  const [title, setTitle] = React.useState(initialTitle);
  const [body, setBody] = React.useState("");
  const canSubmit = title.trim() !== "";

  const submit = () => {
    if (!canSubmit) {
      return;
    }
    onOpenChange(false);
    onSubmit({ title: title.trim(), body: body.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create pull request</DialogTitle>
          <DialogDescription>
            {branch === null
              ? "Nothing to commit. Opens a pull request for the current branch with the GitHub CLI."
              : `Nothing to commit. Opens a pull request for ${branch} with the GitHub CLI.`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogBody className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pull-request-title">Title</Label>
              <Input
                id="pull-request-title"
                value={title}
                autoFocus
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pull-request-body">Description</Label>
              <Textarea
                id="pull-request-body"
                value={body}
                rows={5}
                className="max-h-48 overflow-y-auto"
                onChange={(event) => setBody(event.target.value)}
              />
            </div>
          </DialogBody>
          <DialogActions>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {actionLabel}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}
