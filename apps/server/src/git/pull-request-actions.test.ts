/**
 * `git.pullRequest.action` and `git.pullRequest.fixContext` through the real
 * git layer, with a fake `GhRunner`: the writes are never run against GitHub,
 * so each one is proven by the argv it hands gh and by gh's own wording for
 * its refusals (taken from gh's source). The failed-log tail replays a real
 * `gh run view --log-failed` capture; the conflicting files come from real
 * repositories with a bare repository as the remote.
 */
import { describe, expect, it } from "@effect/vitest";
import { writeFileSync } from "node:fs";
import * as nodePath from "node:path";
import type { PullRequestAction } from "@poseidon/contracts/pullRequest";
import * as Effect from "effect/Effect";

import { fakeGh, GH_AUTHENTICATED, GH_NOT_AUTHENTICATED, GH_VERSION } from "./fakeGh";
import { NOT_AUTHENTICATED, NOT_AVAILABLE, type GhOutput } from "./GitHubCli";
import { actionArgs, failedLogTail } from "./PullRequestActions";
import { fixture, git, makeRepo, ok, stack, tempDir } from "./pullRequestTestKit";

const HEAD_OID = "97577e407ff3aee505aec675da081da75a24224a";

/**
 * gh signed in: `write` answers the pull request writes, `view` the view
 * (the open pull request #14519 by default), `runView` the log reads by job
 * id. The review-thread read is refused, which the view survives.
 */
const signedIn = (answers: {
  write?: (args: ReadonlyArray<string>) => GhOutput;
  view?: () => GhOutput;
  runView?: (jobId: string) => GhOutput | "missing";
}) =>
  fakeGh((args) => {
    if (args[0] === "--version") return GH_VERSION;
    if (args[0] === "auth") return GH_AUTHENTICATED;
    if (args[0] === "pr" && args[1] === "view") {
      return answers.view?.() ?? ok(fixture("gh-pr-view.open.json"));
    }
    if (args[0] === "pr" && answers.write !== undefined) return answers.write(args);
    if (args[0] === "run" && answers.runView !== undefined) return answers.runView(args[3]!);
    return { stdout: "", stderr: `unexpected gh ${args.join(" ")}`, exitCode: 1 };
  });

const isWrite = (args: ReadonlyArray<string>) =>
  args[0] === "pr" && args[1] !== "view" && args[1] !== "list";

// ── The writes ─────────────────────────────────────────────────

