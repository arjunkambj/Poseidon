/**
 * The pure half of the thread header's git actions control: which steps an
 * action takes, why an action is unavailable, how the steps run and report,
 * and the commit message the dialog commits with.
 *
 * An action is a stack of up to three steps — commit, push, open a pull
 * request — and the plan drops the ones with nothing to do: no commit on a
 * clean tree, no push when the branch already matches its upstream. The runner
 * takes each step in order and stops at the first refusal, so a failed commit
 * never pushes and a failed push never opens a pull request. Every step gets
 * one toast that starts as "…ing" and ends as done or failed; the toast
 * binding and the RPC calls are injected, which is what the tests swap.
 *
 * The drafted message is plain text from what the thread already has — its
 * title and the changed paths. The commit dialog opens with it and the user
 * can edit it and untick files.
 */

import type {
  GitBranchList,
  GitCommitResult,
  GitPullRequestResult,
  GitPushResult,
} from "@poseidon/contracts/git";
import type { GitFileChange, GitStatus } from "@poseidon/contracts/rpc";

export type GitAction = "commit" | "commit-push" | "commit-push-pr";

export type GitStep = "commit" | "push" | "pr";

/** The order of the commit dialog's buttons. */
export const GIT_ACTIONS: ReadonlyArray<GitAction> = ["commit", "commit-push", "commit-push-pr"];

/** The title a thread has until it is renamed or its connector infers one. */
const DEFAULT_THREAD_TITLE = "New thread";

/**
 * The remote a push goes to, the way the server picks it: the upstream's
 * remote, else `origin`, else the only remote. `null` when there is none to
 * pick — no remote at all, or several with none of them `origin`.
 */
