/**
 * `git.pullRequest.view` and `git.pullRequest.marks` through the real git
 * layer: real repositories and worktrees in tmp directories, and a fake
 * `GhRunner` answering with gh 2.92's own wording and the JSON captured from
 * it under `fixtures/`. Nothing here writes to a pull request.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fakeGh, GH_AUTHENTICATED, GH_NOT_AUTHENTICATED, GH_VERSION } from "./fakeGh";
import { NOT_AUTHENTICATED, NOT_AVAILABLE, type GhOutput } from "./GitHubCli";
import { addWorktree, fixture, git, makeRepo, ok, stack, tempDir } from "./pullRequestTestKit";
import { REVIEW_THREADS_QUERY } from "./PullRequests";

// ── gh's answers ───────────────────────────────────────────────

/** gh 2.92's refusal for a branch without a pull request (exit 1). */
const noPullRequest = (branch: string): GhOutput => ({
  stdout: "",
  stderr: `no pull requests found for branch "${branch}"\n`,
  exitCode: 1,
});

/** gh 2.92's answer to a GraphQL read of a pull request that is not there. */
const GRAPHQL_NOT_FOUND: GhOutput = {
  stdout:
    '{"data":{"repository":{"mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":true,"pullRequest":null}},"errors":[{"type":"NOT_FOUND","path":["repository","pullRequest"],"message":"Could not resolve to a PullRequest with the number of 14519."}]}',
  stderr: "gh: Could not resolve to a PullRequest with the number of 14519.\n",
  exitCode: 1,
};

/** gh signed in, answering `pr view` (in `cwd`), `api graphql` and `pr list` from the script. */
const signedIn = (answers: {
  view?: (cwd: string) => GhOutput;
  graphql?: GhOutput;
  list?: (args: ReadonlyArray<string>) => GhOutput;
}) =>
  fakeGh((args, cwd) => {
    if (args[0] === "--version") return GH_VERSION;
    if (args[0] === "auth") return GH_AUTHENTICATED;
    if (args[0] === "pr" && args[1] === "view" && answers.view !== undefined) {
      return answers.view(cwd);
    }
    if (args[0] === "api" && answers.graphql !== undefined) return answers.graphql;
    if (args[0] === "pr" && args[1] === "list" && answers.list !== undefined) {
      return answers.list(args);
    }
    return { stdout: "", stderr: `unexpected gh ${args.join(" ")}`, exitCode: 1 };
  });

/** gh 2.92's `gh pr list --head=<branch>` answer per branch, captured from cli/cli. */
const listByHead = (args: ReadonlyArray<string>): GhOutput => {
  const head = args.find((arg) => arg.startsWith("--head="))?.slice("--head=".length);
  const rows = (JSON.parse(fixture("gh-pr-list.by-head.json")) as Record<string, unknown>)[
    head ?? ""
  ];
  return ok(JSON.stringify(rows ?? []));
};

const LIST_JSON = "number,url,state,isDraft,headRefName,updatedAt,statusCheckRollup";

const listCall = (branch: string) => [
  "pr",
  "list",
  "--state",
  "all",
  `--head=${branch}`,
  "--limit",
  "20",
  "--json",
  LIST_JSON,
];

const VIEW_JSON =
  "number,title,url,state,isDraft,baseRefName,headRefName,headRefOid,author,updatedAt,mergeable,reviewDecision,statusCheckRollup,reviews,comments";

// ── The view ───────────────────────────────────────────────────

