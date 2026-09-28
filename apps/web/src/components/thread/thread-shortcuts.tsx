/**
 * The lifecycle keys for the open thread: `thread.rename`, `thread.archive`
 * and `thread.delete`. Mounted by `ThreadView` once its snapshot is in, so they
 * answer only while a thread is open (their `when` clause says `threadOpen`,
 * which the view publishes).
 *
 * They do what the sidebar row's overflow menu does, through the same pieces:
 * the same rename form, the same delete confirmation — with its offer to remove
 * a worktree thread's worktree too — and the same dispatch and toasts from
 * `@/components/sidebar/thread-actions` and `use-delete-thread`. Archive
 * unarchives a thread that is already archived, as the menu offers. Delete
 * opens the confirmation, unless Settings → General says not to ask
 * (`use-confirm-thread-delete`).
 * `thread.regenerateTitle` (no default chord) is answered here too, while
 * something can write text (`./regenerate-title`).
 *
 * `DockShortcuts` holds the right dock's keys: `dock.toggle`, `dock.changes`
 * and `dock.files`, with the targets from `@/components/dock/dock-toggle`: the
 * toggle opens on the last tab used this session, else the launcher, and each
 * tab's key goes straight to its tab — from the launcher too — or closes the
 * dock when it is already there. Opening Files from its key also asks the
 * Files pane to focus its search. The thread view mounts it, and so does the
 * New task page for its project's dock. `BrowserPaneShortcut` adds
 * `browserPane.toggle`, only where there is a thread's browser to show — the
 * New task page leaves the chord unclaimed. `PullRequestPaneShortcut` answers
 * `dock.pullRequest` (no default chord; the palette's "Show pull request")
 * the same way, for a thread's dock only.
 */

import * as React from "react";

import type { ThreadId } from "@poseidon/contracts/ids";
import type { ThreadStatus } from "@poseidon/contracts/orchestration";

import { dockTabTarget, type DockPane, type DockTab } from "@/components/dock/dock-toggle";
import { DeleteThreadDialog } from "@/components/sidebar/delete-thread-dialog";
import { threadCommandBase, useThreadCommand } from "@/components/sidebar/thread-actions";
import { RenameThreadDialog } from "@/components/sidebar/thread-menu";
import { useRequestThreadDelete } from "@/components/sidebar/use-confirm-thread-delete";
import { useDeleteThread } from "@/components/sidebar/use-delete-thread";
import { useSidebarActions } from "@/components/sidebar/use-sidebar-actions";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { useThreadList } from "@/state/hooks";

import { RegenerateTitleShortcut } from "./regenerate-title";

type OpenDialog = "rename" | "delete" | null;

export function ThreadShortcuts({
  threadId,
  title,
  status,
}: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly status: ThreadStatus;
}) {
  const send = useThreadCommand();
  const actions = useSidebarActions();
  const remove = useDeleteThread();
  const requestDelete = useRequestThreadDelete();
  // The list row carries the worktree the delete dialog offers to remove.
  const summary = useThreadList().find((thread) => thread.threadId === threadId) ?? null;
  const [dialog, setDialog] = React.useState<OpenDialog>(null);
  const base = () => threadCommandBase(threadId);
  const gone = status === "deleted";

  useKeybindingCommand("thread.rename", () => {
    if (!gone) {
      setDialog("rename");
    }
  });
  useKeybindingCommand("thread.archive", () => {
    if (gone) {
      return;
    }
    if (status === "archived") {
      void send({ ...base(), type: "thread.unarchive" }, "Thread was not unarchived", "Unarchived");
    } else if (summary !== null) {
      // The sidebar's own archive: it unpins, and its toast offers Undo.
      void actions.archive([summary]);
    } else {
      void send({ ...base(), type: "thread.archive" }, "Thread was not archived", "Archived");
    }
  });
  useKeybindingCommand("thread.delete", () => {
    if (!gone && summary !== null) {
      requestDelete([summary], () => setDialog("delete"));
    }
  });

  return (
    <>
      <RenameThreadDialog
        title={title}
        open={dialog === "rename"}
        onOpenChange={(next) => setDialog(next ? "rename" : null)}
        onSubmit={(next) =>
          void send({ ...base(), type: "thread.rename", title: next }, "Thread was not renamed")
        }
      />
      <DeleteThreadDialog
        thread={summary}
        open={dialog === "delete"}
        onOpenChange={(next) => setDialog(next ? "delete" : null)}
        onConfirm={(target, removeWorktree) => void remove(target, removeWorktree)}
      />
      {gone ? null : <RegenerateTitleShortcut threadId={threadId} />}
    </>
  );
}

export function DockShortcuts({
  dockTab,
  onToggle,
  onShow,
}: {
  readonly dockTab: DockPane | undefined;
  /** Open on the last tab (else the launcher), or close — the header button's own action. */
  readonly onToggle: () => void;
  /** Move the dock to a tab (null closes it); `focus` asks that tab to take focus. */
  readonly onShow: (tab: DockTab | null, focus?: boolean) => void;
}) {
  useKeybindingCommand("dock.toggle", onToggle);
  useKeybindingCommand("dock.changes", () => onShow(dockTabTarget(dockTab, "changes")));
  useKeybindingCommand("dock.files", () => {
    const target = dockTabTarget(dockTab, "files");
    onShow(target, target === "files");
  });
  return null;
}

/** `browserPane.toggle`, for a dock that has the Browser tab — a thread's. */
export function BrowserPaneShortcut({
  dockTab,
  onShow,
}: {
  readonly dockTab: DockPane | undefined;
  readonly onShow: (tab: DockTab | null) => void;
}) {
  useKeybindingCommand("browserPane.toggle", () => onShow(dockTabTarget(dockTab, "browser")));
  return null;
}

/** `dock.pullRequest`, for a dock that has the Pull request tab — a thread's. */
export function PullRequestPaneShortcut({
  dockTab,
  onShow,
}: {
  readonly dockTab: DockPane | undefined;
  readonly onShow: (tab: DockTab | null) => void;
}) {
  useKeybindingCommand("dock.pullRequest", () => onShow(dockTabTarget(dockTab, "pullRequest")));
  return null;
}
