/**
 * The Pull request tab's lifecycle actions, as data: which writes a pull
 * request offers in its state and why one cannot run, the words of each
 * confirm, and the run itself — a pending toast that turns into the outcome in
 * place. Pure apart from the `run` and `toast` it is handed, so it is tested
 * without a DOM or a server.
 *
 * - merged: nothing — GitHub cannot reopen or unmerge it.
 * - closed: Reopen.
 * - open draft: Ready for review, Close.
 * - open and ready: Merge, Convert to draft, Close. Merge is disabled, with
 *   the reason, while GitHub says the branch conflicts with its base or the
 *   repository allows no merge method; failing checks are a warning in the
 *   confirm, not a block, as on GitHub.
 */

import type {
  PullRequestAction,
  PullRequestDetail,
  PullRequestView,
} from "@poseidon/contracts/pullRequest";

export type PrActionKind = PullRequestAction["kind"];
export type MergeMethod = Extract<PullRequestAction, { readonly kind: "merge" }>["method"];

export interface PrActionOffer {
  readonly kind: PrActionKind;
  /** Why it cannot run now; `null` when it can. */
  readonly disabledReason: string | null;
}

/** Squash first, as the pane's default: the order the method picker lists them in. */
const MERGE_METHOD_ORDER: ReadonlyArray<MergeMethod> = ["squash", "merge", "rebase"];

export const MERGE_METHOD_LABELS: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

/** The merges the repository allows, in the picker's order; the first is the default. */
export const allowedMergeMethods = (
  pullRequest: Pick<PullRequestDetail, "mergeMethods">,
): ReadonlyArray<MergeMethod> =>
  MERGE_METHOD_ORDER.filter((method) => pullRequest.mergeMethods[method]);

/** Why Merge cannot run, or `null`. */
export const mergeBlock = (
  pullRequest: Pick<PullRequestDetail, "mergeable" | "baseRefName" | "mergeMethods">,
): string | null => {
  if (pullRequest.mergeable === "conflicting") {
    return `The branch conflicts with ${pullRequest.baseRefName}. Resolve the conflicts first.`;
  }
  if (allowedMergeMethods(pullRequest).length === 0) {
    return "The repository allows no merge method.";
  }
  return null;
};

/** The line Merge's confirm warns with while checks fail, or `null`. */
export const mergeWarning = (pullRequest: Pick<PullRequestDetail, "checks">): string | null => {
  const failing = pullRequest.checks.filter((check) => check.bucket === "fail").length;
  if (failing === 0) {
    return null;
  }
  return failing === 1 ? "1 check is failing." : `${failing} checks are failing.`;
};

/** What the pull request offers in its state, the one to show first leading. */
export const prActions = (
  pullRequest: Pick<
    PullRequestDetail,
    "state" | "isDraft" | "mergeable" | "baseRefName" | "mergeMethods"
  >,
): ReadonlyArray<PrActionOffer> => {
  if (pullRequest.state === "merged") {
    return [];
  }
  if (pullRequest.state === "closed") {
    return [{ kind: "reopen", disabledReason: null }];
  }
  if (pullRequest.isDraft) {
    return [
      { kind: "ready", disabledReason: null },
      { kind: "close", disabledReason: null },
    ];
  }
  return [
    { kind: "merge", disabledReason: mergeBlock(pullRequest) },
    { kind: "draft", disabledReason: null },
    { kind: "close", disabledReason: null },
  ];
};

export interface PrActionCopy {
  /** The menu item, and the start of the failure toast. */
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly confirm: string;
  readonly pending: string;
  readonly done: string;
}

/** Every word one action shows, for pull request `pullRequest`. */
export const prActionCopy = (
  kind: PrActionKind,
  pullRequest: Pick<PullRequestDetail, "number" | "baseRefName" | "headRefName" | "headRefOid">,
): PrActionCopy => {
  const n = `#${pullRequest.number}`;
  switch (kind) {
    case "ready":
      return {
        label: "Ready for review",
        title: `Mark ${n} ready for review?`,
        description: "Reviewers are notified, and it can be merged once checks and reviews allow.",
        confirm: "Mark ready",
        pending: `Marking ${n} ready for review…`,
        done: `${n} is ready for review`,
      };
    case "draft":
      return {
        label: "Convert to draft",
        title: `Convert ${n} to a draft?`,
        description: "It cannot be merged until it is marked ready for review again.",
        confirm: "Convert to draft",
        pending: `Converting ${n} to a draft…`,
        done: `${n} is a draft`,
      };
    case "merge":
      return {
        label: "Merge",
        title: `Merge ${n} into ${pullRequest.baseRefName}?`,
        description: `Merges ${pullRequest.headRefName} at ${pullRequest.headRefOid.slice(0, 7)} on GitHub — only that commit, so a newer push is not merged unseen. The branch is kept.`,
        confirm: "Merge",
        pending: `Merging ${n}…`,
        done: `Merged ${n}`,
      };
    case "close":
      return {
        label: "Close",
        title: `Close ${n}?`,
        description: "It stays on GitHub and can be reopened. The branch is kept.",
        confirm: "Close pull request",
        pending: `Closing ${n}…`,
        done: `Closed ${n}`,
      };
    case "reopen":
      return {
        label: "Reopen",
        title: `Reopen ${n}?`,
        description: `It opens again with ${pullRequest.headRefName} as its branch.`,
        confirm: "Reopen",
        pending: `Reopening ${n}…`,
        done: `Reopened ${n}`,
      };
  }
};

/** The write an offer sends; Merge carries the picked method. */
export const actionPayload = (kind: PrActionKind, method: MergeMethod): PullRequestAction =>
  kind === "merge" ? { kind, method } : { kind };

export type PrActionOutcome =
  | { readonly ok: true; readonly view: PullRequestView }
  | { readonly ok: false; readonly message: string };

export interface PrActionToast {
  readonly loading: (message: string, options: { readonly id: string }) => unknown;
  readonly success: (message: string, options: { readonly id: string }) => unknown;
  readonly error: (message: string, options: { readonly id: string }) => unknown;
}

let runs = 0;

/**
 * Runs one confirmed action: a pending toast, then the same toast (by id) as
 * the outcome — `<Action> failed: <the server's words>` on a refusal, which
 * carries gh's install or sign-in sentence when gh is not ready and gh's own
 * reason when GitHub says no. A merge pins the head commit the pane showed.
 * The refresh of the tab and the marks is the one-shot's own
 * (`runPullRequestAction`).
 */
export const runPrAction = async (
  run: (action: PullRequestAction, headRefOid: string | undefined) => Promise<PrActionOutcome>,
  toast: PrActionToast,
  pullRequest: PullRequestDetail,
  kind: PrActionKind,
  method: MergeMethod,
): Promise<PrActionOutcome> => {
  runs += 1;
  const id = `pull-request-action-${runs}`;
  const copy = prActionCopy(kind, pullRequest);
  toast.loading(copy.pending, { id });
  const outcome = await run(
    actionPayload(kind, method),
    kind === "merge" ? pullRequest.headRefOid : undefined,
  );
  if (outcome.ok) {
    toast.success(copy.done, { id });
  } else {
    toast.error(`${copy.label} failed: ${outcome.message}`, { id });
  }
  return outcome;
};
