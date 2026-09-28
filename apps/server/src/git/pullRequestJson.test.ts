/**
 * Decoding gh's pull request JSON. The fixtures under `fixtures/` are real gh
 * 2.92.0 answers, captured read-only from public repositories and trimmed:
 * human logins replaced, bodies cut to their first line.
 */
import { describe, expect, it } from "@effect/vitest";
import { readFileSync } from "node:fs";

import {
  decodeChecks,
  decodePullRequestList,
  decodePullRequestView,
  decodeReviewData,
  jobIdOf,
  pullRequestForBranch,
  repositoryOf,
} from "./pullRequestJson";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const rollupOf = (name: string) =>
  (fixture(name) as { statusCheckRollup: Array<Record<string, unknown>> }).statusCheckRollup;

describe("decodePullRequestView", () => {
  it("reads an open pull request with requested changes", () => {
    const view = decodePullRequestView(fixture("gh-pr-view.open.json"))!;
    expect(view).toMatchObject({
      number: 14519,
      url: "https://github.com/cli/cli/pull/14519",
      state: "open",
      isDraft: false,
      baseRefName: "trunk",
      headRefName: "document-search-operator-support",
      headRefOid: "97577e407ff3aee505aec675da081da75a24224a",
      author: "user-1",
      mergeable: "mergeable",
      reviewDecision: "changes-requested",
    });
    expect(view.reviews.map((review) => [review.author, review.state])).toEqual([
      ["copilot-pull-request-reviewer", "commented"],
      ["user-2", "changes-requested"],
    ]);
    expect(view.comments[0]).toEqual({
      author: "github-actions",
      body: expect.stringContaining("Thanks for your pull request!"),
      createdAt: "2026-09-25T15:34:01Z",
      url: "https://github.com/cli/cli/pull/14519#issuecomment-5835049811",
    });
  });

  it("reads a closed one, a bot author without its app/ prefix", () => {
    const view = decodePullRequestView(fixture("gh-pr-view.failing.json"))!;
    expect(view.state).toBe("closed");
    expect(view.author).toBe("github-actions");
    expect(view.checks[0]).toMatchObject({ name: "govulncheck", bucket: "fail" });
  });

  it("reads gh's empty review decision as none", () => {
    const view = decodePullRequestView(fixture("gh-pr-view.status-context.json"))!;
    expect(view.reviewDecision).toBeNull();
    expect(view.reviews).toEqual([]);
  });

  it("refuses an answer that is not a pull request", () => {
    expect(decodePullRequestView(null)).toBeNull();
    expect(decodePullRequestView({ number: 1 })).toBeNull();
  });
});

describe("decodeChecks", () => {
  it("buckets check runs and sorts failing first, then pass, then skipped", () => {
    const checks = decodeChecks(rollupOf("gh-pr-view.failing.json"));
    expect(checks.map((check) => [check.name, check.bucket])).toEqual([
      ["govulncheck", "fail"],
      ["CodeQL-Build (go, manual, ./.github/codeql/codeql-config.yml)", "pass"],
      ["lint", "pass"],
    ]);
    expect(checks[0]).toEqual({
      name: "govulncheck",
      workflow: "Lint",
      bucket: "fail",
      startedAt: "2026-09-11T05:20:10Z",
      completedAt: "2026-09-11T05:20:55Z",
      url: "https://github.com/cli/cli/actions/runs/34558150659/job/103156848767",
      jobId: "103156848767",
    });
    const open = decodeChecks(rollupOf("gh-pr-view.open.json"));
    expect(open.map((check) => check.bucket)).toEqual(["pass", "pass", "skipped", "skipped"]);
  });

  it("buckets commit statuses, pending before passing, with no workflow or job", () => {
    const checks = decodeChecks(rollupOf("gh-pr-view.status-context.json"));
    expect(checks.map((check) => [check.name, check.bucket])).toEqual([
      ["tide", "pending"],
      ["EasyCLA", "pass"],
      ["pull-kubernetes-cmd", "pass"],
    ]);
    expect(checks[0]).toMatchObject({ workflow: null, jobId: null, completedAt: null });
    expect(checks[0]!.url).toContain("prow.k8s.io");
  });

  it("maps every conclusion and state to its bucket", () => {
    const [run] = rollupOf("gh-pr-view.failing.json");
    const [status] = rollupOf("gh-pr-view.status-context.json");
    const bucketOf = (entry: Record<string, unknown>) => decodeChecks([entry])[0]!.bucket;
    for (const conclusion of [
      "FAILURE",
      "TIMED_OUT",
      "CANCELLED",
      "ACTION_REQUIRED",
      "STARTUP_FAILURE",
    ]) {
      expect(bucketOf({ ...run, conclusion })).toBe("fail");
    }
    expect(bucketOf({ ...run, conclusion: "SKIPPED" })).toBe("skipped");
    expect(bucketOf({ ...run, conclusion: "NEUTRAL" })).toBe("skipped");
    expect(bucketOf({ ...run, conclusion: "SUCCESS" })).toBe("pass");
    expect(bucketOf({ ...run, status: "IN_PROGRESS", conclusion: "" })).toBe("pending");
    expect(bucketOf({ ...run, status: "QUEUED", conclusion: "" })).toBe("pending");
    expect(bucketOf({ ...status, state: "FAILURE" })).toBe("fail");
    expect(bucketOf({ ...status, state: "ERROR" })).toBe("fail");
    expect(bucketOf({ ...status, state: "EXPECTED" })).toBe("pending");
    expect(bucketOf({ ...status, state: "SUCCESS" })).toBe("pass");
  });

  it("keeps only the newest run of a re-run check", () => {
    const failed = rollupOf("gh-pr-view.failing.json").find(
      (entry) => entry.name === "govulncheck",
    )!;
    const rerun = {
      ...failed,
      conclusion: "SUCCESS",
      startedAt: "2026-09-11T06:00:00Z",
      completedAt: "2026-09-11T06:01:00Z",
      detailsUrl: "https://github.com/cli/cli/actions/runs/34558150659/job/103156999999",
    };
    // Newer first or last, the rerun wins.
    for (const rollup of [
      [failed, rerun],
      [rerun, failed],
    ]) {
      const checks = decodeChecks(rollup);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ bucket: "pass", jobId: "103156999999" });
    }
  });

  it("reads a check that has not started yet as having no start", () => {
    const [run] = rollupOf("gh-pr-view.failing.json");
    const queued = { ...run, status: "QUEUED", startedAt: "0001-01-01T00:00:00Z" };
    expect(decodeChecks([queued])[0]!.startedAt).toBeNull();
  });
});

