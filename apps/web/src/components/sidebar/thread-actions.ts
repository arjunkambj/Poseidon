/**
 * Dispatching the thread lifecycle commands, shared by every surface that
 * offers them.
 *
 * The sidebar row menu and Settings → Archived threads both rename, archive,
 * unarchive and delete threads. They report the outcome the same way — a toast
 * with the decider's reason on a refusal, an optional confirmation on success —
 * and they build the command envelope the same way, so the plumbing lives here
 * once rather than drifting apart between them.
 */

import { toast } from "sonner";

import { makeCommandId, type ThreadId } from "@poseidon/contracts/ids";
import type { Command } from "@poseidon/contracts/orchestration";

import { isAccepted, rejectionMessage } from "@/lib/dispatch-outcome";
import { useDispatchCommand } from "@/state/hooks";

/**
 * The confirmation copy for `thread.delete`: it is durable and has no undo.
 * The delete itself touches no files; a worktree thread's dialog adds the
 * opt-in to remove its worktree (`./delete-thread-dialog`).
 */
export const THREAD_DELETE_DESCRIPTION =
  "Its transcript, its queue and its turn checkpoints go with it, and the session it is running on is closed. Files in the project's folder are left alone, and a thread's worktree is removed only if you ask.";

/**
 * The envelope every thread command carries. A fresh `commandId` per call:
 * the engine answers a repeated id with the stored receipt, so reusing one
 * would replay the first outcome instead of running the command again.
 */
export const threadCommandBase = (threadId: ThreadId) => ({
  commandId: makeCommandId(),
  createdAt: new Date().toISOString(),
  threadId,
});

/** `thread.done.mark` for `done`, `thread.done.clear` to make it active again. */
export const threadDoneCommand = (threadId: ThreadId, done: boolean): Command => ({
  ...threadCommandBase(threadId),
  type: done ? "thread.done.mark" : "thread.done.clear",
});

/**
 * A queue that runs each task only once the one before it has settled, and
 * resolves each caller with its own task's result. A failed task does not
 * stop the ones behind it.
 */
export const makeTurnQueue = () => {
  let last: Promise<unknown> = Promise.resolve();
  return <A>(task: () => Promise<A>): Promise<A> => {
    const next = last.then(task, task);
    last = next.catch(() => undefined);
    return next;
  };
};

/**
 * Every dispatch goes through one shared, non-concurrent atom: a second
 * command sent while the first is in flight interrupts it and hands both
 * callers the second's receipt. The bulk actions (archive and its undo,
 * delete) send one command per thread, so the thread commands take turns.
 */
const inTurn = makeTurnQueue();

/**
 * `send(command, fallback, done?)`: dispatch, toast the refusal (or
 * `fallback` when the decider gave no reason), and toast `done` on success
 * when there is something worth confirming. Resolves with whether the command
 * was accepted, for a caller with a step that must only follow an accepted one.
 */
export const useThreadCommand = () => {
  const dispatch = useDispatchCommand();
  return async (command: Command, fallback: string, done?: string): Promise<boolean> => {
    const exit = await inTurn(() => dispatch(command));
    if (!isAccepted(exit)) {
      toast.error(rejectionMessage(exit, fallback));
      return false;
    }
    if (done !== undefined) {
      toast.success(done);
    }
    return true;
  };
};
