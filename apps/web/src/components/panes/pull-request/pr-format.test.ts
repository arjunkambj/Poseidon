import { describe, expect, it } from "vitest";

import type {
  PullRequestCheck,
  PullRequestReview,
  PullRequestReviewThread,
} from "@poseidon/contracts/pullRequest";

import {
  checkDuration,
  checkSummary,
  conversationQuote,
  groupThreadsByFile,
  latestReviews,
  reviewCommentQuote,
  threadLineLabel,
  threadLocation,
  updatedLabel,
  visibleBody,
} from "./pr-format";

const check = (overrides: Partial<PullRequestCheck>): PullRequestCheck => ({
  name: "build",
  workflow: "CI",
  bucket: "pass",
  startedAt: "2026-09-01T10:00:00Z",
  completedAt: "2026-09-01T10:01:05Z",
  url: "https://github.com/o/r/actions/runs/1/job/2",
  jobId: "2",
  ...overrides,
});

const review = (
  author: string,
  state: PullRequestReview["state"],
  submittedAt: string,
  body = "",
): PullRequestReview => ({ author, state, body, submittedAt });

const thread = (
  id: string,
  path: string,
  line: number | null,
  isResolved = false,
): PullRequestReviewThread => ({
  id,
  path,
  line,
  isResolved,
  isOutdated: false,
  comments: [],
});

describe("checkDuration", () => {
  it("reads a finished check's run time", () => {
    expect(checkDuration(check({}))).toBe("1m 05s");
  });

  it("says nothing while it runs, or without times", () => {
    expect(checkDuration(check({ completedAt: null }))).toBeNull();
    expect(checkDuration(check({ startedAt: null }))).toBeNull();
  });
});

describe("checkSummary", () => {
  it("counts the buckets that have checks, failing first", () => {
    const checks = [
      check({ bucket: "fail" }),
      check({ bucket: "fail" }),
      check({ bucket: "pass" }),
      check({ bucket: "skipped" }),
    ];
    expect(checkSummary(checks)).toBe("2 failing, 1 passing, 1 skipped");
  });

  it("says when there are none", () => {
    expect(checkSummary([])).toBe("No checks");
  });
});

describe("latestReviews", () => {
  it("keeps each reviewer's latest verdict, newest reviewer first", () => {
    const reviews = [
      review("ana", "changes-requested", "2026-09-01T10:00:00Z"),
      review("ben", "commented", "2026-09-01T11:00:00Z", "looks fine"),
      review("ana", "approved", "2026-09-02T10:00:00Z"),
    ];
    expect(latestReviews(reviews).map((r) => [r.author, r.state])).toEqual([
      ["ana", "approved"],
      ["ben", "commented"],
    ]);
  });

  it("does not let a later comment undo an approval, and drops pending reviews", () => {
    const reviews = [
      review("ana", "approved", "2026-09-01T10:00:00Z"),
      review("ana", "commented", "2026-09-02T10:00:00Z", "one nit"),
      review("cy", "pending", "2026-09-03T10:00:00Z"),
    ];
    expect(latestReviews(reviews).map((r) => [r.author, r.state])).toEqual([["ana", "approved"]]);
  });
});

describe("groupThreadsByFile", () => {
  it("groups by file in order of first appearance, by line within", () => {
    const groups = groupThreadsByFile([
      thread("a", "src/b.ts", 30),
      thread("b", "src/a.ts", 4),
      thread("c", "src/b.ts", 2),
    ]);
    expect(groups.map((g) => [g.path, g.threads.map((t) => t.id)])).toEqual([
      ["src/b.ts", ["c", "a"]],
      ["src/a.ts", ["b"]],
    ]);
  });
});

describe("quotes", () => {
  it("names the line and the author, and quotes every line of the body", () => {
    expect(
      reviewCommentQuote(thread("a", "src/app.ts", 12), {
        author: "octo",
        body: "Rename this.\n\nIt shadows `name`.",
      }),
    ).toBe("`src/app.ts:12` — @octo:\n> Rename this.\n>\n> It shadows `name`.");
  });

  it("names the file alone for a whole-file comment", () => {
    expect(threadLocation(thread("a", "README.md", null))).toBe("README.md");
    expect(threadLineLabel(thread("a", "README.md", null))).toBe("file");
    expect(threadLineLabel(thread("a", "README.md", 7))).toBe("line 7");
  });

  it("drops the HTML comments GitHub hides, in the body and in the quote", () => {
    expect(visibleBody("<!-- bot-marker -->\nLooks good\n<!--\nmore\n-->")).toBe("Looks good");
    expect(conversationQuote(1, { author: "bot", body: "<!-- x -->Hi" })).toBe(
      "Pull request #1 — @bot:\n> Hi",
    );
  });

  it("names the pull request for a conversation comment", () => {
    expect(conversationQuote(42, { author: "ana", body: "Ship it " })).toBe(
      "Pull request #42 — @ana:\n> Ship it",
    );
  });
});

describe("updatedLabel", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");

  it("reads short spans as ago, a moment as just now, and old dates by month", () => {
    expect(updatedLabel(now, "2026-09-28T11:55:00Z")).toBe("updated 5m ago");
    expect(updatedLabel(now, "2026-09-28T11:59:40Z")).toBe("updated just now");
    expect(updatedLabel(now, "2024-03-02T12:00:00Z")).toBe("updated Mar 2024");
    expect(updatedLabel(now, "not a date")).toBe("");
  });
});
