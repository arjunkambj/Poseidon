import { describe, expect, it } from "vitest";

import type { PullRequestCheck, PullRequestDetail } from "@poseidon/contracts/pullRequest";

import { buildFixPrompt, fixKinds, fixNeedsContext, previewText } from "./pr-fix-prompt";

const check = (name: string, bucket: PullRequestCheck["bucket"]): PullRequestCheck => ({
  name,
  workflow: "CI",
  bucket,
  startedAt: null,
  completedAt: null,
  url: `https://github.com/o/r/actions/runs/1/job/${name}`,
  jobId: null,
});

const base: PullRequestDetail = {
  number: 42,
  title: "Teach the parser about tabs",
  url: "https://github.com/o/r/pull/42",
  state: "open",
  isDraft: false,
  baseRefName: "main",
  headRefName: "tabs",
  headRefOid: "0123456789abcdef0123456789abcdef01234567",
  author: "ana",
  updatedAt: "2026-09-28T11:00:00Z",
  mergeable: "mergeable",
  reviewDecision: null,
  checks: [check("lint", "fail"), check("unit", "pass")],
  reviews: [
    {
      author: "ben",
      state: "changes-requested",
      body: "Please keep the width.",
      submittedAt: "2026-09-28T10:30:00Z",
    },
  ],
  reviewThreads: [
    {
      id: "T1",
      path: "src/parse.ts",
      line: 12,
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          author: "ben",
          body: "This drops the tab width.\n<!-- bot marker -->",
          createdAt: "2026-09-28T10:29:00Z",
          url: "https://github.com/o/r/pull/42#discussion_r1",
        },
        {
          author: "ana",
          body: "Which width?",
          createdAt: "2026-09-28T10:31:00Z",
          url: "https://github.com/o/r/pull/42#discussion_r2",
        },
      ],
    },
    {
      id: "T2",
      path: "src/lex.ts",
      line: 3,
      isResolved: true,
      isOutdated: false,
      comments: [
        {
          author: "ben",
          body: "Fixed already.",
          createdAt: "2026-09-28T10:28:00Z",
          url: "https://github.com/o/r/pull/42#discussion_r3",
        },
      ],
    },
  ],
  comments: [],
  mergeMethods: { merge: true, squash: true, rebase: true },
};

describe("fixKinds", () => {
  it("offers each fix only while it applies", () => {
    expect(fixKinds(base)).toEqual(["checks", "reviews"]);
    expect(fixKinds({ ...base, mergeable: "conflicting" })).toEqual([
      "checks",
      "conflicts",
      "reviews",
    ]);
    const clean = {
      ...base,
      checks: [check("unit", "pass")],
      reviewThreads: base.reviewThreads.filter((thread) => thread.isResolved),
    };
    expect(fixKinds(clean)).toEqual([]);
    // A change request alone is enough for the reviews fix.
    expect(fixKinds({ ...clean, reviewDecision: "changes-requested" })).toEqual(["reviews"]);
  });

  it("offers nothing once the pull request is merged or closed", () => {
    expect(fixKinds({ ...base, state: "merged" })).toEqual([]);
    expect(fixKinds({ ...base, state: "closed", mergeable: "conflicting" })).toEqual([]);
  });

  it("reads context for checks and conflicts only", () => {
    expect(fixNeedsContext("checks")).toBe(true);
    expect(fixNeedsContext("conflicts")).toBe(true);
    expect(fixNeedsContext("reviews")).toBe(false);
  });
});

describe("buildFixPrompt", () => {
  it("names the pull request, its link and its branches first", () => {
    const text = buildFixPrompt("reviews", base, null);
    expect(text.split("\n").slice(0, 3)).toEqual([
      "Address the review comments on pull request #42: Teach the parser about tabs",
      "https://github.com/o/r/pull/42",
      "Branch: tabs → main",
    ]);
  });

  it("carries each failing check with its log tail fenced past any backticks in it", () => {
    const text = buildFixPrompt("checks", base, {
      base: "main",
      checks: [
        {
          name: "lint",
          url: "https://github.com/o/r/actions/runs/1/job/7",
          logTail: "src/a.ts:1 error ```x```\n##[error]Process completed with exit code 1.",
        },
        { name: "vercel", url: null, logTail: null },
      ],
      conflictFiles: [],
    });
    expect(text).toContain("- lint (https://github.com/o/r/actions/runs/1/job/7)");
    expect(text).toContain(
      "Failed log of lint, last lines:\n````\nsrc/a.ts:1 error ```x```\n##[error]Process completed with exit code 1.\n````",
    );
    expect(text).toContain("- vercel\n");
    expect(text).not.toContain("unit");
  });

  it("previews the checks by name before their logs are read", () => {
    const text = buildFixPrompt("checks", base, null);
    expect(text).toContain("- lint (https://github.com/o/r/actions/runs/1/job/lint)");
    expect(text).not.toContain("Failed log");
  });

  it("lists the conflicting files as of the last fetch and says to fetch and merge", () => {
    const text = buildFixPrompt("conflicts", base, {
      base: "origin/main",
      checks: [],
      conflictFiles: ["src/a.ts", "README.md"],
    });
    expect(text).toContain(
      "As of the last fetch, merging origin/main into this branch conflicts in:\n- src/a.ts\n- README.md",
    );
    expect(text).toContain("Fetch, merge origin/main into this branch and resolve every conflict");
    const stale = buildFixPrompt("conflicts", base, {
      base: "origin/main",
      checks: [],
      conflictFiles: [],
    });
    expect(stale).toContain("found no conflicting files here");
  });

  it("quotes every unresolved thread as path:line with its authors, leaving resolved ones out", () => {
    const text = buildFixPrompt("reviews", { ...base, reviewDecision: "changes-requested" }, null);
    expect(text).toContain("A reviewer requested changes.");
    expect(text).toContain("- @ben: Please keep the width.");
    expect(text).toContain(
      "- src/parse.ts:12 @ben: This drops the tab width.\n  - reply @ana: Which width?",
    );
    expect(text).not.toContain("bot marker");
    expect(text).not.toContain("Fixed already.");
  });

  it("cuts the confirm's preview", () => {
    expect(previewText("short")).toBe("short");
    expect(previewText("a".repeat(700), 10)).toBe(`${"a".repeat(10)}…`);
  });
});