describe("decodeReviewData", () => {
  it("reads review threads, carrying an outdated thread's original line", () => {
    const data = decodeReviewData(fixture("gh-api-graphql.review-threads.json"));
    expect(data.mergeMethods).toEqual({ merge: true, squash: true, rebase: true });
    expect(
      data.reviewThreads.map((thread) => [
        thread.path,
        thread.line,
        thread.isResolved,
        thread.isOutdated,
      ]),
    ).toEqual([
      ["pkg/cmd/search/issues/issues.go", 38, false, false],
      ["pkg/cmd/search/issues/issues.go", 39, false, true],
      ["pkg/cmd/search/issues/issues.go", 40, true, true],
    ]);
    expect(data.reviewThreads[0]!.comments[0]).toMatchObject({
      author: "user-2",
      createdAt: "2026-09-25T19:20:59Z",
      url: "https://github.com/cli/cli/pull/14519#discussion_r4107885267",
    });
  });

  it("reads a repository that disallows merge methods, and a missing answer as all allowed", () => {
    const json = fixture("gh-api-graphql.review-threads.json") as {
      data: { repository: Record<string, unknown> };
    };
    json.data.repository.mergeCommitAllowed = false;
    json.data.repository.rebaseMergeAllowed = false;
    expect(decodeReviewData(json).mergeMethods).toEqual({
      merge: false,
      squash: true,
      rebase: false,
    });
    expect(decodeReviewData(null)).toEqual({
      reviewThreads: [],
      mergeMethods: { merge: true, squash: true, rebase: true },
    });
  });
});

describe("decodePullRequestList", () => {
  it("reads each row's state, draft and failing checks", () => {
    const rows = decodePullRequestList(fixture("gh-pr-list.json"));
    expect(rows.map((row) => [row.number, row.state, row.isDraft, row.failing])).toEqual([
      [14536, "closed", false, false],
      [14519, "open", false, false],
      [14517, "merged", false, false],
      [14485, "open", false, false],
      [14423, "closed", false, true],
      [14355, "open", true, false],
    ]);
  });

  it("picks a branch's open pull request over a newer closed one, then the newest", () => {
    const rows = decodePullRequestList(fixture("gh-pr-list.json"));
    const open = rows.find((row) => row.number === 14519)!;
    const closedNewer = { ...open, number: 1, state: "closed" as const, updatedAt: "2026-12-01" };
    expect(pullRequestForBranch([closedNewer, open], open.headRefName)).toBe(open);
    const closedOlder = { ...closedNewer, number: 2, updatedAt: "2026-01-01" };
    expect(pullRequestForBranch([closedOlder, closedNewer], open.headRefName)).toBe(closedNewer);
    expect(pullRequestForBranch(rows, "no-such-branch")).toBeNull();
  });
});

describe("urls", () => {
  it("reads a pull request's repository and a check's job", () => {
    expect(repositoryOf("https://github.com/cli/cli/pull/14519")).toEqual({
      host: "github.com",
      owner: "cli",
      name: "cli",
    });
    expect(repositoryOf("https://ghe.example.com/acme/app/pull/3")).toMatchObject({
      host: "ghe.example.com",
    });
    expect(repositoryOf("https://github.com/cli/cli")).toBeNull();
    expect(jobIdOf("https://github.com/cli/cli/actions/runs/1/job/22")).toBe("22");
    expect(jobIdOf("https://prow.k8s.io/pr?query=x")).toBeNull();
    expect(jobIdOf(null)).toBeNull();
  });
});
