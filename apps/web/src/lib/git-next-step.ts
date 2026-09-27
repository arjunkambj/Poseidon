/**
 * The thread header's primary git button: which step it offers from the
 * repository's state. The steps follow the usual path of a branch — commit
 * what changed, push what is committed, open a pull request for what is
 * pushed, then view that pull request — and the button offers the first one
 * with something to do.
 *
 * Every disabled reason comes from `availableActions`, so the button's
 * tooltip says exactly what the commit dialog's buttons say. Whether `gh` is
 * installed and signed in is not known here: a pull request that `gh` cannot
 * open surfaces as the server's error toast.
 */

import type { GitBranchList } from "@poseidon/contracts/git";
import type { GitStatus } from "@poseidon/contracts/rpc";

import { availableActions, type GitAction } from "@/lib/git-actions";

export type GitNextStep = "commit" | "push" | "create-pr" | "view-pr";

export interface GitNextStepView {
  readonly step: GitNextStep;
  /** The action the button starts; `null` for viewing a pull request, which runs nothing. */
  readonly action: GitAction | null;
  readonly label: "Commit" | "Push" | "Create PR" | "View PR";
  /** The changed-file count while committing, `↑N` commits ahead while pushing. */
  readonly badge: string | null;
  /** Why the button is disabled; `null` means it can run. */
  readonly reason: string | null;
}

export const nextGitStep = (input: {
  readonly status: GitStatus;
  readonly branches: GitBranchList;
  readonly turnRunning: boolean;
  readonly pullRequestUrl: string | null;
}): GitNextStepView => {
  const { status, branches } = input;
  const availability = availableActions(input);
  const hasRemote = branches.remotes.length > 0;

  if (status.files.length > 0) {
    return {
      step: "commit",
      action: "commit",
      label: "Commit",
      badge: String(status.files.length),
      reason: availability.commit,
    };
  }
  if (status.branch !== null && hasRemote && (status.upstream === null || status.ahead > 0)) {
    return {
      step: "push",
      action: "commit-push",
      label: "Push",
      badge: status.ahead > 0 ? `↑${status.ahead}` : null,
      reason: availability["commit-push"],
    };
  }
  // Opening a link touches nothing, so it stays available while a turn runs.
  if (input.pullRequestUrl !== null) {
    return { step: "view-pr", action: null, label: "View PR", badge: null, reason: null };
  }
  if (status.branch !== null && status.branch !== branches.defaultBranch && hasRemote) {
    return {
      step: "create-pr",
      action: "commit-push-pr",
      label: "Create PR",
      badge: null,
      reason: availability["commit-push-pr"],
    };
  }
  return {
    step: "commit",
    action: "commit",
    label: "Commit",
    badge: null,
    reason: availability.commit,
  };
};
