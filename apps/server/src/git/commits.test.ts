/**
 * The commit, push and pull-request RPCs. Commit and push run against real
 * repositories in tmp directories, with a local bare repository as the
 * remote; the pull request flow runs against a fake `GhRunner` that answers
 * with the wording gh 2.92 prints, so no test ever talks to GitHub.
 */
import { describe, expect, it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import {
  makeEventId,
  makeProjectId,
  makeThreadId,
  makeTurnId,
  type ProjectId,
  type ThreadId,
} from "@poseidon/contracts/ids";
import type { ThreadWorktree } from "@poseidon/contracts/git";
import type { OrchestrationEvent } from "@poseidon/contracts/orchestration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { foldThread } from "../orchestration/state";
import { runMigrations } from "../persistence/Migrations";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { GitService, SettingsStore } from "../rpc/services";
import { layer as gitLayer } from "./Git";
import { createPullRequest, GhMissing, GhRunner, type GhOutput } from "./GitHubCli";
import { WorktreesRoot } from "./Worktrees";

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A tmp directory by its real path: macOS hands out `/var`, git prints `/private/var`. */
const tempDir = (prefix: string) => realpathSync(mkdtempSync(nodePath.join(tmpdir(), prefix)));

/** CI has no global identity, so every repository gets its own — and signs nothing. */
const identify = (root: string) => {
  git(root, "config", "user.email", "test@poseidon.local");
  git(root, "config", "user.name", "Poseidon Test");
  git(root, "config", "commit.gpgsign", "false");
};

/** A repository with one commit of `a.txt` on `main`. */
const makeRepo = () => {
  const root = tempDir("poseidon-commit-repo-");
  git(root, "init", "-q", "-b", "main");
  identify(root);
  writeFileSync(nodePath.join(root, "a.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
};

/** A bare repository standing in for the remote, added to `root` as `origin`. */
const addBareRemote = (root: string, name = "origin") => {
  const bare = tempDir("poseidon-commit-remote-");
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(root, "remote", "add", name, bare);
  return bare;
};

const write = (root: string, name: string, text: string) =>
  writeFileSync(nodePath.join(root, name), text);

/** Paths the HEAD commit touched. */
const committedPaths = (root: string) =>
  git(root, "show", "--name-only", "--format=", "HEAD").trim().split("\n").filter(Boolean).sort();

const createdEvent = (
  threadId: ThreadId,
  projectId: ProjectId,
  worktree: ThreadWorktree | undefined,
): OrchestrationEvent =>
  ({
    sequence: 1,
    eventId: makeEventId(),
    streamKind: "thread",
    streamId: threadId,
    streamVersion: 1,
    occurredAt: new Date().toISOString(),
    actor: "user",
    type: "thread.created",
    payload: {
      threadId,
      projectId,
      title: "Thread",
      settings: { model: "fake/model", runtimeMode: "full-access", interactionMode: "default" },
      ...(worktree === undefined ? {} : { worktree }),
    },
  }) as OrchestrationEvent;

// ── A fake gh ──────────────────────────────────────────────────

/** What gh 2.92 prints, captured from the real binary (the token masked as gh masks it). */
const GH_VERSION: GhOutput = {
  stdout: "gh version 2.92.0 (2026-04-28)\nhttps://github.com/cli/cli/releases/tag/v2.92.0\n",
  stderr: "",
  exitCode: 0,
};
const GH_AUTHENTICATED: GhOutput = {
  stdout: [
    "github.com",
    "  ✓ Logged in to github.com account octo (keyring)",
    "  - Active account: true",
    "  - Git operations protocol: https",
    "  - Token: gho_************************************",
    "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
    "",
  ].join("\n"),
  stderr: "",
  exitCode: 0,
};
const GH_NOT_AUTHENTICATED: GhOutput = {
  stdout: "",
  stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login\n",
  exitCode: 1,
};

type GhScript = (args: ReadonlyArray<string>) => GhOutput | "missing";

/** A runner that answers from `script` and records every argv it was handed. */
const fakeGh = (script: GhScript) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const runner = GhRunner.of({
    run: (args) =>
      Effect.suspend(() => {
        calls.push(args);
        const answer = script(args);
        return answer === "missing"
          ? Effect.fail(new GhMissing({ message: "spawn gh ENOENT" }))
          : Effect.succeed(answer);
      }),
  });
  return { runner, calls };
};

/** gh signed in, answering `pr create` (and `pr view`) as given. */
const signedInGh = (prCreate: GhOutput, prView?: GhOutput) =>
  fakeGh((args) => {
    if (args[0] === "--version") return GH_VERSION;
    if (args[0] === "auth") return GH_AUTHENTICATED;
    if (args[0] === "pr" && args[1] === "create") return prCreate;
    if (args[0] === "pr" && args[1] === "view" && prView !== undefined) return prView;
    return { stdout: "", stderr: `unexpected gh ${args.join(" ")}`, exitCode: 1 };
  });

// ── The service stack ──────────────────────────────────────────

/** Real sqlite + read models + the git layer over `gh`, with a project on `root`. */
const stack = (root: string, gh: GhRunner["Service"] = fakeGh(() => "missing").runner) =>
  Effect.gen(function* () {
    const sqlite = Layer.succeedContext(yield* Layer.build(sqliteTestLayer()));
    yield* runMigrations.pipe(Effect.provide(sqlite));
    const rmContext = yield* Layer.build(ReadModelStore.layer.pipe(Layer.provide(sqlite)));
    const readModels = Context.get(rmContext, ReadModelStore);
    const now = new Date().toISOString();
    const projectId = makeProjectId();
    yield* readModels.putProject({
      projectId,
      name: "test",
      workspaceRoot: root,
      createdAt: now,
      updatedAt: now,
      removed: false,
    });
    /** A thread, idle or with a turn in flight, local unless given a worktree. */
    const addThread = (options: { running: boolean; worktree?: ThreadWorktree }) =>
      Effect.gen(function* () {
        const threadId = makeThreadId();
        const doc = foldThread([createdEvent(threadId, projectId, options.worktree)])!;
        yield* readModels.putThread(
          options.running
            ? {
                ...doc,
                status: "running",
                currentTurn: {
                  turnId: makeTurnId(),
                  input: { text: "go", attachments: [], mentions: [] },
                },
              }
            : doc,
        );
        return threadId;
      });
    const services = yield* Layer.build(
      gitLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeedContext(rmContext),
            Layer.succeed(GhRunner, gh),
            SettingsStore.layer.pipe(Layer.provide(sqlite)),
            // No test here cuts a worktree, so nothing is created under it.
            Layer.succeed(WorktreesRoot, {
              path: nodePath.join(tmpdir(), "poseidon-no-worktrees"),
            }),
          ),
        ),
      ),
    );
    return { projectId, addThread, git: Context.get(services, GitService) };
  });

