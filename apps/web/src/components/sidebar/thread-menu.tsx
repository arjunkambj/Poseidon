/**
 * The per-thread menu: pin or unpin, archive or unarchive, delete. It opens
 * from the row's overflow button or a right-click anywhere on the row. Pins
 * are this window's, never the server's — see `./thread-pins`. Rename is not
 * in it —
 * that is `thread.rename` on the open thread, which this module's
 * `RenameThreadDialog` answers from `@/components/thread/thread-shortcuts`.
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
 * The open thread's menu names the keys that do the same from anywhere —
 * `thread.archive` and `thread.delete` are answered by
 * `@/components/thread/thread-shortcuts` while a thread is open.
 *
 * Both menus draw one item list (`ThreadMenuItems`) and each keeps its own
 * delete dialog. The dialog is a sibling of its menu, not a child of it: two modal
 * surfaces each own a focus trap, and a menu that is closing while a dialog
 * opens inside it fights the dialog for focus.
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
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@poseidon/ui/components/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@poseidon/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { Input } from "@poseidon/ui/components/input";
import { Label } from "@poseidon/ui/components/label";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { DeleteThreadDialog } from "@/components/sidebar/delete-thread-dialog";
import { threadCommandBase, useThreadCommand } from "@/components/sidebar/thread-actions";
import { useThreadPins } from "@/components/sidebar/thread-pins";
import { useDeleteThread } from "@/components/sidebar/use-delete-thread";
import { CommandKbd } from "@/lib/shortcuts";
import {
  Archive as ArchiveIcon,
  ArchiveUp,
  MoreVertical,
  Pin,
  PinOff,
  Trash,
} from "@honeyicons/react";

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

/** The item parts of one menu flavour, so both menus share one item list. */
type MenuParts = {
  readonly Item: typeof DropdownMenuItem | typeof ContextMenuItem;
  readonly Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator;
  readonly Shortcut: typeof DropdownMenuShortcut | typeof ContextMenuShortcut;
};

const DROPDOWN_PARTS: MenuParts = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
};

const CONTEXT_PARTS: MenuParts = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
};

/**
 * Pin or unpin, archive or unarchive, then delete. `active`
 * marks the open thread's row: the lifecycle keys act on the open thread, so
 * only its menu names them.
 */
function ThreadMenuItems({
  parts: { Item, Separator, Shortcut },
  thread,
  active,
  onDelete,
}: {
  readonly parts: MenuParts;
  readonly thread: ThreadSummary;
  readonly active: boolean;
  readonly onDelete: () => void;
}) {
  const send = useThreadCommand();
  const [pins, setPinned] = useThreadPins();
  const pinned = pins.includes(thread.threadId);
  const base = () => threadCommandBase(thread.threadId);
  const keys = (command: string) =>
    active ? (
      <Shortcut>
        <CommandKbd command={command} />
      </Shortcut>
    ) : null;

  return (
    <>
      <Item onClick={() => setPinned(thread.threadId, !pinned)}>
        {pinned ? <PinOff variant="bold" /> : <Pin variant="bold" />}
        {pinned ? "Unpin" : "Pin"}
      </Item>
      <Separator />
      {thread.status === "archived" ? (
        <Item
          onClick={() =>
            void send(
              { ...base(), type: "thread.unarchive" },
              "Thread was not unarchived",
              "Unarchived",
            )
          }
        >
          <ArchiveUp variant="bold" />
          Unarchive
          {keys("thread.archive")}
        </Item>
      ) : (
        <Item
          onClick={() =>
            void send({ ...base(), type: "thread.archive" }, "Thread was not archived", "Archived")
          }
        >
          <ArchiveIcon variant="bold" />
          Archive
          {keys("thread.archive")}
        </Item>
      )}
      <Separator />
      <Item variant="destructive" onClick={onDelete}>
        <Trash variant="bold" />
        Delete
        {keys("thread.delete")}
      </Item>
    </>
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
        <DropdownMenuContent align="end" className={active ? "w-52" : "w-44"}>
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
        <ContextMenuContent className={active ? "w-52" : "w-44"}>
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
