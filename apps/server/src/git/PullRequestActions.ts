/**
 * Writing to a pull request through the GitHub CLI, and reading what a thread
 * that fixes one starts from.
 *
 * Each write is one gh command on the pull request's number — `gh pr ready`,
 * `gh pr ready --undo`, `gh pr merge`, `gh pr close`, `gh pr reopen` — after
 * `pullRequestBlocker` says gh is there and signed in, and answers the view as
 * it is afterwards. A merge never deletes a branch (under a worktree gh would
 * switch and delete local ones), never queues itself (`--auto`) and never
 * overrides the base branch's rules (`--admin`); given the head the pane
 * showed, it pins that commit so it cannot land a newer one.
 *
 * The fix context reads the failing checks' failed-log tails and the files a
 * merge of the base would conflict in. Nothing is fetched: the conflicts are
 * as of the last fetch, and a log that cannot be read is `null`, not an error.
 */
import type {
  PullRequestAction,
  PullRequestDetail,
  PullRequestFixContext,
  PullRequestView,
} from "@poseidon/contracts/pullRequest";
import * as Effect from "effect/Effect";

import { PoseidonRpcError } from "@poseidon/contracts/rpc";

import { currentBranch } from "./Branches";
import { remoteFor } from "./Commits";
import { GhRunner, NOT_AVAILABLE, pullRequestBlocker } from "./GitHubCli";
import { run } from "./process";
import { repositoryOf } from "./pullRequestJson";
import { viewWorkspacePullRequest } from "./PullRequests";

const unavailable = (message: string) => new PoseidonRpcError({ code: "unavailable", message });

/** A commit id as a merge may pin it; anything else never reaches gh's argv. */
const COMMIT_OID = /^[0-9a-f]{7,64}$/i;

/** gh's arguments for `action` on pull request `number`, after the `gh`. */
export const actionArgs = (
  number: number,
  action: PullRequestAction,
  headRefOid: string | undefined,
): ReadonlyArray<string> => {
  const target = String(number);
  switch (action.kind) {
    case "ready":
      return ["pr", "ready", target];
    case "draft":
      return ["pr", "ready", target, "--undo"];
    case "merge":
      return [
        "pr",
        "merge",
        target,
        `--${action.method}`,
        ...(headRefOid === undefined ? [] : ["--match-head-commit", headRefOid]),
      ];
    case "close":
      return ["pr", "close", target];
    case "reopen":
      return ["pr", "reopen", target];
  }
};

/**
 * Runs `action` on pull request `number` from `root` and answers the view
 * read afterwards. `unavailable` when gh is missing or signed out; `conflict`
 * with gh's own words when it refuses (not mergeable, already merged, a head
 * that moved since `headRefOid`).
 */
export const runPullRequestAction = (
  gh: GhRunner["Service"],
  root: string,
  request: {
    readonly number: number;
    readonly headRefOid?: string | undefined;
    readonly action: PullRequestAction;
  },
): Effect.Effect<PullRequestView, PoseidonRpcError> =>
  Effect.gen(function* () {
    if (!Number.isInteger(request.number) || request.number <= 0) {
      return yield* Effect.fail(
        new PoseidonRpcError({ code: "invalid", message: "Not a pull request number." }),
      );
    }
    if (request.headRefOid !== undefined && !COMMIT_OID.test(request.headRefOid)) {
      return yield* Effect.fail(
        new PoseidonRpcError({ code: "invalid", message: "Not a commit id to merge." }),
      );
    }
    const blocker = yield* pullRequestBlocker(gh, root);
    if (blocker !== null) return yield* Effect.fail(unavailable(blocker));
    const args = actionArgs(request.number, request.action, request.headRefOid);
    const answer = yield* gh.run(args, root);
    if (answer.exitCode !== 0) {
      return yield* Effect.fail(
        new PoseidonRpcError({
          code: "conflict",
          message: answer.stderr.trim() || `gh pr ${args[1]} exited ${answer.exitCode}`,
        }),
      );
    }
    return yield* viewWorkspacePullRequest(gh, root);
  }).pipe(Effect.catchTag("GhMissing", () => Effect.fail(unavailable(NOT_AVAILABLE))));

// ── Fix context ────────────────────────────────────────────────

/** How many failing checks get their log read, and how much of each is kept. */
const LOG_JOBS = 3;
const LOG_LINES = 60;
const LOG_BYTES = 4 * 1024;

/** The timestamp Actions puts before every log line (after a BOM on the first). */
const LOG_TIMESTAMP = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

/**
 * The end of a `gh run view --log-failed` answer, as the agent should read it.
 * gh prints each line as `<job>\t<step>\t<timestamp> <text>`; only the text is
 * kept. What follows the last `##[error]` line is the runner's post-job
 * cleanup, so the tail ends there. At most `LOG_LINES` lines and `LOG_BYTES`
 * bytes (whole lines), `null` when nothing is left.
 */
