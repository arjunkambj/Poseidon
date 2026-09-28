/**
 * "Save as .md" for a plan: one path field, relative to the thread's
 * workspace and prefilled from the plan's heading (`planFileName`), and Save.
 *
 * The write is `files.create`, which only ever creates a new `.md` file inside
 * the workspace; a path that is already taken comes back as the server's
 * "already exists" and is shown under the field, so the user picks another
 * name. On success the dialog closes with a "Saved <path>" toast. Nothing
 * else opens: the dock stays as it was.
 */

import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as React from "react";
import { toast } from "sonner";

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
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";

import { planFileName, planPathProblem } from "@/components/approvals/plan-export";
import { DialogActions } from "@/components/dialog-actions";
import { useFileAtoms } from "@/components/panes/files/file-atoms";
import { Spinner } from "@honeyicons/react";

/** The server's words for a failed save, else a plain fallback. */
const failureMessage = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "";
  const error = Cause.squash(exit.cause);
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : "The plan was not saved.";
};

function SavePlanForm({
  projectId,
  threadId,
  markdown,
  onClose,
}: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly markdown: string;
  readonly onClose: () => void;
}) {
  const registry = React.useContext(RegistryContext);
  const { createFile } = useFileAtoms();
  const [path, setPath] = React.useState(() => planFileName(markdown));
  const [saving, setSaving] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const problem = planPathProblem(path);
  const errorId = React.useId();
  const error = failure ?? (path.trim().length === 0 ? null : problem);

  const save = async () => {
    if (problem !== null || saving) return;
    setSaving(true);
    setFailure(null);
    const exit = await createFile(registry, {
      projectId,
      threadId,
      path: path.trim(),
      content: markdown.endsWith("\n") ? markdown : `${markdown}\n`,
    });
    setSaving(false);
    if (Exit.isSuccess(exit)) {
      toast.success(`Saved ${exit.value.path}`);
      onClose();
    } else {
      setFailure(failureMessage(exit));
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="plan-path">File</Label>
        <Input
          id="plan-path"
          value={path}
          autoFocus
          spellCheck={false}
          disabled={saving}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          onChange={(event) => {
            setPath(event.target.value);
            setFailure(null);
          }}
        />
        {error === null ? (
          <p className="text-xs text-muted-foreground">
            Relative to this thread's workspace. An existing file is never replaced.
          </p>
        ) : (
          <p id={errorId} className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={problem !== null || saving}>
          {saving ? <Spinner variant="bold" /> : null}
          Save
        </Button>
      </DialogActions>
    </form>
  );
}

export function SavePlanDialog({
  open,
  onOpenChange,
  projectId,
  threadId,
  markdown,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly markdown: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save plan as Markdown</DialogTitle>
          <DialogDescription>Writes the plan to a new .md file in the workspace.</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so each opening starts from the suggested name. */}
        {open ? (
          <SavePlanForm
            projectId={projectId}
            threadId={threadId}
            markdown={markdown}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
