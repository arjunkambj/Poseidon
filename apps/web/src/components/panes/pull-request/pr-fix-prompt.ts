/**
 * The Fix menu's pure half: which fixes a pull request offers, and the first
 * message of the thread each one starts.
 *
 * - **Fix failing checks** — while a check failed: the failing checks by name
 *   with a link, and the tail of each failed log the server could read, fenced.
 * - **Resolve conflicts** — while GitHub says the branch conflicts with its
 *   base: the files a merge of the base would conflict in, as of the last
 *   fetch, and the instruction to fetch, merge the base and resolve them.
 * - **Address review comments** — while a review thread is unresolved or a
 *   reviewer requested changes: every unresolved thread as `path:line`, each
 *   comment's author and body, and the change-requesting reviews' summaries.
 *
 * Every message opens with the pull request's number, title, link and
 * head → base, so the agent knows what it is fixing without a lookup. Only
 * an open pull request offers fixes.
 */

import type {
  PullRequestDetail,
  PullRequestFixContext,
  PullRequestReviewThread,
} from "@poseidon/contracts/pullRequest";

import { latestReviews, threadLocation, visibleBody } from "./pr-format";

export type FixKind = "checks" | "conflicts" | "reviews";

export const FIX_LABELS: Record<FixKind, string> = {
  checks: "Fix failing checks",
  conflicts: "Resolve conflicts",
  reviews: "Address review comments",
};

const unresolvedThreads = (
  pullRequest: Pick<PullRequestDetail, "reviewThreads">,
): ReadonlyArray<PullRequestReviewThread> =>
  pullRequest.reviewThreads.filter((thread) => !thread.isResolved);

/** The fixes that apply to the pull request now, in the menu's order. */
export const fixKinds = (
  pullRequest: Pick<
    PullRequestDetail,
    "state" | "checks" | "mergeable" | "reviewThreads" | "reviewDecision"
  >,
): ReadonlyArray<FixKind> => {
  if (pullRequest.state !== "open") {
    return [];
  }
  const kinds: Array<FixKind> = [];
  if (pullRequest.checks.some((check) => check.bucket === "fail")) {
    kinds.push("checks");
  }
  if (pullRequest.mergeable === "conflicting") {
    kinds.push("conflicts");
  }
  if (
    unresolvedThreads(pullRequest).length > 0 ||
    pullRequest.reviewDecision === "changes-requested"
  ) {
    kinds.push("reviews");
  }
  return kinds;
};

/** Whether a fix reads `git.pullRequest.fixContext` before its thread starts. */
export const fixNeedsContext = (kind: FixKind): kind is "checks" | "conflicts" =>
  kind !== "reviews";

/** A fence longer than any run of backticks in `text`, so a log cannot close it early. */
const fenced = (text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text.replace(/\n+$/u, "")}\n${fence}`;
};

/** Indents every line after the first, so a multi-line body stays under its bullet. */
const indentRest = (text: string, by: string): string => text.split("\n").join(`\n${by}`);

const header = (
  pullRequest: Pick<PullRequestDetail, "number" | "title" | "url" | "headRefName" | "baseRefName">,
  what: string,
): string =>
  [
    `${what} on pull request #${pullRequest.number}: ${pullRequest.title}`,
    pullRequest.url,
    `Branch: ${pullRequest.headRefName} → ${pullRequest.baseRefName}`,
  ].join("\n");

const checksBody = (
  pullRequest: Pick<PullRequestDetail, "checks">,
  context: PullRequestFixContext | null,
): string => {
  const checks =
    context?.checks ??
    pullRequest.checks
      .filter((check) => check.bucket === "fail")
      .map((check) => ({ name: check.name, url: check.url, logTail: null }));
  const lines = ["Failing checks:"];
  for (const check of checks) {
    lines.push(`- ${check.name}${check.url === null ? "" : ` (${check.url})`}`);
    if (check.logTail !== null && check.logTail.trim() !== "") {
      lines.push("", `Failed log of ${check.name}, last lines:`, fenced(check.logTail), "");
    }
  }
  while (lines.at(-1) === "") {
    lines.pop();
  }
  lines.push(
    "",
    "Find the cause of each failure and fix it on this branch. Where there is no log above, open the check's link or run the check locally. Run what failed before you commit.",
  );
  return lines.join("\n");
};