// ── Commit ─────────────────────────────────────────────────────

describe("git.commit", () => {
  it.live("commits every change, untracked files included, as the user", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        write(root, "a.txt", "one\ntwo\n");
        write(root, "b.txt", "new\n");
        const { projectId, git: service } = yield* stack(root);

        const result = yield* service.commit({ projectId }, { message: "Add b\n\nAnd edit a." });
        expect(result).toEqual({
          sha: git(root, "rev-parse", "HEAD").trim(),
          subject: "Add b",
          branch: "main",
        });
        expect(committedPaths(root)).toEqual(["a.txt", "b.txt"]);
        expect(git(root, "status", "--porcelain").trim()).toBe("");
        expect(git(root, "log", "-1", "--format=%an <%ae>").trim()).toBe(
          "Poseidon Test <test@poseidon.local>",
        );
      }),
    ),
  );

  it.live("commits only the chosen paths, leaving the rest uncommitted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        write(root, "a.txt", "one\nedited\n");
        write(root, "b.txt", "new\n");
        write(root, "c d.txt", "spaced\n");
        // Staged by hand, but not picked: it must not ride along.
        git(root, "add", "a.txt");
        const { projectId, git: service } = yield* stack(root);

        yield* service.commit({ projectId }, { message: "Add b", paths: ["b.txt", "c d.txt"] });
        expect(committedPaths(root)).toEqual(["b.txt", "c d.txt"]);
        expect(git(root, "status", "--porcelain").trim()).toBe("M a.txt");

        const none = yield* service
          .commit({ projectId }, { message: "x", paths: [] })
          .pipe(Effect.flip);
        expect(none.code).toBe("invalid");
        const missing = yield* service
          .commit({ projectId }, { message: "x", paths: ["nope.txt"] })
          .pipe(Effect.flip);
        expect(missing.code).toBe("invalid");
        expect(missing.message).toContain("nope.txt");
      }),
    ),
  );

  it.live("commits a chosen staged rename whole: the new path and the old one's deletion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        write(root, "other.txt", "other\n");
        git(root, "add", "other.txt");
        git(root, "commit", "-qm", "add other");
        // The agent moved a file; status shows it as one `a.txt → b.txt` row.
        git(root, "mv", "a.txt", "b.txt");
        write(root, "other.txt", "edited\n");
        const { projectId, git: service } = yield* stack(root);

        // `other.txt` is left unchecked, so only the rename's row is sent.
        yield* service.commit({ projectId }, { message: "Rename a", paths: ["b.txt"] });
        expect(git(root, "show", "--name-status", "--format=", "-M", "HEAD").trim()).toBe(
          "R100\ta.txt\tb.txt",
        );
        expect(git(root, "ls-tree", "--name-only", "HEAD").trim().split("\n")).toEqual([
          "b.txt",
          "other.txt",
        ]);
        expect(git(root, "status", "--porcelain").trim()).toBe("M other.txt");
      }),
    ),
  );

  it.live("answers conflict when there is nothing to commit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { projectId, git: service } = yield* stack(root);
        const error = yield* service.commit({ projectId }, { message: "empty" }).pipe(Effect.flip);
        expect(error.code).toBe("conflict");
        expect(error.message).toBe("Nothing to commit.");
      }),
    ),
  );

  it.live("surfaces a failing pre-commit hook's own message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        // A hooks directory of the repository's own, so a global hooksPath
        // on the machine running the tests cannot stand in for it.
        const hooks = nodePath.join(root, ".hooks");
        mkdirSync(hooks);
        const hook = nodePath.join(hooks, "pre-commit");
        writeFileSync(hook, '#!/bin/sh\necho "lint: trailing whitespace in b.txt" >&2\nexit 1\n');
        chmodSync(hook, 0o755);
        git(root, "config", "core.hooksPath", hooks);
        write(root, "b.txt", "new \n");
        const { projectId, git: service } = yield* stack(root);

        const error = yield* service
          .commit({ projectId }, { message: "Add b", paths: ["b.txt"] })
          .pipe(Effect.flip);
        expect(error.code).toBe("conflict");
        expect(error.message).toContain("lint: trailing whitespace in b.txt");
        expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("1");
      }),
    ),
  );

  it.live("leaves what the user had staged in place when no commit is made", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        // A partly staged a.txt: one version in the index, a newer one on disk.
        write(root, "a.txt", "staged\n");
        git(root, "add", "a.txt");
        write(root, "a.txt", "staged\nand more\n");
        write(root, "b.txt", "new\n");
        const stagedBefore = git(root, "diff", "--cached");
        const { projectId, git: service } = yield* stack(root);

        // A picked path git cannot stage: nothing is committed, and the index
        // the reset would have wiped is back.
        const missing = yield* service
          .commit({ projectId }, { message: "x", paths: ["b.txt", "nope.txt"] })
          .pipe(Effect.flip);
        expect(missing.code).toBe("invalid");
        expect(git(root, "diff", "--cached")).toBe(stagedBefore);

        // A hook that refuses, after everything was staged: the same.
        const hook = nodePath.join(root, ".git", "hooks", "pre-commit");
        writeFileSync(hook, "#!/bin/sh\nexit 1\n");
        chmodSync(hook, 0o755);
        git(root, "config", "core.hooksPath", nodePath.dirname(hook));
        for (const paths of [undefined, ["b.txt"]]) {
          const refused = yield* service
            .commit({ projectId }, { message: "x", ...(paths === undefined ? {} : { paths }) })
            .pipe(Effect.flip);
          expect(refused.code).toBe("conflict");
          expect(git(root, "diff", "--cached")).toBe(stagedBefore);
        }
        expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("1");
        expect(git(root, "show", ":a.txt")).toBe("staged\n");
      }),
    ),
  );

  it.live("keeps a merge in progress: no partial commit, and a whole one has both parents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        git(root, "switch", "-q", "-c", "side");
        write(root, "b.txt", "side\n");
        git(root, "add", "b.txt");
        git(root, "commit", "-qm", "side");
        git(root, "switch", "-q", "main");
        write(root, "c.txt", "main\n");
        git(root, "add", "c.txt");
        git(root, "commit", "-qm", "main");
        git(root, "merge", "-q", "--no-commit", "--no-ff", "side");
        write(root, "a.txt", "one\nresolved\n");
        const mergeHead = git(root, "rev-parse", "MERGE_HEAD").trim();
        const stagedBefore = git(root, "diff", "--cached");
        const { projectId, git: service } = yield* stack(root);

        // `git commit -- b.txt` refuses mid-merge; so does this, and the merge
        // and the index stay as they were.
        const partial = yield* service
          .commit({ projectId }, { message: "Merge side", paths: ["b.txt"] })
          .pipe(Effect.flip);
        expect(partial.code).toBe("conflict");
        expect(partial.message).toContain("merge is in progress");
        expect(git(root, "rev-parse", "MERGE_HEAD").trim()).toBe(mergeHead);
        expect(git(root, "diff", "--cached")).toBe(stagedBefore);

        // A hook that refuses the whole commit leaves the merge in progress too.
        const hook = nodePath.join(root, ".git", "hooks", "pre-commit");
        writeFileSync(hook, "#!/bin/sh\nexit 1\n");
        chmodSync(hook, 0o755);
        git(root, "config", "core.hooksPath", nodePath.dirname(hook));
        yield* service.commit({ projectId }, { message: "Merge side" }).pipe(Effect.flip);
        expect(git(root, "rev-parse", "MERGE_HEAD").trim()).toBe(mergeHead);

        rmSync(hook);
        yield* service.commit({ projectId }, { message: "Merge side" });
        expect(git(root, "rev-list", "--parents", "-1", "HEAD").trim().split(" ")).toHaveLength(3);
        expect(git(root, "show", "HEAD:a.txt")).toBe("one\nresolved\n");
      }),
    ),
  );

  it.live("refuses to commit over unresolved conflicts, leaving them in the index", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        git(root, "switch", "-q", "-c", "side");
        write(root, "a.txt", "side\n");
        git(root, "commit", "-qam", "side");
        git(root, "switch", "-q", "main");
        write(root, "a.txt", "main\n");
        git(root, "commit", "-qam", "main");
        // The merge stops on the conflict, which is what it exits 1 for.
        expect(() => git(root, "merge", "-q", "side")).toThrow();
        write(root, "b.txt", "new\n");
        const conflictStages = git(root, "ls-files", "--unmerged");
        const { projectId, git: service } = yield* stack(root);

        for (const paths of [undefined, ["b.txt"]]) {
          const refused = yield* service
            .commit({ projectId }, { message: "x", ...(paths === undefined ? {} : { paths }) })
            .pipe(Effect.flip);
          expect(refused.code).toBe("conflict");
          expect(refused.message).toBe("Resolve the conflicts in a.txt before committing.");
          expect(git(root, "ls-files", "--unmerged")).toBe(conflictStages);
          expect(git(root, "rev-parse", "-q", "--verify", "MERGE_HEAD").trim()).not.toBe("");
        }
        expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("2");
      }),
    ),
  );

  it.live("refuses a partial commit mid-cherry-pick, keeping the pick", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        git(root, "switch", "-q", "-c", "side");
        write(root, "b.txt", "picked\n");
        git(root, "add", "b.txt");
        git(root, "commit", "-qm", "pick me");
        git(root, "switch", "-q", "main");
        git(root, "cherry-pick", "--no-commit", "side");
        write(root, "c.txt", "other\n");
        // `--no-commit` records no CHERRY_PICK_HEAD, so write the one a
        // cherry-pick that stopped for the user leaves.
        writeFileSync(
          nodePath.join(root, ".git", "CHERRY_PICK_HEAD"),
          git(root, "rev-parse", "side"),
        );
        const { projectId, git: service } = yield* stack(root);

        const refused = yield* service
          .commit({ projectId }, { message: "x", paths: ["b.txt"] })
          .pipe(Effect.flip);
        expect(refused.code).toBe("conflict");
        expect(refused.message).toContain("cherry-pick is in progress");
        expect(git(root, "rev-parse", "CHERRY_PICK_HEAD").trim()).toBe(
          git(root, "rev-parse", "side").trim(),
        );
      }),
    ),
  );

  it.live("refuses while a turn runs in the same root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        write(root, "b.txt", "new\n");
        const { projectId, addThread, git: service } = yield* stack(root);
        yield* addThread({ running: true });

        const error = yield* service.commit({ projectId }, { message: "Add b" }).pipe(Effect.flip);
        expect(error.code).toBe("conflict");
        expect(error.message).toContain("stop it before committing");
        expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("1");
      }),
    ),
  );
});

