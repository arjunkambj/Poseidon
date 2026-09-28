/**
 * gh's JSON, turned into the pull request contract.
 *
 * Pure functions over what `gh pr view --json`, `gh pr list --json` and one
 * `gh api graphql` read print, so the tests can feed them JSON captured from
 * the real gh. gh's upper-case enums become the contract's lower-case ones
 * here and nowhere else. Every field is read defensively: a field gh leaves
 * out or empties (`reviewDecision` is `""` when a repository requires no
 * review) reads as its neutral value rather than failing the whole view.
 */
import type {
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetail,
  PullRequestReview,
  PullRequestReviewThread,
  PullRequestState,
} from "@poseidon/contracts/pullRequest";

type Json = Record<string, unknown>;

const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};

const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** A non-empty string, or `null`. */
const nonEmpty = (value: unknown): string | null => {
  const string = text(value);
  return string.length > 0 ? string : null;
};

/**
 * A timestamp, or `null` for none. GitHub reports a check that has not
 * started as starting at `0001-01-01T00:00:00Z`, which is none too.
 */
const timestamp = (value: unknown): string | null => {
  const string = nonEmpty(value);
  return string === null || string.startsWith("0001-") ? null : string;
};

/** A login, without the `app/` gh puts before a GitHub App's; `ghost` for a deleted account. */
const login = (author: unknown): string => {
  const name = text(record(author).login);
  const bare = name.startsWith("app/") ? name.slice("app/".length) : name;
  return bare.length > 0 ? bare : "ghost";
};

// ── Checks ─────────────────────────────────────────────────────

const FAILED_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const SKIPPED_CONCLUSIONS = new Set(["SKIPPED", "NEUTRAL"]);

const checkRunBucket = (status: string, conclusion: string): PullRequestCheck["bucket"] => {
  if (status !== "COMPLETED") return "pending";
  if (FAILED_CONCLUSIONS.has(conclusion)) return "fail";
  if (SKIPPED_CONCLUSIONS.has(conclusion)) return "skipped";
  return "pass";
};

const statusContextBucket = (state: string): PullRequestCheck["bucket"] => {
  if (state === "FAILURE" || state === "ERROR") return "fail";
  if (state === "SUCCESS") return "pass";
  return "pending";
};

/** The GitHub Actions job a check's URL names: `…/actions/runs/<run>/job/<job>`. */
export const jobIdOf = (url: string | null): string | null =>
  url === null ? null : (/\/actions\/runs\/\d+\/job\/(\d+)/.exec(url)?.[1] ?? null);

const BUCKET_ORDER: Record<PullRequestCheck["bucket"], number> = {
  fail: 0,
  pending: 1,
  pass: 2,
  skipped: 3,
};

/** One rollup entry, with the key its re-runs share. */
const checkOf = (value: unknown): { key: string; check: PullRequestCheck } | null => {
  const entry = record(value);
  if (entry.__typename === "StatusContext") {
    const name = nonEmpty(entry.context);
    if (name === null) return null;
    const url = nonEmpty(entry.targetUrl);
    return {
      key: `status\0${name}`,
      check: {
        name,
        workflow: null,
        bucket: statusContextBucket(text(entry.state)),
        startedAt: timestamp(entry.startedAt),
        completedAt: null,
        url,
        jobId: null,
      },
    };
  }
  const workflow = nonEmpty(entry.workflowName);
  const name = nonEmpty(entry.name) ?? workflow;
  if (name === null) return null;
  const url = nonEmpty(entry.detailsUrl);
  return {
    key: `run\0${workflow ?? ""}\0${name}`,
    check: {
      name,
      workflow,
      bucket: checkRunBucket(text(entry.status), text(entry.conclusion)),
      startedAt: timestamp(entry.startedAt),
      completedAt: timestamp(entry.completedAt),
      url,
      jobId: jobIdOf(url),
    },
  };
};

/** Which of two runs of one check is the newer: the later start, a started one over one queued. */
const newer = (a: PullRequestCheck, b: PullRequestCheck): PullRequestCheck =>
  (b.startedAt ?? "") > (a.startedAt ?? "") ? b : a;

/**
 * A `statusCheckRollup` as the pane lists it: one row per check, a re-run
 * replacing the run before it, failing first, then pending, passing and
 * skipped, by name within each.
 */
