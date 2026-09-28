/**
 * The sidebar's undoable actions, for every surface that offers them: the row
 * menus, the selection bar, and the open thread's keys.
 *
 * - `archive` dispatches `thread.archive` for each thread not archived yet,
 *   unpins the ones that were pinned (archiving unpins), and toasts with an
 *   "Undo" that unarchives them, pins them again and — when the thread on
 *   screen was among them — opens it again.
 * - `setPinned`, `markUnread` and `rename` do what they say; `markUnread`
 *   leaves the open thread out.
 * - `setDone` marks threads done (`thread.done.mark`) or active again
 *   (`thread.done.clear`), skipping the ones already there and the ones the
 *   Done section never holds (`./thread-done`), and toasts with an Undo that
 *   sends the inverse, as archive does.
 *
 * Each pushes one entry on the undo stack (`./sidebar-undo`), so `Mod+Z`
 * takes back whichever came last. Dispatch and refusal toasts go through
 * `./thread-actions`, as every other thread command does; it sends the
 * commands one at a time, so each thread's result is its own even when a
 * bulk archive or its undo sends several at once.
 */

import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import {
  archiveUndoPlan,
  doneUndoEntry,
  makeUndoId,
  useSidebarUndo,
} from "@/components/sidebar/sidebar-undo";
import {
  threadCommandBase,
  threadDoneCommand,
  useThreadCommand,
} from "@/components/sidebar/thread-actions";
import { canMarkDone } from "@/components/sidebar/thread-done";
import { useThreadPins } from "@/components/sidebar/thread-pins";
import { useThreadSeen } from "@/components/sidebar/thread-seen";
import { useThreadIsDone } from "@/components/sidebar/use-thread-done";

export const useSidebarActions = () => {
  const send = useThreadCommand();
  const navigate = useNavigate();
  const openRoute = useMatchRoute()({ to: "/t/$threadId" });
  const openThreadId = openRoute === false ? null : openRoute.threadId;
  const [pins, pin] = useThreadPins();
  const [seen, , seenControls] = useThreadSeen();
  const { push, undo } = useSidebarUndo();
  const isDone = useThreadIsDone();

  const archive = async (threads: ReadonlyArray<ThreadSummary>): Promise<void> => {
    const targets = threads.filter((thread) => thread.status !== "archived");
    if (targets.length === 0) {
      return;
    }
    const accepted = await Promise.all(
      targets.map((thread) =>
        send(
          { ...threadCommandBase(thread.threadId), type: "thread.archive" },
          targets.length === 1 ? "Thread was not archived" : `${thread.title} was not archived`,
        ),
      ),
    );
    const archived = targets.filter((_, index) => accepted[index]);
    if (archived.length === 0) {
      return;
    }
    const ids = archived.map((thread) => thread.threadId);
    const plan = archiveUndoPlan(ids, pins, openThreadId);
    for (const id of plan.repin) {
      pin(id, false);
    }
    const entry = {
      id: makeUndoId(),
      label: "Archive",
      run: async () => {
        const restored = await Promise.all(
          archived.map((thread) =>
            send(
              { ...threadCommandBase(thread.threadId), type: "thread.unarchive" },
              `${thread.title} was not unarchived`,
            ),
          ),
        );
        // Only a thread that is back gets its pin and its place on screen.
        const back = new Set(ids.filter((_, index) => restored[index]));
        for (const id of plan.repin) {
          if (back.has(id)) {
            pin(id, true);
          }
        }
        if (plan.reopen !== null && back.has(plan.reopen)) {
          void navigate({ to: "/t/$threadId", params: { threadId: plan.reopen } });
        }
      },
    };
    push(entry);
    toast.success(archived.length === 1 ? "Archived" : `Archived ${archived.length} threads`, {
      action: { label: "Undo", onClick: () => undo(entry.id) },
    });
  };

  const setPinned = (thread: ThreadSummary, pinned: boolean) => {
    if (pins.includes(thread.threadId) === pinned) {
      return;
    }
    pin(thread.threadId, pinned);
    push({
      id: makeUndoId(),
      label: pinned ? "Pin" : "Unpin",
      run: () => pin(thread.threadId, !pinned),
    });
  };

  const markUnread = (picked: ReadonlyArray<ThreadSummary>) => {
    // Never the open thread: it is being read, and its next event would stamp
    // it seen again before the mark ever showed.
    const threads = picked.filter((thread) => thread.threadId !== openThreadId);
    if (threads.length === 0) {
      return;
    }
    const before = threads.map((thread) => [thread.threadId, seen[thread.threadId]] as const);
    for (const [id] of before) {
      seenControls.markUnread(id);
    }
    push({
      id: makeUndoId(),
      label: "Mark unread",
      run: () => {
        for (const [id, stamp] of before) {
          seenControls.restore(id, stamp);
        }
      },
    });
  };

  const rename = async (thread: ThreadSummary, title: string): Promise<boolean> => {
    const previous = thread.title;
    const base = () => threadCommandBase(thread.threadId);
    const ok = await send({ ...base(), type: "thread.rename", title }, "Thread was not renamed");
    if (ok) {
      push({
        id: makeUndoId(),
        label: "Rename",
        run: () =>
          void send(
            { ...base(), type: "thread.rename", title: previous },
            "Thread was not renamed",
          ),
      });
    }
    return ok;
  };

  const setDone = async (threads: ReadonlyArray<ThreadSummary>, done: boolean): Promise<void> => {
    const targets = threads.filter((thread) =>
      done
        ? canMarkDone(thread, pins.includes(thread.threadId)) && !isDone(thread)
        : isDone(thread),
    );
    if (targets.length === 0) {
      return;
    }
    const mark = (threadId: ThreadSummary["threadId"], next: boolean) =>
      send(
        threadDoneCommand(threadId, next),
        next ? "Thread was not marked done" : "Thread was not marked active",
      );
    const accepted = await Promise.all(targets.map((thread) => mark(thread.threadId, done)));
    const moved = targets.filter((_, index) => accepted[index]);
    if (moved.length === 0) {
      return;
    }
    const entry = doneUndoEntry(
      moved.map((thread) => thread.threadId),
      done,
      mark,
    );
    push(entry);
    const what = done ? "done" : "active";
    toast.success(
      moved.length === 1 ? `Marked ${what}` : `Marked ${moved.length} threads ${what}`,
      {
        action: { label: "Undo", onClick: () => undo(entry.id) },
      },
    );
  };

  // A fresh object per render: callers call into it from event handlers only.
  return { archive, setPinned, markUnread, rename, setDone };
};