// ── Push ───────────────────────────────────────────────────────

describe("git.push", () => {
  it.live("sets the upstream on the first push and pushes plainly after", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const bare = addBareRemote(root);
        git(root, "switch", "-q", "-c", "feature");
        write(root, "b.txt", "new\n");
        const { projectId, git: service } = yield* stack(root);
        yield* service.commit({ projectId }, { message: "Add b" });

        const first = yield* service.push({ projectId });
        expect(first).toEqual({ remote: "origin", branch: "feature", setUpstream: true });
        expect(git(bare, "rev-parse", "refs/heads/feature").trim()).toBe(
          git(root, "rev-parse", "HEAD").trim(),
        );
        expect(git(root, "rev-parse", "--abbrev-ref", "feature@{upstream}").trim()).toBe(
          "origin/feature",
        );

        write(root, "c.txt", "more\n");
        yield* service.commit({ projectId }, { message: "Add c" });
        const second = yield* service.push({ projectId });
        expect(second).toEqual({ remote: "origin", branch: "feature", setUpstream: false });
        expect(git(bare, "rev-parse", "refs/heads/feature").trim()).toBe(
          git(root, "rev-parse", "HEAD").trim(),
        );
      }),
    ),
  );

  it.live("answers unavailable when the repository has no remote", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { projectId, git: service } = yield* stack(root);
        const error = yield* service.push({ projectId }).pipe(Effect.flip);
        expect(error.code).toBe("unavailable");
        expect(error.message).toBe("This repository has no remote to push to.");
      }),
    ),
  );

  it.live("pushes to the only remote when there is no origin, and refuses a detached HEAD", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const bare = addBareRemote(root, "upstream");
        const { projectId, git: service } = yield* stack(root);

        const pushed = yield* service.push({ projectId });
        expect(pushed).toEqual({ remote: "upstream", branch: "main", setUpstream: true });
        expect(git(bare, "rev-parse", "refs/heads/main").trim()).toBe(
          git(root, "rev-parse", "HEAD").trim(),
        );

        git(root, "switch", "-q", "--detach", "HEAD");
        const detached = yield* service.push({ projectId }).pipe(Effect.flip);
        expect(detached.code).toBe("invalid");
      }),
    ),
  );

  it.live("pushes a branch cut --no-track from origin/main to its own name, not main", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const bare = addBareRemote(root);
        git(root, "push", "-q", "origin", "main");
        git(root, "fetch", "-q", "origin");
        const mainBefore = git(bare, "rev-parse", "refs/heads/main").trim();
        const { projectId, git: service } = yield* stack(root);

        yield* service.createBranch(
          { projectId },
          { name: "poseidon/fix", from: "origin/main", checkout: true },
        );
        write(root, "fix.txt", "fixed\n");
        yield* service.commit({ projectId }, { message: "Fix it" });
        const pushed = yield* service.push({ projectId });

        expect(pushed).toEqual({ remote: "origin", branch: "poseidon/fix", setUpstream: true });
        expect(git(bare, "rev-parse", "refs/heads/main").trim()).toBe(mainBefore);
        expect(git(bare, "rev-parse", "refs/heads/poseidon/fix").trim()).toBe(
          git(root, "rev-parse", "HEAD").trim(),
        );
      }),
    ),
  );
});