describe("git.pullRequest.action", () => {
  it("hands gh one argv per action, never deleting a branch, queueing or overriding", () => {
    const cases: ReadonlyArray<[PullRequestAction, string | undefined, ReadonlyArray<string>]> = [
      [{ kind: "ready" }, undefined, ["pr", "ready", "12"]],
      [{ kind: "draft" }, undefined, ["pr", "ready", "12", "--undo"]],
      [{ kind: "merge", method: "merge" }, undefined, ["pr", "merge", "12", "--merge"]],
      [
        { kind: "merge", method: "squash" },
        HEAD_OID,
        ["pr", "merge", "12", "--squash", "--match-head-commit", HEAD_OID],
      ],
      [
        { kind: "merge", method: "rebase" },
        HEAD_OID,
        ["pr", "merge", "12", "--rebase", "--match-head-commit", HEAD_OID],
      ],
      [{ kind: "close" }, undefined, ["pr", "close", "12"]],
      [{ kind: "reopen" }, undefined, ["pr", "reopen", "12"]],
    ];
    for (const [action, headRefOid, argv] of cases) {
      const args = actionArgs(12, action, headRefOid);
      expect(args).toEqual(argv);
      expect(args.some((arg) => ["--delete-branch", "--auto", "--admin"].includes(arg))).toBe(
        false,
      );
    }
  });

  it.live("runs the write in the workspace, then answers the view read afterwards", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo("document-search-operator-support");
        const gh = signedIn({ write: () => ok("") });
        const { projectId, git: service } = yield* stack(root, gh.runner);

        const view = yield* service.pullRequestAction(
          { projectId },
          { number: 14519, headRefOid: HEAD_OID, action: { kind: "merge", method: "squash" } },
        );
        expect(view.state === "found" && view.pullRequest.number).toBe(14519);
        const writeAt = gh.calls.findIndex(isWrite);
        expect(gh.calls[writeAt]).toEqual([
          "pr",
          "merge",
          "14519",
          "--squash",
          "--match-head-commit",
          HEAD_OID,
        ]);
        // gh is asked first, and the view is read again after the write.
        expect(gh.calls.slice(0, writeAt)).toEqual([["--version"], ["auth", "status"]]);
        expect(gh.calls.slice(writeAt + 1).some((args) => args[1] === "view")).toBe(true);

        yield* service.pullRequestAction(
          { projectId },
          { number: 14519, action: { kind: "draft" } },
        );
        expect(gh.calls.filter(isWrite).at(-1)).toEqual(["pr", "ready", "14519", "--undo"]);
      }),
    ),
  );

  it.live("answers unavailable with gh's fix when gh is missing or signed out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo("feature");
        const missing = fakeGh(() => "missing");
        const first = yield* stack(root, missing.runner);
        const noGh = yield* first.git
          .pullRequestAction(
            { projectId: first.projectId },
            { number: 1, action: { kind: "close" } },
          )
          .pipe(Effect.flip);
        expect(noGh).toMatchObject({ code: "unavailable", message: NOT_AVAILABLE });

        const signedOut = fakeGh((args) =>
          args[0] === "--version" ? GH_VERSION : GH_NOT_AUTHENTICATED,
        );
        const second = yield* stack(root, signedOut.runner);
        const noAuth = yield* second.git
          .pullRequestAction(
            { projectId: second.projectId },
            { number: 1, action: { kind: "ready" } },
          )
          .pipe(Effect.flip);
        expect(noAuth).toMatchObject({ code: "unavailable", message: NOT_AUTHENTICATED });
        expect(signedOut.calls.some(isWrite)).toBe(false);
      }),
    ),
  );

  it.live("reports gh's refusal as a conflict in its own words, and reads nothing after", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo("feature");
        // gh's merge refusal for a pull request GitHub will not merge as it stands.
        const notMergeable = [
          "X Pull request cli/cli#14519 is not mergeable: the merge commit cannot be cleanly created.",
          "To have the pull request merged after all the requirements have been met, add the `--auto` flag.",
          "To use administrator privileges to immediately merge the pull request, add the `--admin` flag.",
          "",
        ].join("\n");
        const alreadyMerged =
          "X Pull request cli/cli#14507 (Bump the go group) can't be reopened because it was already merged\n";
        const gh = signedIn({
          write: (args) => ({
            stdout: "",
            stderr: args[1] === "merge" ? notMergeable : alreadyMerged,
            exitCode: 1,
          }),
        });
        const { projectId, git: service } = yield* stack(root, gh.runner);

        const merge = yield* service
          .pullRequestAction(
            { projectId },
            { number: 14519, action: { kind: "merge", method: "merge" } },
          )
          .pipe(Effect.flip);
        expect(merge).toMatchObject({ code: "conflict", message: notMergeable.trim() });
        expect(gh.calls.at(-1)?.[1]).toBe("merge");

        const reopen = yield* service
          .pullRequestAction({ projectId }, { number: 14507, action: { kind: "reopen" } })
          .pipe(Effect.flip);
        expect(reopen).toMatchObject({ code: "conflict", message: alreadyMerged.trim() });
      }),
    ),
  );

  it.live("refuses a head that is not a commit id, and a folder that is not a repository", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gh = signedIn({ write: () => ok("") });
        const { projectId, git: service } = yield* stack(makeRepo("feature"), gh.runner);
        const badHead = yield* service
          .pullRequestAction(
            { projectId },
            { number: 3, headRefOid: "--admin", action: { kind: "merge", method: "merge" } },
          )
          .pipe(Effect.flip);
        expect(badHead.code).toBe("invalid");

        const plain = yield* stack(tempDir("poseidon-pr-plain-"), gh.runner);
        const notRepo = yield* plain.git
          .pullRequestAction(
            { projectId: plain.projectId },
            { number: 3, action: { kind: "close" } },
          )
          .pipe(Effect.flip);
        expect(notRepo.code).toBe("invalid");
        expect(gh.calls).toEqual([]);
      }),
    ),
  );
});

// ── Failed-log tails ───────────────────────────────────────────

