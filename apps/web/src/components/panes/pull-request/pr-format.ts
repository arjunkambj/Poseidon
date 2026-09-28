/**
 * The Pull request tab's pure half: how long a check ran, the checks' count
 * line, the latest verdict of each reviewer, review threads grouped by file,
 * and the text "Add to chat" puts in the composer. Tested without a DOM.
 */

import type {
  PullRequestCheck,
  PullRequestReview,
  PullRequestReviewThread,
} from "@poseidon/contracts/pullRequest";

import { formatElapsed, relativeTime } from "@/lib/format";

/** How long a finished check ran ("1m 05s"), or `null` while it runs or when GitHub gave no times. */
export const checkDuration = (check: PullRequestCheck): string | null => {
  if (check.startedAt === null || check.completedAt === null) {
    return null;
  }
  const ms = Date.parse(check.completedAt) - Date.parse(check.startedAt);
  return Number.isNaN(ms) ? null : formatElapsed(ms);
};

const BUCKET_WORDS: ReadonlyArray<readonly [PullRequestCheck["bucket"], string]> = [
  ["fail", "failing"],
  ["pending", "pending"],
  ["pass", "passing"],
  ["skipped", "skipped"],
];

/** "2 failing, 1 pending, 12 passing" — the buckets that have checks, in the list's order. */
export const checkSummary = (checks: ReadonlyArray<PullRequestCheck>): string => {
  if (checks.length === 0) {
    return "No checks";
  }
  return BUCKET_WORDS.flatMap(([bucket, word]) => {
    const count = checks.filter((check) => check.bucket === bucket).length;
    return count === 0 ? [] : [`${count} ${word}`];
  }).join(", ");
};

/**
 * One review per reviewer: the latest that says something about the change
 * (approved, changes requested, dismissed), else the latest comment-only
 * review — a later "commented" does not undo an approval, as on GitHub.
 * Pending (unsubmitted) reviews are left out. Newest first.
 */
export const latestReviews = (
  reviews: ReadonlyArray<PullRequestReview>,
): ReadonlyArray<PullRequestReview> => {
  const byAuthor = new Map<string, PullRequestReview>();
  const oldestFirst = reviews.toSorted((a, b) =>
    (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""),
  );
  for (const review of oldestFirst) {
    if (review.state === "pending") {
      continue;
    }
    const kept = byAuthor.get(review.author);
    const verdict = review.state !== "commented";
    const keptVerdict = kept !== undefined && kept.state !== "commented";
    if (kept === undefined || verdict || !keptVerdict) {
      byAuthor.set(review.author, review);
    }
  }
  return [...byAuthor.values()].sort((a, b) =>
    (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""),
  );
};

export interface ThreadGroup {
  readonly path: string;
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
}

/** Review threads by file, files in the order they first appear, threads by line within each. */
export const groupThreadsByFile = (
  threads: ReadonlyArray<PullRequestReviewThread>,
): ReadonlyArray<ThreadGroup> => {
  const groups = new Map<string, Array<PullRequestReviewThread>>();
  for (const thread of threads) {
    const group = groups.get(thread.path);
    if (group === undefined) {
      groups.set(thread.path, [thread]);
    } else {
      group.push(thread);
    }
  }
  return [...groups].map(([path, list]) => ({
    path,
    threads: list.toSorted((a, b) => (a.line ?? 0) - (b.line ?? 0)),
  }));
};

/** "line 12" under its file's heading, or "file" for a comment on the whole file. */
export const threadLineLabel = (thread: Pick<PullRequestReviewThread, "line">): string =>
  thread.line === null ? "file" : `line ${thread.line}`;

/**
 * A body as GitHub shows it: HTML comments — the markers bots leave for
 * themselves — are hidden there, so they are dropped here too.
 */
export const visibleBody = (body: string): string => body.replace(/<!--[\s\S]*?-->/gu, "").trim();

/** `src/app.ts:12`, or the bare path for a comment on the whole file. */
export const threadLocation = (thread: Pick<PullRequestReviewThread, "path" | "line">): string =>
  thread.line === null ? thread.path : `${thread.path}:${thread.line}`;

const quoted = (body: string): string =>
  visibleBody(body)
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");

/**
 * What "Add to chat" appends for a review comment: where it is, who wrote it,
 * and the comment as a quote — `` `src/app.ts:12` — @octo: `` then `> …`.
 */
export const reviewCommentQuote = (
  thread: Pick<PullRequestReviewThread, "path" | "line">,
  comment: { readonly author: string; readonly body: string },
): string => `\`${threadLocation(thread)}\` — @${comment.author}:\n${quoted(comment.body)}`;

/** What "Add to chat" appends for a conversation comment on pull request `number`. */
export const conversationQuote = (
  number: number,
  comment: { readonly author: string; readonly body: string },
): string => `Pull request #${number} — @${comment.author}:\n${quoted(comment.body)}`;

/** "updated 5m ago", "updated just now", "updated Mar 2025". */
export const updatedLabel = (nowMs: number, iso: string): string => {
  const ago = relativeTime(nowMs, iso);
  if (ago === "") {
    return "";
  }
  if (ago === "now") {
    return "updated just now";
  }
  return /^\d+[mhdw]$/u.test(ago) ? `updated ${ago} ago` : `updated ${ago}`;
};