describe("git.pullRequest.view", () => {
  it.live("reads the branch's pull request with its review threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo("document-search-operator-support");
        const gh = signedIn({
          view: () => ok(fixture("gh-pr-view.open.json")),
          graphql: ok(fixture("gh-api-graphql.review-threads.json")),
        });
        const { projectId, git: service } = yield* stack(root, gh.runner);

        const view = yield* service.viewPullRequest({ projectId });
        expect(view.state).toBe("found");
        if (view.state !== "found") return;
        expect(view.pullRequest).toMatchObject({
          number: 14519,
          state: "open",
          headRefName: "document-search-operator-support",
          reviewDecision: "changes-requested",
          mergeMethods: { merge: true, squash: true, rebase: true },
        });
        expect(view.pullRequest.checks).toHaveLength(4);
        expect(view.pullRequest.reviewThreads.map((thread) => thread.line)).toEqual([38, 39, 40]);

        // No shell, and nothing but the number that is not ours: gh reads the
        // branch (and its upstream) from the workspace it runs in.
        expect(gh.calls).toEqual([
          ["--version"],
          ["auth", "status"],
          ["pr", "view", "--json", VIEW_JSON],
          [
            "api",
            "graphql",
            "-f",
            `query=${REVIEW_THREADS_QUERY}`,
            "-f",
            "owner=cli",
            "-f",
            "name=cli",
            "-F",
            "number=14519",
          ],
        ]);
      }),
    ),
  );

  it.live("reads a worktree thread's branch, not the project's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const worktree = addWorktree(root, "bump-go-1.27.1");
        const gh = signedIn({
          view: (cwd) =>
            cwd === worktree.path
              ? ok(fixture("gh-pr-view.failing.json"))
              : noPullRequest(git(cwd, "branch", "--show-current").trim()),
          graphql: ok(fixture("gh-api-graphql.review-threads.json")),
        });
        const { projectId, addThread, git: service } = yield* stack(root, gh.runner);
        const threadId = yield* addThread({ worktree });

        const view = yield* service.viewPullRequest({ projectId, threadId });
        expect(view.state === "found" && view.pullRequest.state).toBe("closed");
        expect(yield* service.viewPullRequest({ projectId })).toEqual({
          state: "none",
          branch: "main",
        });
      }),
    ),
  );

  it.live("answers none for a branch without one, a detached HEAD, or no repository", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo("feature/login");
        const gh = signedIn({ view: () => noPullRequest("feature/login") });
        const { projectId, git: service } = yield* stack(root, gh.runner);
        expect(yield* service.viewPullRequest({ projectId })).toEqual({
          state: "none",
          branch: "feature/login",
        });

        git(root, "switch", "-q", "--detach");
        const before = gh.calls.length;
        expect(yield* service.viewPullRequest({ projectId })).toEqual({
          state: "none",
          branch: null,
        });
        expect(gh.calls.length).toBe(before);

        const plain = tempDir("poseidon-pr-plain-");
        const other = yield* stack(plain, gh.runner);
        expect(yield* other.git.viewPullRequest({ projectId: other.projectId })).toEqual({
          state: "none",
          branch: null,
        });
      }),
    ),
  );

  it.live("answers unavailable with gh's fix when gh is missing or signed out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo("feature");
        const missing = fakeGh(() => "missing");
        const first = yield* stack(root, missing.runner);
        expect(yield* first.git.viewPullRequest({ projectId: first.projectId })).toEqual({
          state: "unavailable",
          reason: NOT_AVAILABLE,
        });

        const signedOut = fakeGh((args) =>
          args[0] === "--version" ? GH_VERSION : GH_NOT_AUTHENTICATED,
        );
        const second = yield* stack(root, signedOut.runner);
        expect(yield* second.git.viewPullRequest({ projectId: second.projectId })).toEqual({
          state: "unavailable",
          reason: NOT_AUTHENTICATED,
        });
        // Never got as far as asking for the pull request.
        expect(signedOut.calls.some((args) => args[0] === "pr")).toBe(false);
      }),
    ),
  );

  it.live("keeps the view when the review-thread read fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo("document-search-operator-support");
        const gh = signedIn({
          view: () => ok(fixture("gh-pr-view.open.json")),
          graphql: GRAPHQL_NOT_FOUND,
        });
        const { projectId, git: service } = yield* stack(root, gh.runner);
        const view = yield* service.viewPullRequest({ projectId });
        expect(view.state === "found" && view.pullRequest.reviewThreads).toEqual([]);
        expect(view.state === "found" && view.pullRequest.mergeMethods).toEqual({
          merge: true,
          squash: true,
          rebase: true,
        });
        expect(view.state === "found" && view.pullRequest.number).toBe(14519);
      }),
    ),
  );

  it.live("reports any other refusal as a conflict in gh's own words", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo("feature");
        const refusal =
          "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`\n";
        const gh = signedIn({ view: () => ({ stdout: "", stderr: refusal, exitCode: 1 }) });
        const { projectId, git: service } = yield* stack(root, gh.runner);
        const error = yield* service.viewPullRequest({ projectId }).pipe(Effect.flip);
        expect(error.code).toBe("conflict");
        expect(error.message).toBe(refusal.trim());
      }),
    ),
  );
});

