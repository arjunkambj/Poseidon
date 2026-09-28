/**
 * Branching a new thread off an existing one — a fork from one of its
 * messages, or from the whole thread — as steps that can be tested without a
 * server:
 *
 * - **This workspace:** create the thread where the source works (its
 *   worktree, or the project's folder), then send the first message when
 *   there is one, then open the thread with its composer focused.
 * - **New worktree:** the start screen's sequence (`start-in-worktree.ts`):
 *   create the worktree, run the setup script, then the same create, send
 *   and open. A failed setup stops before the thread exists, for Start
 *   anyway or Discard.
 *
 * The server builds a fork's context from the source; the renderer only
 * names the source and the message.
 */

import type { ThreadWorktree } from "@poseidon/contracts/git";
import type { ItemId, ThreadId, TurnId } from "@poseidon/contracts/ids";

import type { WorktreeThreadStart } from "@/components/thread/use-start-in-worktree";

/** One request to open the branch-off dialog, from a message's footer or a thread's menu. */
export interface BranchOffRequest {
  /** Fresh per request, so each opening starts clean. */
  readonly key: string;
  /** The thread to fork. */
  readonly threadId: ThreadId;
  /** The user message to fork from; absent forks the whole thread. */
  readonly throughItemId?: ItemId;
}

/** The title a fork opens with. */
export const forkTitle = (title: string): string => `${title} (fork)`;

/** What the new thread's create, first message and opening are, bound by the caller. */
export interface BranchOffActions {
  /** `thread.create` in `worktree` (none: the project's folder); false when it was refused. */
  readonly createThread: (worktree: ThreadWorktree | undefined) => Promise<boolean>;
  /** Sends the thread's first message, for a branch-off that has one. */
  readonly sendFirst?: () => void;
  /** Navigates to the thread and asks its composer for the focus. */
  readonly open: () => void;
}

const finish = (actions: BranchOffActions): void => {
  actions.sendFirst?.();
  actions.open();
};

/** In the source's own workspace. False when the create was refused. */
export const branchOffHere = async (
  actions: BranchOffActions,
  worktree: ThreadWorktree | undefined,
): Promise<boolean> => {
  if (!(await actions.createThread(worktree))) {
    return false;
  }
  finish(actions);
  return true;
};

/** The thread half of the new-worktree sequence, for `useStartInWorktree`. */
export const inNewWorktree = (actions: BranchOffActions): WorktreeThreadStart => ({
  createThread: (worktree) => actions.createThread(worktree),
  send: () => finish(actions),
});

/**
 * Why a message cannot be forked from now, or `null`: the server is out of
 * reach, or the message's turn is still running and its answer unwritten.
 */
export const forkBlockedReason = ({
  connected,
  runningTurnId,
  turnId,
}: {
  readonly connected: boolean;
  readonly runningTurnId: TurnId | null;
  readonly turnId: TurnId | undefined;
}): string | null => {
  if (!connected) {
    return "Not connected to the server.";
  }
  if (turnId !== undefined && turnId === runningTurnId) {
    return "This turn is still running — fork once it has finished.";
  }
  return null;
};
