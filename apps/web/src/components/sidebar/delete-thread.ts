/**
 * Deleting a thread, and its worktree when the user asked for that, as a
 * sequence of injected steps so every way through it can be tested without a
 * server:
 *
 * 1. dispatch `thread.delete`;
 * 2. only once the decider accepted it, and only when the box was checked,
 *    remove the thread's worktree — without `force`, so git refuses a tree
 *    holding uncommitted or untracked work;
 * 3. on that refusal, never force on the user's behalf: the caller shows the
 *    server's message with a "Remove anyway" action, and only when the user
 *    takes it *and* confirms that the work will be lost does the removal run
 *    again with `force`.
 *
 * The branch is never deleted — the server keeps it — so the success message
 * says so. A local thread's files are never touched: it has no worktree, and
 * the flow stops after the delete.
 *
 * The refusal is also the expected answer to a race rather than only to real
 * work: the session closes asynchronously after `thread.delete`, and a harness
 * can still hold an untracked config file in the worktree for a moment. The
 * "Remove anyway" path covers that too; nothing here waits for it.
 */

import type { ThreadWorktree } from "@poseidon/contracts/git";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { isObject, isString } from "effect/Predicate";

/** How one `git.worktree.remove` call ended. */
export type WorktreeRemoval =
  | { readonly _tag: "removed" }
  /** git refused: uncommitted or untracked work, which a forced removal would lose. */
  | { readonly _tag: "conflict"; readonly message: string }
  | { readonly _tag: "failed"; readonly message: string };

export interface DeleteThreadSteps {
  /** `thread.delete`; false when it was refused or never answered (the caller has said why). */
  readonly deleteThread: () => Promise<boolean>;
  readonly removeWorktree: (force: boolean) => Promise<WorktreeRemoval>;
  /**
   * Offers "Remove anyway" with the server's `message`. True only when the
   * user took it and then confirmed that the uncommitted work will be lost;
   * false when they let it go or cancelled.
   */
  readonly offerForce: (message: string) => Promise<boolean>;
  readonly onRemoved: (worktree: ThreadWorktree) => void;
  readonly onRemoveFailed: (message: string) => void;
}

export type DeleteThreadOutcome =
  | "rejected"
  | "deleted"
  | "worktree-removed"
  /** The user chose to keep a worktree git would not remove cleanly. */
  | "worktree-kept"
  | "worktree-failed";

/** A forced removal waiting on the user's second confirmation. */
export interface ForceRemovalRequest {
  readonly worktree: ThreadWorktree;
  /** Called once: true when the user confirmed that the uncommitted work will be lost. */
  readonly answer: (confirmed: boolean) => void;
}

/**
 * The confirmations waiting to be shown, first asked first. "Remove anyway"
 * can be taken on two refusal toasts before the first confirmation is
 * answered; the second waits its turn rather than replacing the first, whose
 * toast is gone and which nothing else would ever answer.
 */
export const enqueueForceRemoval = (
  queue: ReadonlyArray<ForceRemovalRequest>,
  request: ForceRemovalRequest,
): ReadonlyArray<ForceRemovalRequest> => (queue.includes(request) ? queue : [...queue, request]);

/** The queue once `request` has been answered. */
export const dequeueForceRemoval = (
  queue: ReadonlyArray<ForceRemovalRequest>,
  request: ForceRemovalRequest,
): ReadonlyArray<ForceRemovalRequest> => queue.filter((entry) => entry !== request);

/** What `worktreeRemovers` reads of a thread. */
interface WorktreeUser {
  readonly threadId: string;
  readonly status: string;
  readonly worktree?: { readonly path: string } | undefined;
}

/**
 * Which of `deleting`, in the order they are deleted, should remove their
 * worktree when the user asks for that. Two threads can work in one worktree
 * ("New thread in this project" on a worktree thread), and the server refuses
 * to remove one a thread that is not deleted still works in — an archived one
 * included, since it can come back. So a worktree another thread in `threads`
 * still uses is left alone, and one shared only among `deleting` is removed by
 * the last of them, once the others are gone.
 */
export const worktreeRemovers = (
  deleting: ReadonlyArray<WorktreeUser>,
  threads: ReadonlyArray<WorktreeUser>,
): ReadonlySet<string> => {
  const leaving = new Set(deleting.map((thread) => thread.threadId));
  const kept = new Set(
    threads
      .filter((thread) => !leaving.has(thread.threadId) && thread.status !== "deleted")
      .flatMap((thread) => (thread.worktree === undefined ? [] : [thread.worktree.path])),
  );
  const lastByPath = new Map<string, string>();
  for (const thread of deleting) {
    if (thread.worktree !== undefined && !kept.has(thread.worktree.path)) {
      lastByPath.set(thread.worktree.path, thread.threadId);
    }
  }
  return new Set(lastByPath.values());
};

export const worktreeRemovedMessage = (worktree: ThreadWorktree): string =>
  `Worktree removed — branch ${worktree.branch} kept`;

/** Reads a `git.worktree.remove` exit: `conflict` is the one refusal "Remove anyway" answers. */
export const worktreeRemovalOf = (exit: Exit.Exit<unknown, unknown>): WorktreeRemoval => {
  if (Exit.isSuccess(exit)) {
    return { _tag: "removed" };
  }
  const error = Cause.squash(exit.cause);
  const message =
    isObject(error) && "message" in error && isString(error.message)
      ? error.message
      : "The worktree was not removed.";
  return isObject(error) && "code" in error && error.code === "conflict"
    ? { _tag: "conflict", message }
    : { _tag: "failed", message };
};

const settleRemoval = async (
  removal: WorktreeRemoval,
  worktree: ThreadWorktree,
  steps: DeleteThreadSteps,
): Promise<DeleteThreadOutcome> => {
  switch (removal._tag) {
    case "removed":
      steps.onRemoved(worktree);
      return "worktree-removed";
    case "failed":
      steps.onRemoveFailed(removal.message);
      return "worktree-failed";
    case "conflict":
      break;
  }
  if (!(await steps.offerForce(removal.message))) {
    return "worktree-kept";
  }
  const forced = await steps.removeWorktree(true);
  if (forced._tag === "removed") {
    steps.onRemoved(worktree);
    return "worktree-removed";
  }
  steps.onRemoveFailed(forced.message);
  return "worktree-failed";
};

export const deleteThread = async (
  thread: { readonly worktree?: ThreadWorktree | undefined },
  removeWorktree: boolean,
  steps: DeleteThreadSteps,
): Promise<DeleteThreadOutcome> => {
  if (!(await steps.deleteThread())) {
    return "rejected";
  }
  const { worktree } = thread;
  if (worktree === undefined || !removeWorktree) {
    return "deleted";
  }
  return settleRemoval(await steps.removeWorktree(false), worktree, steps);
};