describe("failedLogTail", () => {
  it("keeps the end of the log up to the error, without gh's job, step and time", () => {
    const tail = failedLogTail(fixture("gh-run-view.log-failed.txt"))!;
    const lines = tail.split("\n");
    // A Go panic's frames fill the 4 KB before 60 lines do.
    expect(lines.length).toBeLessThan(60);
    expect(Buffer.byteLength(tail, "utf8")).toBeGreaterThan(3500);
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(4096);
    expect(lines.at(-1)).toBe("##[error]Process completed with exit code 1.");
    expect(lines.at(-2)).toBe("exit status 2");
    expect(tail).not.toContain("Post job cleanup");
    expect(tail).not.toMatch(/govulncheck\tUNKNOWN STEP/);
    expect(tail).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    // A Go frame's file line keeps its leading tab.
    expect(lines.some((line) => line.startsWith("\t"))).toBe(true);
  });

  it("caps the tail at 60 lines and 4 KB of whole lines, and is null when there is nothing", () => {
    const long = Array.from(
      { length: 50 },
      (_, index) => `job\tstep\t2026-09-11T05:20:53.1016205Z line ${index} ${"x".repeat(200)}`,
    ).join("\n");
    const tail = failedLogTail(`﻿${long}\n`)!;
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(4096);
    expect(tail.split("\n").every((line) => line.startsWith("line "))).toBe(true);
    expect(tail.endsWith(`line 49 ${"x".repeat(200)}`)).toBe(true);
    const short = Array.from(
      { length: 100 },
      (_, index) => `job\tstep\t2026-09-11T05:20:53Z ${index}`,
    );
    expect(failedLogTail(short.join("\n"))!.split("\n")).toEqual(
      Array.from({ length: 60 }, (_, index) => String(index + 40)),
    );
    expect(failedLogTail("")).toBeNull();
    expect(failedLogTail("\n\n")).toBeNull();
    expect(failedLogTail("x".repeat(5000))).toHaveLength(4096);
  });
});

// ── Fix context ────────────────────────────────────────────────

/** The closed, failing pull request, with four more failing checks built from its own. */
const manyFailing = (): string => {
  const view = JSON.parse(fixture("gh-pr-view.failing.json")) as {
    statusCheckRollup: Array<Record<string, unknown>>;
  };
  const govulncheck = view.statusCheckRollup.find((check) => check.name === "govulncheck")!;
  const copies = ["lint-a", "lint-b", "lint-c"].map((name, index) => ({
    ...govulncheck,
    name,
    detailsUrl: `https://github.com/cli/cli/actions/runs/34558150659/job/10315684877${index}`,
  }));
  const status = {
    __typename: "StatusContext",
    context: "ci/circleci: build",
    state: "FAILURE",
    startedAt: "2026-09-11T05:20:11Z",
    targetUrl: "https://circleci.com/gh/cli/cli/1",
  };
  view.statusCheckRollup.push(...copies, status);
  return JSON.stringify(view);
};

describe("git.pullRequest.fixContext for checks", () => {
  it.live("reads the log tails of the first three failing Actions jobs only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo("bump-go-1.27.1");
        const log = fixture("gh-run-view.log-failed.txt");
        const gh = signedIn({
          view: () => ok(manyFailing()),
          runView: (jobId) =>
            jobId === "103156848770"
              ? { stdout: "", stderr: "HTTP 410: logs expired\n", exitCode: 1 }
              : ok(log),
        });
        const { projectId, git: service } = yield* stack(root, gh.runner);

        const context = yield* service.pullRequestFixContext(
          { projectId },
          { number: 14423, kind: "checks" },
        );
        expect(context.base).toBe("trunk");
        expect(context.conflictFiles).toEqual([]);
        expect(context.checks.map((check) => check.name)).toEqual([
          "ci/circleci: build",
          "govulncheck",
          "lint-a",
          "lint-b",
          "lint-c",
        ]);
        const byName = new Map(context.checks.map((check) => [check.name, check]));
        // A commit status has no Actions job, so no log.
        expect(byName.get("ci/circleci: build")).toEqual({
          name: "ci/circleci: build",
          url: "https://circleci.com/gh/cli/cli/1",
          logTail: null,
        });
        expect(byName.get("govulncheck")?.logTail).toContain("##[error]Process completed");
        expect(byName.get("lint-a")?.logTail).toBeNull(); // the read failed
        expect(byName.get("lint-b")?.logTail).toContain("exit status 2");
        expect(byName.get("lint-c")?.logTail).toBeNull(); // past the three-job cap

        const reads = gh.calls.filter((args) => args[0] === "run");
        expect(reads).toEqual(
          ["103156848767", "103156848770", "103156848771"].map((jobId) => [
            "run",
            "view",
            "--job",
            jobId,
            "--log-failed",
            "--repo",
            "cli/cli",
          ]),
        );
      }),
    ),
  );

  it.live("answers a null tail when gh vanishes mid-read, and refuses a stale number", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo("bump-go-1.27.1");
        const gh = signedIn({
          view: () => ok(fixture("gh-pr-view.failing.json")),
          runView: () => "missing",
        });
        const { projectId, git: service } = yield* stack(root, gh.runner);
        const context = yield* service.pullRequestFixContext(
          { projectId },
          { number: 14423, kind: "checks" },
        );
        expect(context.checks).toEqual([
          {
            name: "govulncheck",
            url: "https://github.com/cli/cli/actions/runs/34558150659/job/103156848767",
            logTail: null,
          },
        ]);

        const stale = yield* service
          .pullRequestFixContext({ projectId }, { number: 99, kind: "checks" })
          .pipe(Effect.flip);
        expect(stale.code).toBe("conflict");
      }),
    ),
  );
});

