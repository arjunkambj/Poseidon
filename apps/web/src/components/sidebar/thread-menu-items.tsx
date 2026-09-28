/**
 * The per-thread menu's items, drawn by both menus in `./thread-menu` — the
 * row's overflow dropdown and its right-click context menu — so the two list
 * the same things in the same order:
 *
 * 1. Rename — starts the inline rename in the row (`./thread-rename`).
 * 2. Pin / Unpin, Mark unread, then Mark done / Mark active
 *    (`./use-sidebar-actions`, undoable; `./thread-done` for the split).
 * 3. Copy ▸ the workspace path, the branch and the thread ID
 *    (`./thread-copy-targets` says which apply).
 * 4. Open terminal here — opens the thread with its terminal drawer open;
 *    Open pull request — opens it on its Pull request tab, only while its
 *    branch has one (the row's glyph, `./thread-pr-mark`, for the keyboard).
 * 5. New thread in this project — in the same worktree for a worktree
 *    thread: the server lets several threads share one — and Fork from here,
 *    which opens the fork dialog for the whole thread
 *    (`@/components/thread/branch-off-dialog`); disabled, with a short
 *    reason, while the thread runs or the server is out of reach.
 * 6. Archive or Unarchive, then Delete, each after a separator.
 *
 * `MenuParts` is one menu flavour's parts, so the list is written once.
 */

import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@poseidon/ui/components/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@poseidon/ui/components/dropdown-menu";
import { useNavigate } from "@tanstack/react-router";

import { makeThreadId } from "@poseidon/contracts/ids";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { useThreadPullRequestMark } from "@/components/panes/pull-request/use-thread-pull-request";
import { threadCommandBase, useThreadCommand } from "@/components/sidebar/thread-actions";
import { threadCopyTargets } from "@/components/sidebar/thread-copy-targets";
import { markDoneBlockedReason } from "@/components/sidebar/thread-done";
import { useThreadPins } from "@/components/sidebar/thread-pins";
import { useOpenPullRequestTab } from "@/components/sidebar/thread-pr-mark";
import { useRenamingThread } from "@/components/sidebar/thread-rename";
import { useThreadSeen } from "@/components/sidebar/thread-seen";
import { useSidebarActions } from "@/components/sidebar/use-sidebar-actions";
import { useThreadIsDone } from "@/components/sidebar/use-thread-done";
import { threadForkBlockedReason, threadTurnInFlight } from "@/components/thread/branch-off";
import { useRequestBranchOff } from "@/components/thread/use-branch-off";
import { copyText } from "@/lib/copy-path";
import { CommandKbd } from "@/lib/shortcuts";
import { useCreateThread } from "@/lib/use-create-thread";
import { useConnectionState, useProjects } from "@/state/hooks";
import { useSetDrawerOpen } from "@/state/terminal-ui";
import {
  Add,
  Archive as ArchiveIcon,
  ArchiveUp,
  CheckDouble,
  Copy,
  Edit,
  Email,
  GitPullRequest,
  GitFork,
  Inbox,
  Pin,
  PinOff,
  Terminal,
  Trash,
} from "@honeyicons/react";

/** Why a disabled item is disabled, at the item's end where a shortcut would sit. */
function MenuHint({ children }: { readonly children: string }) {
  return <span className="ml-auto text-xs text-muted-foreground">{children}</span>;
}

/** The item parts of one menu flavour, so both menus share one item list. */
export type MenuParts = {
  readonly Item: typeof DropdownMenuItem | typeof ContextMenuItem;
  readonly Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator;
  readonly Shortcut: typeof DropdownMenuShortcut | typeof ContextMenuShortcut;
  readonly Sub: typeof DropdownMenuSub | typeof ContextMenuSub;
  readonly SubTrigger: typeof DropdownMenuSubTrigger | typeof ContextMenuSubTrigger;
  readonly SubContent: typeof DropdownMenuSubContent | typeof ContextMenuSubContent;
};

export const DROPDOWN_PARTS: MenuParts = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

export const CONTEXT_PARTS: MenuParts = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

/**
 * The whole list for one thread. `active` marks the open thread's row: the
 * keys act on the open thread, so only its menu names them.
 */
