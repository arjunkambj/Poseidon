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
 * names the source and the message. A plan's "Implement in new thread" runs
 * the same steps without a fork: the new thread's first message is the plan.
 */

import type { ThreadWorktree } from "@poseidon/contracts/git";
import type { ItemId, ThreadId, TurnId } from "@poseidon/contracts/ids";
import type { Command, ThreadSettings } from "@poseidon/contracts/orchestration";

type ThreadCreate = Extract<Command, { readonly type: "thread.create" }>;

import type { WorktreeThreadStart } from "@/components/thread/use-start-in-worktree";

/**
 * A plan to implement in a new thread, from a plan's card. The thread is not a
 * fork: it starts clean, in the source's project, with the plan as its first
 * message.
 */
export interface BranchOffPlan {
  readonly markdown: string;
  /**
   * The source's pending plan, answered `handoff` once the new thread exists
   * so its card closes without running the plan there. Absent from the
   * timeline's record of a plan, which has nothing left to answer.
   */
  readonly handoffTurnId?: TurnId;
}

/**
 * One request to open the branch-off dialog: a fork, from a message's footer
 * or a thread's menu, or a plan to implement, from a plan's card.
 */
export interface BranchOffRequest {
  /** Fresh per request, so each opening starts clean. */
  readonly key: string;
  /** The thread to fork, or the one the plan came from. */
  readonly threadId: ThreadId;
  /** The user message to fork from; absent forks the whole thread. */
  readonly throughItemId?: ItemId;
  /** Set for "Implement in new thread": no fork, the plan is the first message. */
  readonly plan?: BranchOffPlan;
}

/**
 * What `thread.create` carries besides the id, project, title and worktree: a
 * fork names its source and message, and the server copies the source's
 * settings; a plan's thread takes the source's harness and model itself, out
 * of plan mode, since it is there to implement.
 */
export const branchOffCreateFields = (
  request: BranchOffRequest,
  sourceSettings: ThreadSettings,
): Pick<ThreadCreate, "fork"> | Pick<ThreadCreate, "settings"> =>
  request.plan === undefined
    ? {
        fork: {
          threadId: request.threadId,
          ...(request.throughItemId === undefined ? {} : { throughItemId: request.throughItemId }),
        },
      }
    : { settings: { ...sourceSettings, interactionMode: "default" } };

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

/**
 * Why the whole thread cannot be forked now, or `null`, as short as a menu
 * item's hint: a running turn's answer is not written yet, so the server
 * refuses the fork until it settles.
 */
export const threadForkBlockedReason = ({
  connected,
  running,
}: {
  readonly connected: boolean;
  readonly running: boolean;
}): string | null => (!connected ? "Offline" : running ? "Still running" : null);