// ── Pull requests ──────────────────────────────────────────────

const prArgs = { head: "poseidon/fix", base: "main", title: "Fix it", body: "Body\n\n- one" };

describe("git.pullRequest.create", () => {
  it.effect("answers unavailable when gh is not installed", () =>
    Effect.gen(function* () {
      const { runner, calls } = fakeGh(() => "missing");
      const error = yield* createPullRequest(runner, "/repo", prArgs).pipe(Effect.flip);
      expect(error.code).toBe("unavailable");
      expect(error.message).toContain("gh not available");
      expect(calls).toEqual([["--version"]]);
    }),
  );

  it.effect("answers unavailable when gh is not signed in", () =>
    Effect.gen(function* () {
      const { runner, calls } = fakeGh((args) =>
        args[0] === "--version" ? GH_VERSION : GH_NOT_AUTHENTICATED,
      );
      const error = yield* createPullRequest(runner, "/repo", prArgs).pipe(Effect.flip);
      expect(error.code).toBe("unavailable");
      expect(error.message).toContain("not authenticated");
      expect(error.message).toContain("gh auth login");
      expect(calls.map((args) => args[0])).toEqual(["--version", "auth"]);
    }),
  );

  it.effect("creates the pull request with every field as its own argument", () =>
    Effect.gen(function* () {
      const { runner, calls } = signedInGh({
        stdout: "https://github.com/acme/app/pull/42\n",
        stderr: "",
        exitCode: 0,
      });
      const result = yield* createPullRequest(runner, "/repo", {
        ...prArgs,
        title: "--draft; rm -rf / $(x)",
      });
      expect(result).toEqual({ url: "https://github.com/acme/app/pull/42", created: true });
      expect(calls[2]).toEqual([
        "pr",
        "create",
        "--head",
        "poseidon/fix",
        "--base",
        "main",
        "--title",
        "--draft; rm -rf / $(x)",
        "--body",
        "Body\n\n- one",
      ]);
    }),
  );

  it.effect("answers the open pull request when one already exists", () =>
    Effect.gen(function* () {
      const { runner } = signedInGh({
        stdout: "",
        stderr:
          'a pull request for branch "poseidon/fix" into branch "main" already exists:\nhttps://github.com/acme/app/pull/41\n',
        exitCode: 1,
      });
      const result = yield* createPullRequest(runner, "/repo", prArgs);
      expect(result).toEqual({ url: "https://github.com/acme/app/pull/41", created: false });
    }),
  );

  it.effect("falls back to gh pr view when the refusal carries no URL", () =>
    Effect.gen(function* () {
      const { runner, calls } = signedInGh(
        {
          stdout: "",
          stderr: 'a pull request for branch "poseidon/fix" into branch "main" already exists\n',
          exitCode: 1,
        },
        { stdout: "https://github.com/acme/app/pull/41\n", stderr: "", exitCode: 0 },
      );
      const result = yield* createPullRequest(runner, "/repo", prArgs);
      expect(result).toEqual({ url: "https://github.com/acme/app/pull/41", created: false });
      expect(calls[3]).toEqual(["pr", "view", "poseidon/fix", "--json", "url", "-q", ".url"]);
    }),
  );

  it.effect("passes any other refusal through in gh's own words", () =>
    Effect.gen(function* () {
      const { runner } = signedInGh({
        stdout: "",
        stderr: "pull request create failed: GraphQL: No commits between main and poseidon/fix\n",
        exitCode: 1,
      });
      const error = yield* createPullRequest(runner, "/repo", prArgs).pipe(Effect.flip);
      expect(error.code).toBe("conflict");
      expect(error.message).toContain("No commits between main and poseidon/fix");
    }),
  );

  it.live("opens it from the current branch into the worktree's base, else the default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        addBareRemote(root);
        git(root, "push", "-q", "origin", "main");
        git(root, "switch", "-q", "-c", "poseidon/fix");
        const { runner, calls } = signedInGh({
          stdout: "https://github.com/acme/app/pull/7\n",
          stderr: "",
          exitCode: 0,
        });
        const { projectId, addThread, git: service } = yield* stack(root, runner);
        const argsOf = (call: ReadonlyArray<string> | undefined) => ({
          head: call?.[call.indexOf("--head") + 1],
          base: call?.[call.indexOf("--base") + 1],
        });

        yield* service.createPullRequest({ projectId }, { title: "Fix", body: "" });
        expect(argsOf(calls.at(-1))).toEqual({ head: "poseidon/fix", base: "main" });

        // A worktree cut from a remote branch: gh is given the remote's own name for it.
        const threadId = yield* addThread({
          running: false,
          worktree: { path: root, branch: "poseidon/fix", baseBranch: "origin/release" },
        });
        yield* service.createPullRequest({ projectId, threadId }, { title: "Fix", body: "" });
        expect(argsOf(calls.at(-1))).toEqual({ head: "poseidon/fix", base: "release" });

        yield* service.createPullRequest(
          { projectId, threadId },
          { title: "Fix", body: "", base: "develop" },
        );
        expect(argsOf(calls.at(-1))).toEqual({ head: "poseidon/fix", base: "develop" });

        const bad = yield* service
          .createPullRequest({ projectId }, { title: "Fix", body: "", base: "-x" })
          .pipe(Effect.flip);
        expect(bad.code).toBe("invalid");
      }),
    ),
  );
});

describe("git.pullRequest.readiness", () => {
  it.live("says why gh cannot open a pull request, and nothing once it can", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const readiness = (gh: GhRunner["Service"]) =>
          Effect.gen(function* () {
            const { projectId, git: service } = yield* stack(root, gh);
            return (yield* service.pullRequestReadiness({ projectId })).reason;
          });

        expect(yield* readiness(fakeGh(() => "missing").runner)).toContain("gh not available");
        const signedOut = fakeGh((args) =>
          args[0] === "--version" ? GH_VERSION : GH_NOT_AUTHENTICATED,
        );
        expect(yield* readiness(signedOut.runner)).toContain("gh auth login");
        const signedIn = signedInGh(GH_NOT_AUTHENTICATED);
        expect(yield* readiness(signedIn.runner)).toBeNull();
        // Asking opens nothing: only the two probes ran.
        expect(signedIn.calls).toEqual([["--version"], ["auth", "status"]]);
      }),
    ),
  );
});