const pushRemote = (status: GitStatus, branches: GitBranchList): string | null => {
  const upstream = status.upstream;
  if (upstream !== null) {
    const remote = branches.remotes
      .filter((candidate) => upstream.startsWith(`${candidate}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (remote !== undefined) {
      return remote;
    }
  }
  if (branches.remotes.includes("origin")) {
    return "origin";
  }
  return branches.remotes.length === 1 ? (branches.remotes[0] ?? null) : null;
};

/** Where a push of the current branch lands, `origin/<branch>` style, for the toast. */
export const pushTargetOf = (status: GitStatus, branches: GitBranchList): string | null => {
  if (status.upstream !== null) {
    return status.upstream;
  }
  const remote = pushRemote(status, branches);
  return remote === null || status.branch === null ? null : `${remote}/${status.branch}`;
};

/**
 * The steps `action` takes from this state, in order. A commit only when
 * something changed; a push after a commit, and otherwise only when the
 * branch has no upstream yet or is ahead of it; a pull request only for the
 * last action. Pushing and the pull request both need a remote.
 */
export const planGitAction = (
  action: GitAction,
  status: GitStatus,
  branches: GitBranchList,
): ReadonlyArray<GitStep> => {
  const changed = status.files.length > 0;
  const steps: Array<GitStep> = changed ? ["commit"] : [];
  if (action === "commit" || pushRemote(status, branches) === null) {
    return steps;
  }
  if (changed || status.upstream === null || status.ahead > 0) {
    steps.push("push");
  }
  if (action === "commit-push-pr") {
    steps.push("pr");
  }
  return steps;
};

/** Why each action is unavailable right now; `null` means it can run. */
export type GitActionAvailability = Readonly<Record<GitAction, string | null>>;

export const TURN_RUNNING_REASON = "A turn is running — stop it before committing.";

export const availableActions = (input: {
  readonly status: GitStatus;
  readonly branches: GitBranchList;
  readonly turnRunning: boolean;
  /**
   * Why `gh` cannot open a pull request (`git.pullRequest.readiness`); absent
   * or `null` while that is not known, and the server's refusal says it then.
   */
  readonly pullRequestBlocker?: string | null;
}): GitActionAvailability => {
  const { status, branches } = input;
  const everywhere =
    status.isRepository === false || !branches.isRepository
      ? "This folder is not a git repository."
      : input.turnRunning
        ? TURN_RUNNING_REASON
        : null;
  if (everywhere !== null) {
    return { commit: everywhere, "commit-push": everywhere, "commit-push-pr": everywhere };
  }

  const pushing = (action: GitAction): string | null => {
    if (status.branch === null) {
      return "HEAD is detached — switch to a branch to push.";
    }
    if (pushRemote(status, branches) === null) {
      return branches.remotes.length === 0
        ? "This repository has no remote to push to."
        : "There are several remotes and none is origin — push from a terminal.";
    }
    if (status.behind > 0) {
      return `The branch is behind ${status.upstream ?? "its upstream"} — pull first.`;
    }
    if (planGitAction(action, status, branches).length === 0) {
      return "No changes, and nothing to push.";
    }
    return null;
  };

  return {
    commit: status.files.length === 0 ? "No changes to commit." : null,
    "commit-push": pushing("commit-push"),
    "commit-push-pr":
      pushing("commit-push-pr") ??
      (status.branch === branches.defaultBranch
        ? `This is the default branch, ${status.branch} — a pull request needs a branch of its own.`
        : (input.pullRequestBlocker ?? null)),
  };
};

/**
 * What starting `action` does — from the button, the menu or its key: nothing
 * while it cannot run or while a dialog is already up (a key pressed in the
 * commit dialog must not reopen it over what the user typed), else the
 * commit dialog when it commits, the pull request dialog when it only opens a
 * pull request, or the remaining steps straight away.
 */
export type GitStart = "ignore" | "commit-dialog" | "pull-request-dialog" | "run";

export const gitStartOf = (input: {
  readonly action: GitAction;
  readonly status: GitStatus;
  readonly branches: GitBranchList;
  readonly reason: string | null;
  readonly dialogOpen: boolean;
}): GitStart => {
  if (input.dialogOpen || input.reason !== null) {
    return "ignore";
  }
  const steps = planGitAction(input.action, input.status, input.branches);
  return steps.includes("commit")
    ? "commit-dialog"
    : steps.includes("pr")
      ? "pull-request-dialog"
      : "run";
};

/** One step's answer, with the server's message when it refused. */
export type StepOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

/** The three calls, bound by the caller with whatever each one needs. */
export interface GitStepCalls {
  readonly commit: () => Promise<StepOutcome<GitCommitResult>>;
  readonly push: () => Promise<StepOutcome<GitPushResult>>;
  readonly pr: () => Promise<StepOutcome<GitPullRequestResult>>;
}

/**
 * One update to a step's toast: `loading` when it starts, then exactly one of
 * `success` or `error`. A pull request's success carries its `url`.
 */
export type StepNotice =
  | { readonly step: GitStep; readonly phase: "loading"; readonly message: string }
  | {
      readonly step: GitStep;
      readonly phase: "success";
      readonly message: string;
      readonly url?: string;
    }
  | { readonly step: GitStep; readonly phase: "error"; readonly message: string };

/** What a run did. `failed` is the step that stopped it, `null` when all ran. */
export interface GitRunResult {
  readonly commit?: GitCommitResult;
  readonly push?: GitPushResult;
  readonly pullRequest?: GitPullRequestResult;
  readonly failed: GitStep | null;
}

const FAILED_PREFIX: Record<GitStep, string> = {
  commit: "Commit failed",
  push: "Push failed",
  pr: "Pull request failed",
};

/** A call that throws instead of answering is a failure like any other. */
const settle = async <A>(call: () => Promise<StepOutcome<A>>): Promise<StepOutcome<A>> => {
  try {
    return await call();
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error && error.message !== "" ? error.message : "Unknown error",
    };
  }
};

/**
 * Runs `steps` in order through `calls`, stopping at the first failure; the
 * steps after it never start. `pushTarget` names the push's destination in its
 * toast while it runs.
 */
export const runGitSteps = async (
  steps: ReadonlyArray<GitStep>,
  calls: GitStepCalls,
  notify: (notice: StepNotice) => void,
  pushTarget: string | null = null,
): Promise<GitRunResult> => {
  const done: { -readonly [K in keyof GitRunResult]?: GitRunResult[K] } = {};
  for (const step of steps) {
    const fail = (message: string): GitRunResult => {
      notify({ step, phase: "error", message: `${FAILED_PREFIX[step]}: ${message}` });
      return { ...done, failed: step };
    };
    switch (step) {
      case "commit": {
        notify({ step, phase: "loading", message: "Committing…" });
        const outcome = await settle(calls.commit);
        if (!outcome.ok) return fail(outcome.message);
        done.commit = outcome.value;
        notify({ step, phase: "success", message: `Committed ${outcome.value.sha.slice(0, 7)}` });
        break;
      }
      case "push": {
        notify({
          step,
          phase: "loading",
          message: pushTarget === null ? "Pushing…" : `Pushing to ${pushTarget}…`,
        });
        const outcome = await settle(calls.push);
        if (!outcome.ok) return fail(outcome.message);
        done.push = outcome.value;
        const target = `${outcome.value.remote}/${outcome.value.branch}`;
        notify({
          step,
          phase: "success",
          message: outcome.value.setUpstream
            ? `Pushed to ${target} and set it as the upstream`
            : `Pushed to ${target}`,
        });
        break;
      }
      case "pr": {
        notify({ step, phase: "loading", message: "Creating pull request…" });
        const outcome = await settle(calls.pr);
        if (!outcome.ok) return fail(outcome.message);
        done.pullRequest = outcome.value;
        notify({
          step,
          phase: "success",
          message: outcome.value.created ? "Pull request created" : "Pull request already open",
          url: outcome.value.url,
        });
        break;
      }
    }
  }
  return { ...done, failed: null };
};

/**
 * The commit dialog's message: the thread's title as the subject —
 * or `Update N files` while the title is still the default — then a blank
 * line and the changed paths.
 */
export const commitMessageDraft = (title: string, paths: ReadonlyArray<string>): string => {
  const trimmed = title.trim();
  const subject =
    trimmed === "" || trimmed === DEFAULT_THREAD_TITLE
      ? `Update ${paths.length} ${paths.length === 1 ? "file" : "files"}`
      : trimmed;
  return [subject, "", "Changed files:", ...paths.map((path) => `- ${path}`)].join("\n");
};

/**
 * What the commit dialog would commit: the files still checked, the message
 * drafted for exactly those files, so an unchecked file is neither counted
 * nor listed, and the `paths` to send, absent when every file is checked (the
 * server then stages everything).
 */
export const commitSelection = (
  title: string,
  files: ReadonlyArray<GitFileChange>,
  excluded: ReadonlySet<string>,
): {
  readonly included: ReadonlyArray<GitFileChange>;
  readonly message: string;
  readonly paths?: ReadonlyArray<string>;
} => {
  const included = files.filter((file) => !excluded.has(file.path));
  const paths = included.map((file) => file.path);
  return {
    included,
    message: commitMessageDraft(title, paths),
    ...(included.length === files.length ? {} : { paths }),
  };
};

/** A pull request made in the same run as its commit reuses the commit message. */
export const pullRequestFromMessage = (
  message: string,
): { readonly title: string; readonly body: string } => {
  const lines = message.trim().split("\n");
  return { title: (lines[0] ?? "").trim(), body: lines.slice(1).join("\n").trim() };
};

/** The pull-request-only dialog's title: the thread's, else the branch's name. */
export const pullRequestTitleDraft = (title: string, branch: string | null): string => {
  const trimmed = title.trim();
  return trimmed === "" || trimmed === DEFAULT_THREAD_TITLE ? (branch ?? "") : trimmed;
};

/**
 * What `action` does in a run that commits nothing — a push from its key, or
 * the pull-request-only dialog: the push and the pull request, planned as if
 * the tree were clean. The commit dialog never gets here: with nothing ticked
 * its buttons are disabled.
 */
export const planWithoutCommit = (
  action: GitAction,
  status: GitStatus,
  branches: GitBranchList,
): ReadonlyArray<GitStep> => planGitAction(action, { ...status, files: [] }, branches);

/** A button label for steps that do not commit; `null` when there is nothing to run. */
export const stepsLabel = (steps: ReadonlyArray<GitStep>): string | null => {
  const push = steps.includes("push");
  const pr = steps.includes("pr");
  return push && pr ? "Push & create PR" : push ? "Push" : pr ? "Create PR" : null;
};