/**
 * A repository on `feature` whose `origin` (a bare repository) has moved
 * `trunk` on since the branch was cut: `a.txt` on both sides when
 * `conflicting`, a separate file on the remote's side otherwise. Fetched, so
 * `origin/trunk` is what the remote holds.
 */
const divergedRepo = (conflicting: boolean) => {
  const root = makeRepo();
  git(root, "branch", "-m", "main", "trunk");
  const bare = tempDir("poseidon-pr-remote-");
  git(bare, "init", "-q", "--bare", "-b", "trunk");
  git(root, "remote", "add", "origin", bare);
  git(root, "push", "-q", "origin", "trunk");

  const other = nodePath.join(tempDir("poseidon-pr-clone-"), "clone");
  git(root, "clone", "-q", "-b", "trunk", bare, other);
  git(other, "config", "user.email", "test@poseidon.local");
  git(other, "config", "user.name", "Poseidon Test");
  git(other, "config", "commit.gpgsign", "false");
  writeFileSync(nodePath.join(other, conflicting ? "a.txt" : "b.txt"), "theirs\n");
  git(other, "add", "-A");
  git(other, "commit", "-qm", "theirs");
  git(other, "push", "-q", "origin", "trunk");

  git(root, "switch", "-q", "-c", "feature");
  writeFileSync(nodePath.join(root, "a.txt"), "ours\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "ours");
  git(root, "fetch", "-q", "origin");
  return root;
};

describe("git.pullRequest.fixContext for conflicts", () => {
  it.live("lists the files a merge of the remote base would conflict in", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = divergedRepo(true);
        const statusBefore = git(root, "status", "--porcelain");
        const gh = signedIn({});
        const { projectId, git: service } = yield* stack(root, gh.runner);
        const context = yield* service.pullRequestFixContext(
          { projectId },
          { number: 14519, kind: "conflicts" },
        );
        expect(context).toEqual({ checks: [], conflictFiles: ["a.txt"], base: "origin/trunk" });
        // Read without touching the index or the working tree, and nothing fetched.
        expect(git(root, "status", "--porcelain")).toBe(statusBefore);
        expect(gh.calls.some((args) => args[0] === "run")).toBe(false);
      }),
    ),
  );

  it.live("answers no files for a clean merge, or a base the remote does not have", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const clean = divergedRepo(false);
        const first = yield* stack(clean, signedIn({}).runner);
        expect(
          yield* first.git.pullRequestFixContext(
            { projectId: first.projectId },
            { number: 14519, kind: "conflicts" },
          ),
        ).toEqual({ checks: [], conflictFiles: [], base: "origin/trunk" });

        // The view says the base is `master`, which origin has never had.
        const gh = signedIn({ view: () => ok(fixture("gh-pr-view.status-context.json")) });
        const second = yield* stack(divergedRepo(true), gh.runner);
        expect(
          yield* second.git.pullRequestFixContext(
            { projectId: second.projectId },
            { number: 142465, kind: "conflicts" },
          ),
        ).toEqual({ checks: [], conflictFiles: [], base: "origin/master" });
      }),
    ),
  );
});
