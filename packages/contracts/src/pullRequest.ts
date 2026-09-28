/**
 * A branch's pull request as the pull request pane reads it, and the small
 * per-thread marks the sidebar tints its rows with.
 *
 * Kept apart from `rpc.ts` and `git.ts` for the reason `git.ts` is: the method
 * names are spread into `RPC_METHODS`, and `rpc.ts` lists the RPCs in
 * `PoseidonRpcGroup`. Everything here is read through the GitHub CLI on the
 * server; gh's upper-case enums (`OPEN`, `CHANGES_REQUESTED`) arrive
 * lower-cased and hyphenated (`open`, `changes-requested`), so the renderer
 * never matches on gh's spelling.
 */

import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { IsoDateTime, NonEmptyString } from "./base";
import { ProjectId, ThreadId } from "./ids";
import { PoseidonRpcError } from "./rpcError";

export const PullRequestState = Schema.Literals(["open", "closed", "merged"]);
export type PullRequestState = typeof PullRequestState.Type;

/**
 * One check on the pull request's head commit — a GitHub Actions job or a
 * commit status — sorted into the four buckets the pane shows: `fail`
 * (failed, timed out, cancelled, needs action), `pending` (queued or
 * running), `pass`, and `skipped` (skipped or neutral). `workflow` is the
 * Actions workflow's name, `null` for a commit status. `jobId` is the Actions
 * job behind the check when its URL names one — what a failed-log read needs —
 * and `null` for anything else.
 */
export const PullRequestCheck = Schema.Struct({
  name: NonEmptyString,
  workflow: Schema.NullOr(NonEmptyString),
  bucket: Schema.Literals(["fail", "pending", "pass", "skipped"]),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  url: Schema.NullOr(NonEmptyString),
  jobId: Schema.NullOr(NonEmptyString),
});
export type PullRequestCheck = typeof PullRequestCheck.Type;

/** A submitted review: its verdict and the summary written with it (often empty). */
export const PullRequestReview = Schema.Struct({
  author: NonEmptyString,
  state: Schema.Literals(["approved", "changes-requested", "commented", "dismissed", "pending"]),
  body: Schema.String,
  submittedAt: Schema.NullOr(IsoDateTime),
});
export type PullRequestReview = typeof PullRequestReview.Type;

/** One comment in a review thread. */
export const PullRequestReviewComment = Schema.Struct({
  author: NonEmptyString,
  body: Schema.String,
  createdAt: IsoDateTime,
  url: NonEmptyString,
});
export type PullRequestReviewComment = typeof PullRequestReviewComment.Type;

/**
 * A conversation anchored to a line of the diff. `line` is the line in the
 * head's version of `path`; an outdated thread (`isOutdated`) no longer has
 * one, so it carries the line it was written against instead, and `null` when
 * GitHub knows neither (a comment on the whole file).
 */
export const PullRequestReviewThread = Schema.Struct({
  id: NonEmptyString,
  path: NonEmptyString,
  line: Schema.NullOr(Schema.Int),
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  comments: Schema.Array(PullRequestReviewComment),
});
export type PullRequestReviewThread = typeof PullRequestReviewThread.Type;

/** A comment on the pull request's conversation, not on a line. */
export const PullRequestComment = Schema.Struct({
  author: NonEmptyString,
  body: Schema.String,
  createdAt: IsoDateTime,
  url: NonEmptyString,
});
export type PullRequestComment = typeof PullRequestComment.Type;

/**
 * Everything the pane shows about one pull request. `headRefOid` is the head
 * commit the reader saw, which a merge pins so it cannot land a newer one.
 * `mergeable` is GitHub's answer, `unknown` while it is still computing it
 * (and always, once merged). `checks` come failing first, then pending,
 * passing and skipped. `mergeMethods` says which merges the repository allows;
 * when that could not be read every method is offered and GitHub refuses the
 * wrong one itself.
 */
export const PullRequestDetail = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: NonEmptyString,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  baseRefName: NonEmptyString,
  headRefName: NonEmptyString,
  headRefOid: NonEmptyString,
  author: NonEmptyString,
  updatedAt: IsoDateTime,
  mergeable: Schema.Literals(["mergeable", "conflicting", "unknown"]),
  reviewDecision: Schema.NullOr(
    Schema.Literals(["approved", "changes-requested", "review-required"]),
  ),
  checks: Schema.Array(PullRequestCheck),
  reviews: Schema.Array(PullRequestReview),
  reviewThreads: Schema.Array(PullRequestReviewThread),
  comments: Schema.Array(PullRequestComment),
  mergeMethods: Schema.Struct({
    merge: Schema.Boolean,
    squash: Schema.Boolean,
    rebase: Schema.Boolean,
  }),
});
export type PullRequestDetail = typeof PullRequestDetail.Type;

/**
 * The pull request of the workspace's current branch. `unavailable` when gh
 * is missing or signed out, with gh's fix in `reason`; `none` when the branch
 * has no pull request (`branch` is `null` on a detached HEAD or outside a
 * repository); `found` otherwise — merged and closed ones included.
 */
export const PullRequestView = Schema.Union([
  Schema.Struct({ state: Schema.Literal("unavailable"), reason: NonEmptyString }),
  Schema.Struct({ state: Schema.Literal("none"), branch: Schema.NullOr(NonEmptyString) }),
  Schema.Struct({ state: Schema.Literal("found"), pullRequest: PullRequestDetail }),
]);
export type PullRequestView = typeof PullRequestView.Type;

