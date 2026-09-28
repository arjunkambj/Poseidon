/**
 * What the thread menu's Copy submenu offers for one thread, in order: where
 * it works, its branch, its id. A worktree thread works in its worktree, a
 * local one in its project's folder; a thread whose project is gone and that
 * has no worktree has no folder to name, so the path is left out.
 *
 * The branch is a worktree thread's only: the summary carries no branch for a
 * local thread — that one is whatever the project's folder has checked out.
 */

import type { ProjectSummary, ThreadSummary } from "@poseidon/contracts/orchestration";

export interface ThreadCopyTarget {
  /** The menu item's label. */
  readonly label: string;
  /** What goes on the clipboard. */
  readonly value: string;
  /** How the toast names it: "Copied the {what}". */
  readonly what: string;
}

export const threadCopyTargets = (
  thread: Pick<ThreadSummary, "threadId" | "worktree">,
  project: Pick<ProjectSummary, "workspaceRoot"> | undefined,
): ReadonlyArray<ThreadCopyTarget> => {
  const path = thread.worktree?.path ?? project?.workspaceRoot;
  return [
    ...(path === undefined ? [] : [{ label: "Workspace path", value: path, what: "path" }]),
    ...(thread.worktree === undefined
      ? []
      : [{ label: "Branch", value: thread.worktree.branch, what: "branch" }]),
    { label: "Thread ID", value: thread.threadId, what: "thread ID" },
  ];
};
