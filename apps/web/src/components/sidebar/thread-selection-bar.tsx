/**
 * What the sidebar offers for several picked threads at once: archive them,
 * mark them unread, mark them done (or active, when every one of them is
 * done already), delete them, or let go of the selection. It shows under the tree while
 * anything is picked — see `./thread-selection` for how rows get picked. It
 * stays mounted when nothing is, so the delete confirmation outlives the
 * selection it was opened for.
 *
 * Each action is the row menu's own: archive and mark unread through
 * `./use-sidebar-actions`, delete through `./use-delete-thread`, so each thread
 * keeps its own refusal toast and its own worktree flow. Archive skips the
 * threads that already are archived and toasts once, with an Undo for the
 * lot; mark unread is one undo entry for the lot; delete asks first, once for
 * the lot, with the same worktree opt-in the single-thread dialog offers —
 * for the worktrees no thread left behind still works in (`worktreeRemovers`).
 */

import * as React from "react";

import { Button } from "@poseidon/ui/components/button";
import { Checkbox } from "@poseidon/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@poseidon/ui/components/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { DialogActions } from "@/components/dialog-actions";
import { worktreeRemovers } from "@/components/sidebar/delete-thread";
import { THREAD_DELETE_DESCRIPTION } from "@/components/sidebar/thread-actions";
import { useDeleteThread } from "@/components/sidebar/use-delete-thread";
import { useSidebarActions } from "@/components/sidebar/use-sidebar-actions";
import { useThreadIsDone } from "@/components/sidebar/use-thread-done";
import { useThreadList } from "@/state/hooks";
import { Archive, CheckDouble, Close, Email, Inbox, Trash } from "@honeyicons/react";

/** `THREAD_DELETE_DESCRIPTION`, for many. */
const THREADS_DELETE_DESCRIPTION =
  "Their transcripts, queues and turn checkpoints go with them, and the sessions they run on are closed. Files in the projects' folders are left alone, and a thread's worktree is removed only if you ask.";

const threadCount = (count: number) => (count === 1 ? "1 thread" : `${count} threads`);

function DeleteThreadsDialog({
  threads,
  open,
  onOpenChange,
  onConfirm,
}: {
  readonly threads: ReadonlyArray<ThreadSummary>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The threads that remove their worktree: empty when the box was unchecked. */
  readonly onConfirm: (removers: ReadonlySet<string>) => void;
}) {
  const [removeWorktrees, setRemoveWorktrees] = React.useState(true);
  // Checked again on every opening: the choice is per deletion, not sticky.
  React.useEffect(() => {
    if (open) {
      setRemoveWorktrees(true);
    }
  }, [open]);

  const all = useThreadList();
  const removers = React.useMemo(() => worktreeRemovers(threads, all), [threads, all]);
  const worktrees = removers.size;
  // Worktrees a thread that is not being deleted still works in stay.
  const kept =
    new Set(
      threads.flatMap((thread) => (thread.worktree === undefined ? [] : [thread.worktree.path])),
    ).size - worktrees;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {threadCount(threads.length)}?</DialogTitle>
          <DialogDescription>
            {threads.length === 1 ? THREAD_DELETE_DESCRIPTION : THREADS_DELETE_DESCRIPTION}
          </DialogDescription>
        </DialogHeader>
        {kept === 0 ? null : (
          <p className="text-xs text-muted-foreground">
            {kept === 1
              ? "Another thread still works in one of their worktrees, so it is kept."
              : `Other threads still work in ${kept} of their worktrees, so they are kept.`}
          </p>
        )}
        {worktrees === 0 ? null : (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={removeWorktrees}
              onCheckedChange={(checked) => setRemoveWorktrees(checked === true)}
              className="mt-0.5"
            />
            <span className="flex min-w-0 flex-col gap-1">
              <span>
                Also remove {worktrees === 1 ? "the worktree" : `the ${worktrees} worktrees`} they
                work in
              </span>
              <span className="text-xs text-muted-foreground">
                The branches are kept, along with their commits. Uncommitted work stops a removal
                and asks you first.
              </span>
            </span>
          </label>
        )}
        <DialogActions>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              onOpenChange(false);
              onConfirm(removeWorktrees ? removers : new Set());
            }}
          >
            Delete {threadCount(threads.length)}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

function BarAction({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function ThreadSelectionBar({
  threads,
  onClear,
}: {
  /** The picked threads, in sidebar order. */
  readonly threads: ReadonlyArray<ThreadSummary>;
  readonly onClear: () => void;
}) {
  const actions = useSidebarActions();
  const remove = useDeleteThread();
  const isDone = useThreadIsDone();
  const allDone = threads.length > 0 && threads.every(isDone);
  // The dialog keeps the threads it was opened for: the selection can change
  // under it (Escape clears it) and the copy must not.
  const [deleting, setDeleting] = React.useState<ReadonlyArray<ThreadSummary> | null>(null);
  const shown = React.useRef<ReadonlyArray<ThreadSummary>>([]);
  if (deleting !== null) {
    shown.current = deleting;
  }

  const archive = () => {
    const targets = threads;
    onClear();
    void actions.archive(targets);
  };

  const setDone = () => {
    const targets = threads;
    onClear();
    void actions.setDone(targets, !allDone);
  };

  const markUnread = () => {
    actions.markUnread(threads);
    onClear();
  };

  return (
    <>
      {threads.length === 0 ? null : (
        <div
          role="toolbar"
          aria-label="Selected threads"
          className="mt-2 flex items-center gap-1 rounded-xl bg-sidebar-accent py-0.5 pr-1.5 pl-3 text-sm text-sidebar-accent-foreground"
        >
          <span className="min-w-0 flex-1 truncate tabular-nums">{threads.length} selected</span>
          <BarAction label="Archive" onClick={archive}>
            <Archive variant="bold" />
          </BarAction>
          <BarAction label="Mark unread" onClick={markUnread}>
            <Email variant="bold" />
          </BarAction>
          <BarAction label={allDone ? "Mark active" : "Mark done"} onClick={setDone}>
            {allDone ? <Inbox variant="bold" /> : <CheckDouble variant="bold" />}
          </BarAction>
          <BarAction label="Delete" onClick={() => setDeleting(threads)}>
            <Trash variant="bold" />
          </BarAction>
          <BarAction label="Clear selection" onClick={onClear}>
            <Close variant="bold" />
          </BarAction>
        </div>
      )}
      <DeleteThreadsDialog
        threads={shown.current}
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) {
            setDeleting(null);
          }
        }}
        onConfirm={(removers) => {
          const targets = shown.current;
          onClear();
          for (const thread of targets) {
            void remove(thread, removers.has(thread.threadId));
          }
        }}
      />
    </>
  );
}