export const decodeChecks = (rollup: unknown): Array<PullRequestCheck> => {
  const byKey = new Map<string, PullRequestCheck>();
  for (const value of list(rollup)) {
    const decoded = checkOf(value);
    if (decoded === null) continue;
    const seen = byKey.get(decoded.key);
    byKey.set(decoded.key, seen === undefined ? decoded.check : newer(seen, decoded.check));
  }
  return [...byKey.values()].sort(
    (a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || a.name.localeCompare(b.name),
  );
};

// ── The pull request ───────────────────────────────────────────

const stateOf = (value: unknown): PullRequestState => {
  if (value === "MERGED") return "merged";
  if (value === "CLOSED") return "closed";
  return "open";
};

const mergeableOf = (value: unknown): PullRequestDetail["mergeable"] => {
  if (value === "MERGEABLE") return "mergeable";
  if (value === "CONFLICTING") return "conflicting";
  return "unknown";
};

const reviewDecisionOf = (value: unknown): PullRequestDetail["reviewDecision"] => {
  if (value === "APPROVED") return "approved";
  if (value === "CHANGES_REQUESTED") return "changes-requested";
  if (value === "REVIEW_REQUIRED") return "review-required";
  return null;
};

const REVIEW_STATES: Record<string, PullRequestReview["state"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "pending",
};

const reviewOf = (value: unknown): PullRequestReview => {
  const review = record(value);
  return {
    author: login(review.author),
    state: REVIEW_STATES[text(review.state)] ?? "commented",
    body: text(review.body),
    submittedAt: timestamp(review.submittedAt),
  };
};

/** A conversation comment or a review-thread comment: the two have the same shape. */
const commentOf = (value: unknown): PullRequestComment | null => {
  const comment = record(value);
  const url = nonEmpty(comment.url);
  const createdAt = nonEmpty(comment.createdAt);
  if (url === null || createdAt === null) return null;
  return { author: login(comment.author), body: text(comment.body), createdAt, url };
};

const comments = (values: unknown): Array<PullRequestComment> =>
  list(values).flatMap((value) => {
    const comment = commentOf(value);
    return comment === null ? [] : [comment];
  });

/** What `gh pr view --json` says, before the GraphQL read adds threads and merge methods. */
export type ViewedPullRequest = Omit<PullRequestDetail, "reviewThreads" | "mergeMethods">;

/**
 * `gh pr view --json number,title,url,state,isDraft,baseRefName,headRefName,
 * headRefOid,author,updatedAt,mergeable,reviewDecision,statusCheckRollup,
 * reviews,comments`, or `null` when the answer is not a pull request.
 */
export const decodePullRequestView = (json: unknown): ViewedPullRequest | null => {
  const view = record(json);
  const url = nonEmpty(view.url);
  const baseRefName = nonEmpty(view.baseRefName);
  const headRefName = nonEmpty(view.headRefName);
  const headRefOid = nonEmpty(view.headRefOid);
  const updatedAt = nonEmpty(view.updatedAt);
  if (
    typeof view.number !== "number" ||
    !Number.isInteger(view.number) ||
    url === null ||
    baseRefName === null ||
    headRefName === null ||
    headRefOid === null ||
    updatedAt === null
  ) {
    return null;
  }
  return {
    number: view.number,
    title: text(view.title),
    url,
    state: stateOf(view.state),
    isDraft: view.isDraft === true,
    baseRefName,
    headRefName,
    headRefOid,
    author: login(view.author),
    updatedAt,
    mergeable: mergeableOf(view.mergeable),
    reviewDecision: reviewDecisionOf(view.reviewDecision),
    checks: decodeChecks(view.statusCheckRollup),
    reviews: list(view.reviews).map(reviewOf),
    comments: comments(view.comments),
  };
};

// ── Review threads and merge methods (GraphQL) ────────────────

/** Every merge method, for when the repository's settings could not be read. */
export const ALL_MERGE_METHODS: PullRequestDetail["mergeMethods"] = {
  merge: true,
  squash: true,
  rebase: true,
};

const allowed = (value: unknown): boolean => value !== false;

const threadOf = (value: unknown): PullRequestReviewThread | null => {
  const thread = record(value);
  const id = nonEmpty(thread.id);
  const path = nonEmpty(thread.path);
  if (id === null || path === null) return null;
  const line = typeof thread.line === "number" ? thread.line : thread.originalLine;
  return {
    id,
    path,
    line: typeof line === "number" && Number.isInteger(line) ? line : null,
    isResolved: thread.isResolved === true,
    isOutdated: thread.isOutdated === true,
    comments: comments(record(thread.comments).nodes),
  };
};

/** The review threads and allowed merge methods out of the one GraphQL read. */
export const decodeReviewData = (
  json: unknown,
): Pick<PullRequestDetail, "reviewThreads" | "mergeMethods"> => {
  const repository = record(record(record(json).data).repository);
  const threads = record(record(repository.pullRequest).reviewThreads).nodes;
  return {
    reviewThreads: list(threads).flatMap((value) => {
      const thread = threadOf(value);
      return thread === null ? [] : [thread];
    }),
    mergeMethods: {
      merge: allowed(repository.mergeCommitAllowed),
      squash: allowed(repository.squashMergeAllowed),
      rebase: allowed(repository.rebaseMergeAllowed),
    },
  };
};

/** The host, owner and name of a pull request's repository, from its URL. */
export const repositoryOf = (
  url: string,
): { readonly host: string; readonly owner: string; readonly name: string } | null => {
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url);
  return match === null ? null : { host: match[1]!, owner: match[2]!, name: match[3]! };
};

// ── The repository's list ──────────────────────────────────────

/** One row of `gh pr list --json number,url,state,isDraft,headRefName,updatedAt,statusCheckRollup`. */
export interface ListedPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly headRefName: string;
  readonly updatedAt: string;
  readonly failing: boolean;
}

export const decodePullRequestList = (json: unknown): Array<ListedPullRequest> =>
  list(json).flatMap((value) => {
    const row = record(value);
    const url = nonEmpty(row.url);
    const headRefName = nonEmpty(row.headRefName);
    if (typeof row.number !== "number" || url === null || headRefName === null) return [];
    return [
      {
        number: row.number,
        url,
        state: stateOf(row.state),
        isDraft: row.isDraft === true,
        headRefName,
        updatedAt: text(row.updatedAt),
        failing: decodeChecks(row.statusCheckRollup).some((check) => check.bucket === "fail"),
      },
    ];
  });

/** A branch's pull request out of a list: an open one first, then the newest. */
export const pullRequestForBranch = (
  rows: ReadonlyArray<ListedPullRequest>,
  branch: string,
): ListedPullRequest | null => {
  let best: ListedPullRequest | null = null;
  for (const row of rows) {
    if (row.headRefName !== branch) continue;
    if (
      best === null ||
      (row.state === "open" && best.state !== "open") ||
      ((row.state === "open") === (best.state === "open") && row.updatedAt > best.updatedAt)
    ) {
      best = row;
    }
  }
  return best;
};
