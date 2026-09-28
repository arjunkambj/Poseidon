/**
 * Reading pull requests through the GitHub CLI: the one the pull request pane
 * shows for a workspace's branch, and the marks the sidebar tints thread rows
 * with.
 *
 * Both ask `pullRequestBlocker` first, so a missing or signed-out gh is an
 * answer — `unavailable` with gh's fix for the view, no marks at all for the
 * sidebar — never an error. Every call is argv form, and the only values in
 * one that are not ours are a pull request's number and a branch's name,
 * passed as `--head=<name>` so it never reads as a flag of its own.
 */
import type { ThreadId } from "@poseidon/contracts/ids";
import type {
  PullRequestMark,
  PullRequestMarks,
  PullRequestView,
} from "@poseidon/contracts/pullRequest";
import * as Effect from "effect/Effect";

import { PoseidonRpcError } from "@poseidon/contracts/rpc";

import { currentBranch, listBranches } from "./Branches";
import { GhRunner, NOT_AVAILABLE, pullRequestBlocker } from "./GitHubCli";
import { isRepository } from "./process";
import {
  ALL_MERGE_METHODS,
  decodePullRequestList,
  decodePullRequestView,
  decodeReviewData,
  pullRequestForBranch,
  repositoryOf,
} from "./pullRequestJson";

const VIEW_FIELDS = [
  "number",
  "title",
  "url",
  "state",
  "isDraft",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "author",
  "updatedAt",
  "mergeable",
  "reviewDecision",
  "statusCheckRollup",
  "reviews",
  "comments",
].join(",");

const LIST_FIELDS = [
  "number",
  "url",
  "state",
  "isDraft",
  "headRefName",
  "updatedAt",
  "statusCheckRollup",
].join(",");

/** How many of one head branch's pull requests, newest first, the marks look through. */
const MARKS_LIST_LIMIT = 20;

/** How many branches' listings run at once. */
const MARKS_CONCURRENCY = 4;

/** gh's answer when the branch has no pull request: `no pull requests found for branch "x"`. */
const NO_PULL_REQUEST = /no pull requests found/i;

/** The review threads and merge settings `gh pr view` has no field for. */
export const REVIEW_THREADS_QUERY = [
  "query($owner: String!, $name: String!, $number: Int!) {",
  "  repository(owner: $owner, name: $name) {",
  "    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed",
  "    pullRequest(number: $number) {",
  "      reviewThreads(first: 100) {",
  "        nodes {",
  "          id isResolved isOutdated path line originalLine",
  "          comments(first: 50) { nodes { author { login } body createdAt url } }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

const parseJson = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};

/**
 * The review threads and merge methods of pull request `number` at `url`.
 * A read that fails for any reason degrades to no threads and every method,
 * rather than failing a view that already has everything else.
 */
const reviewData = (gh: GhRunner["Service"], cwd: string, url: string, number: number) =>
  Effect.gen(function* () {
    const repository = repositoryOf(url);
    if (repository === null) return { reviewThreads: [], mergeMethods: ALL_MERGE_METHODS };
    const answer = yield* gh.run(
      [
        "api",
        "graphql",
        ...(repository.host === "github.com" ? [] : ["--hostname", repository.host]),
        "-f",
        `query=${REVIEW_THREADS_QUERY}`,
        // `-f` keeps an owner or name like `2048` a string; `-F` makes the number an Int.
        "-f",
        `owner=${repository.owner}`,
        "-f",
        `name=${repository.name}`,
        "-F",
        `number=${number}`,
      ],
      cwd,
    );
    if (answer.exitCode !== 0) return { reviewThreads: [], mergeMethods: ALL_MERGE_METHODS };
    return decodeReviewData(parseJson(answer.stdout));
  });

/**
 * The pull request of the branch checked out in `cwd`, `branch`. gh is asked
 * for the current branch's rather than handed the name: that way it follows
 * the branch's upstream to a fork (`owner:branch`), which a bare name never
 * matches, and it still finds merged and closed ones. `none` for a detached
 * HEAD (`branch` null) or a branch without one; `conflict` with gh's own
 * words for any other refusal.
 */
