/**
 * The per-thread menu. It opens from the row's overflow button or a
 * right-click anywhere on the row, and both draw one item list
 * (`./thread-menu-items`): rename, pin, mark unread, copy, open a terminal,
 * start a thread beside it, archive, delete. Rename edits the title in the row
 * itself (`./thread-title-input`); this module's `RenameThreadDialog` is the
 * other path, for `thread.rename` on the open thread, answered from
 * `@/components/thread/thread-shortcuts`. Pins and the unread mark are this
 * window's, never the server's — see `./thread-pins` and `./thread-seen`.
 *
 * `thread.rename`, `thread.archive`, `thread.unarchive` and `thread.delete`
 * run through the command union, the decider and the reactors — closing the
 * session, pruning the checkpoints, deleting the staged attachments. This menu
 * and Settings → Archived threads are where the renderer dispatches them, both
 * through `thread-actions.ts`; without them the sidebar grows forever and
 * every one of those cleanup behaviours is unreachable from the product.
 *
 * Delete is behind a confirmation, on the precedent `RestoreCheckpointDialog`
 * set: it is durable and there is no undo. For a worktree thread the same
 * dialog offers to remove the worktree too (`./delete-thread-dialog`). Archive
 * is not — the thread stays, and an archived row offers Unarchive in place of
 * Archive, as the Archived threads settings page does.
 *
 * Rename, Pin, Mark unread and Archive go through `./use-sidebar-actions`, so
 * each can be undone — Archive from its toast, all four with `sidebar.undo`.
 *
 * The open thread's menu names the keys that do the same from anywhere —
 * `thread.rename`, `thread.pin` (`./triage-shortcuts`), `thread.archive` and
 * `thread.delete` (`@/components/thread/thread-shortcuts`) while a thread is
 * open.
 *
 * Each menu keeps its own delete dialog. The dialog is a sibling of its menu,
 * not a child of it: two modal surfaces each own a focus trap, and a menu that
 * is closing while a dialog opens inside it fights the dialog for focus.
 */

import * as React from "react";

import { Button } from "@poseidon/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@poseidon/ui/components/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@poseidon/ui/components/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@poseidon/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { Input } from "@poseidon/ui/components/input";
import { Label } from "@poseidon/ui/components/label";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { DeleteThreadDialog } from "@/components/sidebar/delete-thread-dialog";
import {
  CONTEXT_PARTS,
  DROPDOWN_PARTS,
  ThreadMenuItems,
} from "@/components/sidebar/thread-menu-items";
import { useDeleteThread } from "@/components/sidebar/use-delete-thread";
import { MoreVertical } from "@honeyicons/react";

/**
 * The rename form, for `thread.rename` on the open thread
 * (`@/components/thread/thread-shortcuts`). It takes the current title only;
 * the caller owns the dispatch.
 */
export function RenameThreadDialog({
  title: current,
  open,
  onOpenChange,
  onSubmit,
}: {
  readonly title: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (title: string) => void;
}) {
  const [title, setTitle] = React.useState(current);
  // Seeded per opening, not once: the thread may have been renamed by the
  // connector's own title inference since this row last mounted.
  React.useEffect(() => {
    if (open) {
      setTitle(current);
    }
  }, [open, current]);

  const trimmed = title.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== current;

  const submit = () => {
    if (canSubmit) {
      onOpenChange(false);
      onSubmit(trimmed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename thread</DialogTitle>
          <DialogDescription>
            The title is yours from now on — the connector stops inferring one for this thread.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="thread-title">Title</Label>
            <Input
              id="thread-title"
              value={title}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
              // Explicit rather than leaning on the form's implicit submission:
              // this dialog is one field, Enter is the obvious way out of it,
              // and it should not depend on how a portalled popup happens to
              // route the key.
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The delete confirmation, for either menu. */
function useDeleteDialog(thread: ThreadSummary) {
  const remove = useDeleteThread();
  const [open, setOpen] = React.useState(false);
  const dialog = (
    <DeleteThreadDialog
      thread={thread}
      open={open}
      onOpenChange={setOpen}
      onConfirm={(target, removeWorktree) => void remove(target, removeWorktree)}
    />
  );
  return [() => setOpen(true), dialog] as const;
}

/** The row's overflow button and its menu. */
export function ThreadRowMenu({
  thread,
  active,
}: {
  readonly thread: ThreadSummary;
  readonly active: boolean;
}) {
  const [openDelete, deleteDialog] = useDeleteDialog(thread);

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Actions for ${thread.title}`}
                  />
                }
              />
            }
          >
            <MoreVertical variant="bold" />
          </TooltipTrigger>
          <TooltipContent>More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-56">
          <ThreadMenuItems
            parts={DROPDOWN_PARTS}
            thread={thread}
            active={active}
            onDelete={openDelete}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {deleteDialog}
    </>
  );
}

/**
 * The same menu on a right-click (or a long press) anywhere on the row, opened
 * at the pointer. `row` is the element the trigger renders as — the sidebar's
 * list item, so the row keeps its own markup and hover group.
 */
export function ThreadContextMenu({
  thread,
  active,
  row,
  children,
}: {
  readonly thread: ThreadSummary;
  readonly active: boolean;
  readonly row: React.ReactElement;
  readonly children: React.ReactNode;
}) {
  const [openDelete, deleteDialog] = useDeleteDialog(thread);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={row}>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ThreadMenuItems
            parts={CONTEXT_PARTS}
            thread={thread}
            active={active}
            onDelete={openDelete}
          />
        </ContextMenuContent>
      </ContextMenu>
      {deleteDialog}
    </>
  );
}