// ── The marks ──────────────────────────────────────────────────

describe("git.pullRequest.marks", () => {
  it.live("marks each thread by its own branch's pull request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The project's folder is on the open pull request's branch; one worktree is on a branch with a merged and
        // a closed, failing pull request, another on the draft's, a third on
        // the default branch and a fourth on a branch with none.
        const root = makeRepo("document-search-operator-support");
        const merged = addWorktree(root, "bump-go-1.27.1");
        const draft = addWorktree(root, "williammartin-clean-git-test-seams");
        const onDefault = addWorktree(root, "main", false);
        const without = addWorktree(root, "no-pull-request-yet");
        const gh = signedIn({ list: listByHead });
        const { projectId, addThread, git: service } = yield* stack(root, gh.runner);
        const local = yield* addThread();
        const secondLocal = yield* addThread();
        const mergedThread = yield* addThread({ worktree: merged });
        const draftThread = yield* addThread({ worktree: draft });
        yield* addThread({ worktree: onDefault });
        yield* addThread({ worktree: without });
        yield* addThread({ worktree: merged, deleted: true });

        const { marks } = yield* service.pullRequestMarks(projectId);
        const byThread = new Map(marks.map((mark) => [mark.threadId, mark]));
        expect(marks).toHaveLength(4);
        expect(byThread.get(local)).toEqual({
          threadId: local,
          number: 14519,
          url: "https://github.com/cli/cli/pull/14519",
          state: "open",
          isDraft: false,
          failing: false,
        });
        expect(byThread.get(secondLocal)?.number).toBe(14519);
        // The newest of two closed ones: the merged one, not the older failing one.
        expect(byThread.get(mergedThread)).toMatchObject({
          number: 14442,
          state: "merged",
          failing: false,
        });
        expect(byThread.get(draftThread)).toMatchObject({ number: 14355, isDraft: true });

        // One listing per distinct branch, each of that branch's own pull requests.
        expect(gh.calls.slice(0, 2)).toEqual([["--version"], ["auth", "status"]]);
        expect(gh.calls.slice(2)).toHaveLength(4);
        expect(gh.calls.slice(2)).toEqual(
          expect.arrayContaining([
            listCall("document-search-operator-support"),
            listCall("bump-go-1.27.1"),
            listCall("williammartin-clean-git-test-seams"),
            listCall("no-pull-request-yet"),
          ]),
        );
      }),
    ),
  );

  it.live("finds a branch's pull request however many newer ones the repository has", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The draft is older than any repository-wide listing would reach:
        // the branch's own listing still has it.
        const root = makeRepo("williammartin-clean-git-test-seams");
        const gh = signedIn({ list: listByHead });
        const { projectId, addThread, git: service } = yield* stack(root, gh.runner);
        const thread = yield* addThread();
        const { marks } = yield* service.pullRequestMarks(projectId);
        expect(marks).toEqual([expect.objectContaining({ threadId: thread, number: 14355 })]);
        expect(gh.calls.at(-1)).toEqual(listCall("williammartin-clean-git-test-seams"));
      }),
    ),
  );

  it.live("asks gh nothing when every thread is on the default branch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const gh = signedIn({ list: listByHead });
        const { projectId, addThread, git: service } = yield* stack(root, gh.runner);
        yield* addThread();
        expect(yield* service.pullRequestMarks(projectId)).toEqual({ marks: [] });
        expect(gh.calls).toEqual([]);
      }),
    ),
  );

  it.live("answers no marks, not an error, when gh is missing, signed out or refuses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo("document-search-operator-support");
        const scripts = [
          fakeGh(() => "missing"),
          fakeGh((args) => (args[0] === "--version" ? GH_VERSION : GH_NOT_AUTHENTICATED)),
          signedIn({
            list: () => ({ stdout: "", stderr: "HTTP 502: Bad Gateway\n", exitCode: 1 }),
          }),
        ];
        for (const gh of scripts) {
          const { projectId, addThread, git: service } = yield* stack(root, gh.runner);
          yield* addThread();
          expect(yield* service.pullRequestMarks(projectId)).toEqual({ marks: [] });
        }
      }),
    ),
  );
});