const conflictsBody = (
  pullRequest: Pick<PullRequestDetail, "baseRefName">,
  context: PullRequestFixContext | null,
): string => {
  const base = context?.base ?? `origin/${pullRequest.baseRefName}`;
  const files = context?.conflictFiles ?? [];
  const lines: Array<string> = [];
  if (context === null) {
    lines.push(`GitHub reports that this branch conflicts with ${pullRequest.baseRefName}.`);
  } else if (files.length === 0) {
    lines.push(
      `GitHub reports that this branch conflicts with ${pullRequest.baseRefName}, but as of the last fetch a merge of ${base} found no conflicting files here — the remote has likely moved on.`,
    );
  } else {
    lines.push(`As of the last fetch, merging ${base} into this branch conflicts in:`);
    for (const file of files) {
      lines.push(`- ${file}`);
    }
  }
  lines.push(
    "",
    `Fetch, merge ${base} into this branch and resolve every conflict, keeping the intent of both sides. Then run the checks and commit the merge.`,
  );
  return lines.join("\n");
};

const reviewsBody = (
  pullRequest: Pick<PullRequestDetail, "reviewThreads" | "reviews" | "reviewDecision">,
): string => {
  const lines: Array<string> = [];
  if (pullRequest.reviewDecision === "changes-requested") {
    lines.push("A reviewer requested changes.");
  }
  const requesting = latestReviews(pullRequest.reviews).filter(
    (review) => review.state === "changes-requested" && visibleBody(review.body) !== "",
  );
  if (requesting.length > 0) {
    lines.push("", "Review summaries:");
    for (const review of requesting) {
      lines.push(`- @${review.author}: ${indentRest(visibleBody(review.body), "  ")}`);
    }
  }
  const threads = unresolvedThreads(pullRequest);
  if (threads.length > 0) {
    lines.push("", "Unresolved review threads:");
    for (const thread of threads) {
      const [first, ...replies] = thread.comments;
      const outdated = thread.isOutdated ? " (outdated)" : "";
      lines.push(
        `- ${threadLocation(thread)}${outdated}${
          first === undefined
            ? ""
            : ` @${first.author}: ${indentRest(visibleBody(first.body), "  ")}`
        }`,
      );
      for (const reply of replies) {
        lines.push(`  - reply @${reply.author}: ${indentRest(visibleBody(reply.body), "    ")}`);
      }
    }
  }
  lines.push(
    "",
    "Address each comment: change the code, or say why not. Run the checks before you commit.",
  );
  return lines.join("\n").replace(/^\n/u, "");
};

/**
 * The fix thread's first message. `context` is `git.pullRequest.fixContext`'s
 * answer; `null` builds the confirm's preview before it is read — the checks
 * by name without their logs, the conflict without its files.
 */
export const buildFixPrompt = (
  kind: FixKind,
  pullRequest: PullRequestDetail,
  context: PullRequestFixContext | null,
): string => {
  switch (kind) {
    case "checks":
      return `${header(pullRequest, "Fix the failing checks")}\n\n${checksBody(pullRequest, context)}`;
    case "conflicts":
      return `${header(pullRequest, "Resolve the merge conflicts")}\n\n${conflictsBody(pullRequest, context)}`;
    case "reviews":
      return `${header(pullRequest, "Address the review comments")}\n\n${reviewsBody(pullRequest)}`;
  }
};

/** The confirm's preview: the message cut to `max` characters. */
export const previewText = (text: string, max = 600): string =>
  text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