export function ThreadMenuItems({
  parts: { Item, Separator, Shortcut, Sub, SubTrigger, SubContent },
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
  const actions = useSidebarActions();
  const navigate = useNavigate();
  const [pins] = useThreadPins();
  const [seen] = useThreadSeen();
  const [, startRename] = useRenamingThread();
  const setDrawerOpen = useSetDrawerOpen();
  const { create, pending } = useCreateThread();
  const requestBranchOff = useRequestBranchOff();
  const connection = useConnectionState();
  const project = useProjects().find((each) => each.projectId === thread.projectId);
  const pinned = pins.includes(thread.threadId);
  const pullRequest = useThreadPullRequestMark(thread.projectId, thread.threadId);
  const openPullRequest = useOpenPullRequestTab(thread.threadId);
  const done = useThreadIsDone()(thread);
  const doneBlocked = done ? null : markDoneBlockedReason(thread, pinned);
  // `""` is the stamp "Mark unread" leaves until the thread is opened again.
  const markedUnread = seen[thread.threadId] === "";
  const forkBlocked = threadForkBlockedReason({
    connected: connection.status === "connected",
    running: threadTurnInFlight(thread),
  });
  const base = () => threadCommandBase(thread.threadId);
  const keys = (command: string) =>
    active ? (
      <Shortcut>
        <CommandKbd command={command} />
      </Shortcut>
    ) : null;

  const openTerminal = () => {
    setDrawerOpen(thread.threadId, true);
    void navigate({ to: "/t/$threadId", params: { threadId: thread.threadId } });
  };

  // A fresh id for the worktree case: without one, `create` hands back the
  // project's blank local thread instead of starting one in the worktree.
  const newThread = () =>
    void create(
      thread.projectId,
      thread.worktree === undefined ? {} : { worktree: thread.worktree, threadId: makeThreadId() },
    );

  return (
    <>
      <Item onClick={() => startRename(thread.threadId)}>
        <Edit variant="bold" />
        Rename
        {keys("thread.rename")}
      </Item>
      <Item onClick={() => actions.setPinned(thread, !pinned)}>
        {pinned ? <PinOff variant="bold" /> : <Pin variant="bold" />}
        {pinned ? "Unpin" : "Pin"}
        {keys("thread.pin")}
      </Item>
      {/* The open thread is being read: it shows no mark, and its next event
          would stamp it seen again. */}
      <Item disabled={markedUnread || active} onClick={() => actions.markUnread([thread])}>
        <Email variant="bold" />
        Mark unread
      </Item>
      {/* A pinned, archived or busy thread never shows under Done. */}
      <Item disabled={doneBlocked !== null} onClick={() => void actions.setDone([thread], !done)}>
        {done ? <Inbox variant="bold" /> : <CheckDouble variant="bold" />}
        {done ? "Mark active" : "Mark done"}
        {doneBlocked === null ? keys("thread.done") : <MenuHint>{doneBlocked}</MenuHint>}
      </Item>
      <Sub>
        <SubTrigger>
          <Copy variant="bold" />
          Copy
        </SubTrigger>
        <SubContent className="w-40">
          {threadCopyTargets(thread, project).map((target) => (
            <Item key={target.label} onClick={() => void copyText(target.value, target.what)}>
              {target.label}
            </Item>
          ))}
        </SubContent>
      </Sub>
      <Item onClick={openTerminal}>
        <Terminal variant="bold" />
        Open terminal here
      </Item>
      {pullRequest === null ? null : (
        <Item onClick={openPullRequest}>
          <GitPullRequest variant="bold" />
          Open pull request
        </Item>
      )}
      <Item
        disabled={project === undefined || pending || connection.status !== "connected"}
        onClick={newThread}
      >
        <Add variant="bold" />
        New thread in this project
      </Item>
      <Item
        disabled={project === undefined || forkBlocked !== null}
        onClick={() => requestBranchOff({ threadId: thread.threadId })}
      >
        <GitFork variant="bold" />
        Fork from here
        {forkBlocked === null ? null : <MenuHint>{forkBlocked}</MenuHint>}
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
        <Item onClick={() => void actions.archive([thread])}>
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
