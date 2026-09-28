/**
 * Restoring a checkpoint rewrites the worktree, so it never happens on a
 * single click: a button opens this dialog, and only its Restore button
 * dispatches `thread.checkpoint.restore`. It is the one restore confirmation
 * in the app — the Changes pane opens it from `RestoreCheckpointButton` below,
 * and the timeline from "Restore to here" and a turn's "Undo"
 * (`timeline/restore-before-turn.tsx`), each with its own title and wording.
 *
 * Two kinds of failure, both reported here rather than swallowed:
 *
 * - The command is rejected up front — a running turn, an unknown checkpoint.
 *   The receipt carries the reason and it is shown in the dialog, which stays
 *   open so the user can read it.
 * - The dispatch never reaches the server. Same place, generic message.
 *
 * A `blockedReason` that arrives while the dialog is open — a turn started
 * meanwhile — disables Restore and says why, rather than letting the server
 * reject it.
 *
 * The git work itself runs in the server's checkpoint reactor after the event
 * is durable, so an accepted receipt means "queued", not "done" — a failure
 * there lands in the thread timeline as an error. The dialog says so instead
 * of implying the files are already back, and `onAccepted` is named for what
 * actually happened: the pane waits for the thread to advance before it
 * refetches, because a refetch on the receipt would read the old worktree.
 *
 * The dispatch goes through the client runtime in context, so on a fixture
 * page it reaches the fixture's decider. The body mounts with the popup, only
 * while the dialog is open, which also clears the last error on the next open.
 */

import { useAtomSet } from "@effect/atom-react";
import { makeCommandId, type ThreadId } from "@poseidon/contracts/ids";
import type { CheckpointSummary } from "@poseidon/contracts/orchestration";
import { Button } from "@poseidon/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@poseidon/ui/components/dialog";
import * as Exit from "effect/Exit";
import * as React from "react";

import { DialogActions } from "@/components/dialog-actions";
import { useClientRuntime } from "@/lib/client-runtime";
import { Undo } from "@honeyicons/react";

export interface RestoreCheckpointDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly threadId: ThreadId;
  readonly checkpoint: CheckpointSummary;
  readonly title: string;
  readonly description: string;
  /** A caveat under the description, e.g. that later turns are undone too. */
  readonly note?: string | undefined;
  /** Non-null keeps Restore disabled and says why: a turn started meanwhile. */
  readonly blockedReason: string | null;
  /** The server took the restore order; the git work has not run yet. */
  readonly onAccepted?: (() => void) | undefined;
}

function RestoreBody({
  onOpenChange,
  threadId,
  checkpoint,
  title,
  description,
  note,
  blockedReason,
  onAccepted,
}: Omit<RestoreCheckpointDialogProps, "open">) {
  const dispatch = useAtomSet(useClientRuntime().dispatchAtom, { mode: "promiseExit" });
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const restore = async () => {
    setPending(true);
    setError(null);
    const exit = await dispatch({
      commandId: makeCommandId(),
      createdAt: new Date().toISOString(),
      type: "thread.checkpoint.restore",
      threadId,
      checkpointId: checkpoint.checkpointId,
    });
    setPending(false);
    if (Exit.isSuccess(exit) && exit.value.status === "accepted") {
      onOpenChange(false);
      onAccepted?.();
      return;
    }
    setError(
      Exit.isSuccess(exit)
        ? (exit.value.reason ?? "The server rejected the restore.")
        : "Could not reach the server.",
    );
  };

  const problem = error ?? blockedReason;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {note === undefined ? null : <p className="type-body text-muted-foreground">{note}</p>}
      <p className="type-micro text-muted-foreground">
        The restore is queued on the thread; if git refuses it, the failure appears in the timeline
        as an error.
      </p>
      {problem === null ? null : (
        <p role="alert" className="type-body text-destructive">
          {problem}
        </p>
      )}
      <DialogActions>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          type="button"
          disabled={pending || blockedReason !== null}
          onClick={() => void restore()}
        >
          {pending ? "Restoring…" : "Restore"}
        </Button>
      </DialogActions>
    </>
  );
}

/** The confirmation itself, opened by the caller's own button. */
export function RestoreCheckpointDialog({ open, ...props }: RestoreCheckpointDialogProps) {
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <RestoreBody {...props} />
      </DialogContent>
    </Dialog>
  );
}

/** The Changes pane's "Restore" button for the turn it shows, and its dialog. */
export function RestoreCheckpointButton({
  threadId,
  checkpoint,
  label,
  disabledReason,
  onAccepted,
}: {
  threadId: ThreadId;
  checkpoint: CheckpointSummary | null;
  label: string;
  /** Non-null disables the trigger and explains why on hover. */
  disabledReason: string | null;
  /** The server took the restore order; the git work has not run yet. */
  onAccepted: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        disabled={disabledReason !== null || checkpoint === null}
        aria-label={`Restore ${label}`}
        title={disabledReason ?? `Restore the worktree to ${label}`}
        onClick={() => setOpen(true)}
      >
        <Undo variant="bold" />
      </Button>
      {checkpoint === null ? null : (
        <RestoreCheckpointDialog
          open={open}
          onOpenChange={setOpen}
          threadId={threadId}
          checkpoint={checkpoint}
          title={`Restore ${label}?`}
          description="Every tracked file in the workspace goes back to how this turn left it, and files created since are removed. Uncommitted work that is not in a checkpoint is lost."
          blockedReason={disabledReason}
          onAccepted={onAccepted}
        />
      )}
    </>
  );
}