export const failedLogTail = (stdout: string): string | null => {
  const lines = stdout.split(/\r?\n/).map((line) => {
    const fields = line.split("\t");
    const text = fields.length >= 3 ? fields.slice(2).join("\t") : line;
    return text.replace(LOG_TIMESTAMP, "");
  });
  let end = lines.length;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]!.startsWith("##[error]")) {
      end = index + 1;
      break;
    }
  }
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  const kept = lines.slice(Math.max(0, end - LOG_LINES), end);
  while (kept.length > 1 && Buffer.byteLength(kept.join("\n"), "utf8") > LOG_BYTES) kept.shift();
  let tail = kept.join("\n");
  // One line longer than the cap on its own: keep its end.
  if (Buffer.byteLength(tail, "utf8") > LOG_BYTES) {
    tail = Buffer.from(tail, "utf8").subarray(-LOG_BYTES).toString("utf8").replace(/^�+/, "");
  }
  return tail.trim() === "" ? null : tail;
};

/** `--repo` for gh as the pull request's URL names it: `owner/name`, or `host/owner/name`. */
const repoFlag = (url: string): ReadonlyArray<string> => {
  const repository = repositoryOf(url);
  if (repository === null) return [];
  const spec = `${repository.owner}/${repository.name}`;
  return ["--repo", repository.host === "github.com" ? spec : `${repository.host}/${spec}`];
};

/** The failing checks, the first `LOG_JOBS` Actions jobs among them with their log tails. */
const failingChecks = (gh: GhRunner["Service"], root: string, pullRequest: PullRequestDetail) =>
  Effect.gen(function* () {
    const failing = pullRequest.checks.filter((check) => check.bucket === "fail");
    const withLogs = new Set(
      failing
        .filter((check) => check.jobId !== null)
        .slice(0, LOG_JOBS)
        .map((check) => check.jobId),
    );
    const checks: Array<PullRequestFixContext["checks"][number]> = [];
    for (const check of failing) {
      let logTail: string | null = null;
      if (check.jobId !== null && withLogs.has(check.jobId)) {
        const answer = yield* gh
          .run(
            ["run", "view", "--job", check.jobId, "--log-failed", ...repoFlag(pullRequest.url)],
            root,
          )
          .pipe(Effect.catchTag("GhMissing", () => Effect.succeed(null)));
        logTail = answer !== null && answer.exitCode === 0 ? failedLogTail(answer.stdout) : null;
      }
      checks.push({ name: check.name, url: check.url, logTail });
    }
    return checks;
  });

/**
 * The files a merge of `<remote>/<base>` into HEAD would conflict in, from
 * `git merge-tree --write-tree` (git 2.38+), which touches neither the index
 * nor the working tree. The remote is the one the branch pushes to. Exit 1
 * means conflicts, their names after the tree id on the first line; a clean
 * merge, an unknown ref or an older git is no files.
 */
const conflictFiles = (root: string, baseRefName: string) =>
  Effect.gen(function* () {
    const branch = yield* currentBranch(root);
    const remote = yield* remoteFor(root, branch ?? "HEAD").pipe(
      Effect.catchTag("PoseidonRpcError", () => Effect.succeed(null)),
    );
    if (remote === null || baseRefName.startsWith("-")) {
      return { base: baseRefName, files: [] as Array<string> };
    }
    const base = `${remote}/${baseRefName}`;
    const merged = yield* run(
      root,
      ["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", base],
      { allowNonZeroExit: true },
    );
    if (merged.exitCode !== 1) return { base, files: [] as Array<string> };
    const names = merged.stdout
      .split("\n")
      .slice(1)
      .filter((line) => line.length > 0);
    return { base, files: [...new Set(names)] };
  });

/**
 * What a thread fixing pull request `number` starts from. The pull request is
 * read again first, so the context is the branch's current one; a branch
 * whose pull request is no longer `number` is a `conflict` (the pane is out
 * of date), and gh missing or signed out is `unavailable`.
 */
export const pullRequestFixContext = (
  gh: GhRunner["Service"],
  root: string,
  request: { readonly number: number; readonly kind: "checks" | "conflicts" },
): Effect.Effect<PullRequestFixContext, PoseidonRpcError> =>
  Effect.gen(function* () {
    const view = yield* viewWorkspacePullRequest(gh, root);
    if (view.state === "unavailable") return yield* Effect.fail(unavailable(view.reason));
    if (view.state === "none" || view.pullRequest.number !== request.number) {
      return yield* Effect.fail(
        new PoseidonRpcError({
          code: "conflict",
          message: `This branch's pull request is no longer #${request.number}; refresh and try again.`,
        }),
      );
    }
    const pullRequest = view.pullRequest;
    if (request.kind === "checks") {
      return {
        checks: yield* failingChecks(gh, root, pullRequest),
        conflictFiles: [],
        base: pullRequest.baseRefName,
      };
    }
    const { base, files } = yield* conflictFiles(root, pullRequest.baseRefName);
    return { checks: [], conflictFiles: files, base };
  }).pipe(
    Effect.catchTag("GitError", (error) =>
      Effect.fail(new PoseidonRpcError({ code: "internal", message: error.message })),
    ),
  );