const viewPullRequest = (
  gh: GhRunner["Service"],
  cwd: string,
  branch: string | null,
): Effect.Effect<PullRequestView, PoseidonRpcError> =>
  Effect.gen(function* () {
    if (branch === null) return { state: "none" as const, branch: null };
    const blocker = yield* pullRequestBlocker(gh, cwd);
    if (blocker !== null) return { state: "unavailable" as const, reason: blocker };
    const viewed = yield* gh.run(["pr", "view", "--json", VIEW_FIELDS], cwd);
    if (viewed.exitCode !== 0) {
      if (NO_PULL_REQUEST.test(viewed.stderr)) return { state: "none" as const, branch };
      return yield* Effect.fail(
        new PoseidonRpcError({
          code: "conflict",
          message: viewed.stderr.trim() || `gh pr view exited ${viewed.exitCode}`,
        }),
      );
    }
    const pullRequest = decodePullRequestView(parseJson(viewed.stdout));
    if (pullRequest === null) {
      return yield* Effect.fail(
        new PoseidonRpcError({ code: "internal", message: "gh pr view answered no pull request" }),
      );
    }
    const extra = yield* reviewData(gh, cwd, pullRequest.url, pullRequest.number);
    return { state: "found" as const, pullRequest: { ...pullRequest, ...extra } };
  }).pipe(
    // gh vanished between the readiness check and the read.
    Effect.catchTag("GhMissing", () =>
      Effect.succeed({ state: "unavailable" as const, reason: NOT_AVAILABLE }),
    ),
  );

/** The pull request of the workspace at `root`: its current branch's, when it is a repository. */
export const viewWorkspacePullRequest = (
  gh: GhRunner["Service"],
  root: string,
): Effect.Effect<PullRequestView, PoseidonRpcError> =>
  Effect.gen(function* () {
    if (!(yield* isRepository(root))) return { state: "none" as const, branch: null };
    return yield* viewPullRequest(gh, root, yield* currentBranch(root));
  }).pipe(
    Effect.catchTag("GitError", (error) =>
      Effect.fail(new PoseidonRpcError({ code: "internal", message: error.message })),
    ),
  );

/** A live thread and the directory it works in. */
export interface ThreadRoot {
  readonly threadId: ThreadId;
  readonly root: string;
}

/**
 * A mark for each thread whose branch has a pull request. Each distinct
 * root's branch is read once; the default branch and a detached HEAD are
 * never matched, and when no thread is left on a branch of its own gh is not
 * asked at all. Otherwise gh lists each distinct branch's own pull requests
 * (`gh pr list --head`), so a long-running one is found however many newer
 * ones the repository has. Anything that goes wrong — gh missing or
 * signed out, a git read that fails — is no marks rather than an error, and
 * a failed listing leaves just that branch's threads unmarked.
 */
export const pullRequestMarks = (
  gh: GhRunner["Service"],
  projectRoot: string,
  threads: ReadonlyArray<ThreadRoot>,
): Effect.Effect<PullRequestMarks> =>
  Effect.gen(function* () {
    if (threads.length === 0 || !(yield* isRepository(projectRoot))) return { marks: [] };
    const { defaultBranch, remotes } = yield* listBranches(projectRoot);
    const remote = remotes.find((name) => defaultBranch?.startsWith(`${name}/`) === true);
    const defaultName =
      remote === undefined ? defaultBranch : defaultBranch!.slice(remote.length + 1);
    const branchOfRoot = new Map<string, string | null>();
    for (const { root } of threads) {
      if (branchOfRoot.has(root)) continue;
      const branch = yield* currentBranch(root).pipe(
        Effect.catchTag("GitError", () => Effect.succeed(null)),
      );
      branchOfRoot.set(root, branch === defaultName ? null : branch);
    }
    const onBranches = threads.flatMap(({ threadId, root }) => {
      const branch = branchOfRoot.get(root) ?? null;
      return branch === null ? [] : [{ threadId, branch }];
    });
    if (onBranches.length === 0) return { marks: [] };
    if ((yield* pullRequestBlocker(gh, projectRoot)) !== null) return { marks: [] };
    const branches = [...new Set(onBranches.map(({ branch }) => branch))];
    const listings = yield* Effect.forEach(
      branches,
      (branch) =>
        gh
          .run(
            [
              "pr",
              "list",
              "--state",
              "all",
              `--head=${branch}`,
              "--limit",
              String(MARKS_LIST_LIMIT),
              "--json",
              LIST_FIELDS,
            ],
            projectRoot,
          )
          .pipe(
            Effect.map(
              (listed) =>
                [
                  branch,
                  listed.exitCode === 0 ? decodePullRequestList(parseJson(listed.stdout)) : [],
                ] as const,
            ),
          ),
      { concurrency: MARKS_CONCURRENCY },
    );
    const rowsOf = new Map(listings);
    const marks: Array<PullRequestMark> = [];
    for (const { threadId, branch } of onBranches) {
      const row = pullRequestForBranch(rowsOf.get(branch) ?? [], branch);
      if (row === null) continue;
      marks.push({
        threadId,
        number: row.number,
        url: row.url,
        state: row.state,
        isDraft: row.isDraft,
        failing: row.failing,
      });
    }
    return { marks };
  }).pipe(
    Effect.catchTags({
      GhMissing: () => Effect.succeed({ marks: [] }),
      GitError: () => Effect.succeed({ marks: [] }),
    }),
  );