/**
 * What the sidebar needs to tint one thread's row: the pull request of the
 * branch that thread works on. `failing` is true when any of its checks failed.
 */
export const PullRequestMark = Schema.Struct({
  threadId: ThreadId,
  number: Schema.Int,
  url: NonEmptyString,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  failing: Schema.Boolean,
});
export type PullRequestMark = typeof PullRequestMark.Type;

/** One mark per thread that has a pull request; threads without one are left out. */
export const PullRequestMarks = Schema.Struct({
  marks: Schema.Array(PullRequestMark),
});
export type PullRequestMarks = typeof PullRequestMarks.Type;

/**
 * A write to a pull request, each one a single gh command: mark it ready for
 * review, turn it back into a draft, merge it with one of the repository's
 * methods, close it, or reopen it.
 */
export const PullRequestAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready") }),
  Schema.Struct({ kind: Schema.Literal("draft") }),
  Schema.Struct({
    kind: Schema.Literal("merge"),
    method: Schema.Literals(["merge", "squash", "rebase"]),
  }),
  Schema.Struct({ kind: Schema.Literal("close") }),
  Schema.Struct({ kind: Schema.Literal("reopen") }),
]);
export type PullRequestAction = typeof PullRequestAction.Type;

/**
 * What a "fix" thread is seeded with. `checks` are the failing checks, each
 * with the tail of its failed log when one could be read (GitHub Actions jobs
 * only, `null` otherwise); `conflictFiles` are the files a merge of the base
 * into the branch would conflict in, as of the last fetch; `base` is what they
 * were read against — the remote-tracking ref (`origin/main`) for conflicts,
 * the pull request's base branch for checks.
 */
export const PullRequestFixContext = Schema.Struct({
  checks: Schema.Array(
    Schema.Struct({
      name: NonEmptyString,
      url: Schema.NullOr(NonEmptyString),
      logTail: Schema.NullOr(Schema.String),
    }),
  ),
  conflictFiles: Schema.Array(NonEmptyString),
  base: NonEmptyString,
});
export type PullRequestFixContext = typeof PullRequestFixContext.Type;

// ── Method names and RPCs ──────────────────────────────────────

/** Spread into `RPC_METHODS`, so the names stay in the one table. */
export const PULL_REQUEST_RPC_METHODS = {
  gitPullRequestView: "git.pullRequest.view",
  gitPullRequestMarks: "git.pullRequest.marks",
  gitPullRequestAction: "git.pullRequest.action",
  gitPullRequestFixContext: "git.pullRequest.fixContext",
} as const;

/** A pull request's number as gh takes it. */
const PullRequestNumber = Schema.Int.check(Schema.isGreaterThan(0));

/** A commit id, full or abbreviated: the only shape a merge will pin. */
const CommitOid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,64}$/i));

/**
 * The pull request of the current branch of the thread's root when
 * `threadId` is set, the project's otherwise. Never an error for gh missing,
 * signed out or finding nothing — those are the `unavailable` and `none`
 * answers; `conflict` carries gh's words when it refuses for any other reason.
 */
export const GitPullRequestViewRpc = Rpc.make(PULL_REQUEST_RPC_METHODS.gitPullRequestView, {
  payload: Schema.Struct({ projectId: ProjectId, threadId: Schema.optional(ThreadId) }),
  success: PullRequestView,
  error: PoseidonRpcError,
});

/**
 * A mark for every live thread of the project whose branch has a pull request,
 * from one listing per distinct branch of that branch's own pull requests, a
 * fork's from a branch of the same name told apart by its owner. Empty, not an
 * error, when gh is missing or signed out or the project is not a repository.
 */
export const GitPullRequestMarksRpc = Rpc.make(PULL_REQUEST_RPC_METHODS.gitPullRequestMarks, {
  payload: Schema.Struct({ projectId: ProjectId }),
  success: PullRequestMarks,
  error: PoseidonRpcError,
});

/**
 * Runs `action` on pull request `number` in the thread's root (the project's
 * when `threadId` is unset) and answers the view as it is afterwards. A merge
 * given `headRefOid` only lands that head commit, so a pane that is out of
 * date cannot merge a commit its user never saw. `unavailable` when gh is
 * missing or signed out; `conflict` with gh's own words when GitHub refuses.
 */
export const GitPullRequestActionRpc = Rpc.make(PULL_REQUEST_RPC_METHODS.gitPullRequestAction, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    number: PullRequestNumber,
    headRefOid: Schema.optional(CommitOid),
    action: PullRequestAction,
  }),
  success: PullRequestView,
  error: PoseidonRpcError,
});

/**
 * The context a new thread fixing pull request `number` starts from: its
 * failing checks with their log tails (`kind: "checks"`), or the files that
 * conflict with its base (`kind: "conflicts"`). Nothing is fetched first.
 * Review comments need no call: the view already carries them.
 */
export const GitPullRequestFixContextRpc = Rpc.make(
  PULL_REQUEST_RPC_METHODS.gitPullRequestFixContext,
  {
    payload: Schema.Struct({
      projectId: ProjectId,
      threadId: Schema.optional(ThreadId),
      number: PullRequestNumber,
      kind: Schema.Literals(["checks", "conflicts"]),
    }),
    success: PullRequestFixContext,
    error: PoseidonRpcError,
  },
);
