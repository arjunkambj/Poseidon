/**
 * The worktree RPCs against real repositories in tmp directories, with the
 * worktrees root injected as another tmp directory: cutting a worktree for a
 * thread (its branch, base, directory, uniqueness and the prefix setting),
 * listing, removing under the guards, the setup script streamed from a real
 * `/bin/sh` and killed with its whole group when the stream is interrupted,
 * and checkpoints captured inside a worktree created this way.
 */
import { describe, expect, it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
import type { ThreadWorktree, WorktreeSetupFrame } from "@poseidon/contracts/git";
import type { OrchestrationEvent } from "@poseidon/contracts/orchestration";
import { DEFAULT_GIT_SETTINGS } from "@poseidon/contracts/settings";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { foldThread } from "../orchestration/state";
import { runMigrations } from "../persistence/Migrations";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { GitService, SettingsStore } from "../rpc/services";
import { make as checkpointStore } from "./CheckpointStore";
import { layer as gitLayer } from "./Git";
import { GhRunner } from "./GitHubCli";
import { SETUP_OUTPUT_LIMIT_BYTES } from "./SetupScript";
import { WorktreesRoot } from "./Worktrees";

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A tmp directory by its real path: macOS hands out `/var`, git prints `/private/var`. */
const tempDir = (prefix: string) => realpathSync(mkdtempSync(nodePath.join(tmpdir(), prefix)));

/** A repository with one commit on `main`, and a local identity (CI has none). */
const makeRepo = () => {
  const root = tempDir("poseidon-worktrees-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@poseidon.local");
  git(root, "config", "user.name", "Poseidon Test");
  writeFileSync(nodePath.join(root, "a.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
};

/** Pushes `main` to a local bare repository standing in for `origin`. */
const addBareRemote = (root: string) => {
  const bare = tempDir("poseidon-worktrees-remote-");
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(root, "remote", "add", "origin", bare);
  git(root, "push", "-q", "-u", "origin", "main");
  return bare;
};

const createdEvent = (
  threadId: ThreadId,
  projectId: ProjectId,
  worktree: ThreadWorktree,
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
      worktree,
    },
  }) as OrchestrationEvent;

/**
 * Real sqlite, read models, settings store and git layer, with worktrees going
 * under a fresh tmp directory rather than the Poseidon home.
 */
const stack = Effect.gen(function* () {
  const sqlite = Layer.succeedContext(yield* Layer.build(sqliteTestLayer()));
  yield* runMigrations.pipe(Effect.provide(sqlite));
  const rmContext = yield* Layer.build(ReadModelStore.layer.pipe(Layer.provide(sqlite)));
  const readModels = Context.get(rmContext, ReadModelStore);
  const worktreesRoot = tempDir("poseidon-worktrees-home-");
  const context = yield* Layer.build(
    gitLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeedContext(rmContext),
          GhRunner.layer,
          SettingsStore.layer.pipe(Layer.provide(sqlite)),
          Layer.succeed(WorktreesRoot, { path: worktreesRoot }),
        ),
      ),
    ),
  );
  const now = new Date().toISOString();
  const addProject = (workspaceRoot: string, name = "My App") =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      yield* readModels.putProject({
        projectId,
        name,
        workspaceRoot,
        createdAt: now,
        updatedAt: now,
        removed: false,
      });
      return projectId;
    });
  /** A thread working in `worktree`; `deleted` marks it gone. */
  const addThread = (projectId: ProjectId, worktree: ThreadWorktree, deleted = false) =>
    Effect.gen(function* () {
      const threadId = makeThreadId();
      const doc = foldThread([createdEvent(threadId, projectId, worktree)])!;
      yield* readModels.putThread({ ...doc, deleted });
      return threadId;
    });
  return {
    worktreesRoot,
    addProject,
    addThread,
    git: Context.get(context, GitService),
    settings: Context.get(context, SettingsStore),
  };
});

const errorOf = <A, E>(effect: Effect.Effect<A, E>) => Effect.flip(effect);

/** Every frame of a setup run, in order. */
const frames = (stream: Stream.Stream<WorktreeSetupFrame, unknown>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]));

const outputOf = (list: ReadonlyArray<WorktreeSetupFrame>) =>
  list.map((frame) => (frame.kind === "output" ? frame.text : "")).join("");

describe("git.worktree.create", () => {
  it.live("cuts poseidon/<slug> from the default branch under the worktrees root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject, worktreesRoot } = yield* stack;
        const projectId = yield* addProject(root);

        const worktree = yield* service.createWorktree(projectId, { name: "Fix the login page!" });
        expect(worktree).toEqual({
          path: nodePath.join(worktreesRoot, "my-app", "fix-the-login-page"),
          branch: "poseidon/fix-the-login-page",
          baseBranch: "main",
        });
        expect(git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
          "poseidon/fix-the-login-page",
        );
        expect(git(worktree.path, "rev-parse", "HEAD")).toBe(git(root, "rev-parse", "main"));
        // The project's own checkout did not move.
        expect(git(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
      }),
    ),
  );

  it.live("cuts from a remote branch without tracking it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        addBareRemote(root);
        const { git: service, addProject } = yield* stack;
        const projectId = yield* addProject(root);

        const worktree = yield* service.createWorktree(projectId, {
          name: "retries",
          baseBranch: "origin/main",
        });
        expect(worktree.baseBranch).toBe("origin/main");
        // No upstream: the first push must create poseidon/retries, never update main.
        const upstream = git(
          root,
          "for-each-ref",
          "--format=%(upstream)",
          "refs/heads/poseidon/retries",
        );
        expect(upstream.trim()).toBe("");
      }),
    ),
  );

  it.live("appends -2 when the name is taken, by a branch or by a directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject, worktreesRoot } = yield* stack;
        const projectId = yield* addProject(root);

        const first = yield* service.createWorktree(projectId, { name: "add retries" });
        const second = yield* service.createWorktree(projectId, { name: "add retries" });
        expect(first.branch).toBe("poseidon/add-retries");
        expect(second.branch).toBe("poseidon/add-retries-2");
        expect(second.path).toBe(nodePath.join(worktreesRoot, "my-app", "add-retries-2"));

        // Another project of the same name shares the parent directory: its
        // repository has no such branch, but the directory is taken.
        const other = yield* addProject(makeRepo());
        const third = yield* service.createWorktree(other, { name: "add retries" });
        expect(third.branch).toBe("poseidon/add-retries-3");
        expect(nodePath.dirname(third.path)).toBe(nodePath.join(worktreesRoot, "my-app"));
      }),
    ),
  );

  it.live("honours the branch prefix setting and refuses one that makes a bad name", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject, settings } = yield* stack;
        const projectId = yield* addProject(root);

        yield* settings.update({ git: { ...DEFAULT_GIT_SETTINGS, branchPrefix: "me/" } });
        const mine = yield* service.createWorktree(projectId, { name: "tidy up" });
        expect(mine.branch).toBe("me/tidy-up");
        // The directory is named for the slug alone, whatever the prefix.
        expect(nodePath.basename(mine.path)).toBe("tidy-up");

        for (const branchPrefix of ["bad..prefix/", "-x/", "has space/"]) {
          yield* settings.update({ git: { ...DEFAULT_GIT_SETTINGS, branchPrefix } });
          const error = yield* errorOf(service.createWorktree(projectId, { name: "tidy up" }));
          expect(error.code).toBe("invalid");
          expect(error.message).toContain("branch prefix");
        }
      }),
    ),
  );

  it.live("refuses a base with no commit and an unknown project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject } = yield* stack;
        const projectId = yield* addProject(root);

        const missing = yield* errorOf(
          service.createWorktree(projectId, { name: "x", baseBranch: "nope" }),
        );
        expect(missing.code).toBe("invalid");
        const optionLike = yield* errorOf(
          service.createWorktree(projectId, { name: "x", baseBranch: "--orphan" }),
        );
        expect(optionLike.code).toBe("invalid");
        const unknown = yield* errorOf(service.createWorktree(makeProjectId(), { name: "x" }));
        expect(unknown.code).toBe("not-found");
      }),
    ),
  );

  it.live("leaves a worktree checkpoints capture and list in", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject, addThread } = yield* stack;
        const projectId = yield* addProject(root);
        const worktree = yield* service.createWorktree(projectId, { name: "checkpointed" });
        const threadId = yield* addThread(projectId, worktree);

        writeFileSync(nodePath.join(worktree.path, "a.txt"), "two\n");
        const checkpoint = yield* checkpointStore.capture({
          threadId,
          turnId: makeTurnId(),
          workspaceRoot: worktree.path,
        });
        const listed = yield* service.checkpoints(projectId, threadId);
        expect(listed.map((entry) => entry.checkpointId)).toEqual([checkpoint.checkpointId]);
        expect(git(root, "status", "--porcelain").trim()).toBe("");
      }),
    ),
  );
});

/** A commit pushed to `bare`'s main from another clone, so origin is ahead of the local main. */
const advanceRemote = (bare: string) => {
  const other = tempDir("poseidon-worktrees-other-");
  git(other, "clone", "-q", bare, ".");
  git(other, "config", "user.email", "test@poseidon.local");
  git(other, "config", "user.name", "Poseidon Test");
  writeFileSync(nodePath.join(other, "remote.txt"), "from origin\n");
  git(other, "add", "-A");
  git(other, "commit", "-qm", "remote work");
  git(other, "push", "-q", "origin", "main");
  return git(other, "rev-parse", "HEAD").trim();
};

describe("git.worktree.create from origin", () => {
  it.live("fetches the base and cuts from origin/<base>, recording that ref", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const remoteHead = advanceRemote(addBareRemote(root));
        const { git: service, addProject } = yield* stack;
        const projectId = yield* addProject(root);

        const worktree = yield* service.createWorktree(projectId, { name: "fresh start" });
        expect(worktree.baseBranch).toBe("origin/main");
        expect(worktree.notice).toBeUndefined();
        expect(git(worktree.path, "rev-parse", "HEAD").trim()).toBe(remoteHead);
        // Still cut `--no-track`: the first push must not land on main.
        const upstream = git(
          root,
          "for-each-ref",
          "--format=%(upstream)",
          `refs/heads/${worktree.branch}`,
        );
        expect(upstream.trim()).toBe("");
        // The project's own main did not move.
        expect(git(root, "rev-parse", "main").trim()).not.toBe(remoteHead);
      }),
    ),
  );

  it.live("falls back to the local base with a notice when the fetch fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        git(root, "remote", "add", "origin", nodePath.join(tmpdir(), "poseidon-no-such-remote"));
        const { git: service, addProject } = yield* stack;
        const projectId = yield* addProject(root);

        const worktree = yield* service.createWorktree(projectId, { name: "offline" });
        expect(worktree.baseBranch).toBe("main");
        expect(worktree.notice).toContain("Couldn't fetch main from origin");
        expect(git(worktree.path, "rev-parse", "HEAD")).toBe(git(root, "rev-parse", "main"));

        // A local branch origin does not have: the fetch is refused, and the
        // local branch is used as it is.
        const reachable = makeRepo();
        addBareRemote(reachable);
        git(reachable, "branch", "local-only");
        const reachableProject = yield* addProject(reachable, "Reachable");
        const localOnly = yield* service.createWorktree(reachableProject, {
          name: "local only",
          baseBranch: "local-only",
        });
        expect(localOnly.baseBranch).toBe("local-only");
        expect(localOnly.notice).toContain("local local-only");
      }),
    ),
  );

  it.live("with no origin remote the local base is used without a notice", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject } = yield* stack;
        const projectId = yield* addProject(root);

        const worktree = yield* service.createWorktree(projectId, { name: "no remote" });
        expect(worktree).toEqual({
          path: worktree.path,
          branch: "poseidon/no-remote",
          baseBranch: "main",
        });
      }),
    ),
  );

  it.live("with the setting off it cuts from the local base and fetches nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const bare = addBareRemote(root);
        const trackedBefore = git(root, "rev-parse", "origin/main").trim();
        advanceRemote(bare);
        const { git: service, addProject, settings } = yield* stack;
        const projectId = yield* addProject(root);
        yield* settings.update({ git: { ...DEFAULT_GIT_SETTINGS, worktreeFromOrigin: false } });

        const worktree = yield* service.createWorktree(projectId, { name: "as today" });
        expect(worktree.baseBranch).toBe("main");
        expect(worktree.notice).toBeUndefined();
        expect(git(root, "rev-parse", "origin/main").trim()).toBe(trackedBefore);
      }),
    ),
  );
});

describe("git.worktree.list", () => {
  it.live("lists the project's checkout first, then its worktrees", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject } = yield* stack;
        const projectId = yield* addProject(root);
        const worktree = yield* service.createWorktree(projectId, { name: "listed" });

        const list = yield* service.listWorktrees(projectId);
        expect(list.map(({ path, branch, isMain }) => ({ path, branch, isMain }))).toEqual([
          { path: root, branch: "main", isMain: true },
          { path: worktree.path, branch: "poseidon/listed", isMain: false },
        ]);
        expect(list[1]?.head).toBe(git(root, "rev-parse", "main").trim());
      }),
    ),
  );
});

describe("git.worktree.remove", () => {
  it.live("removes a clean worktree and keeps its branch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject } = yield* stack;
        const projectId = yield* addProject(root);
        const worktree = yield* service.createWorktree(projectId, { name: "done" });
        writeFileSync(nodePath.join(worktree.path, "b.txt"), "committed\n");
        git(worktree.path, "add", "-A");
        git(worktree.path, "commit", "-qm", "work");

        yield* service.removeWorktree(projectId, { path: worktree.path, force: false });
        expect(existsSync(worktree.path)).toBe(false);
        expect(git(root, "log", "-1", "--format=%s", "poseidon/done").trim()).toBe("work");
        expect((yield* service.listWorktrees(projectId)).map((entry) => entry.path)).toEqual([
          root,
        ]);
      }),
    ),
  );

  it.live("refuses a worktree with uncommitted work unless forced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject } = yield* stack;
        const projectId = yield* addProject(root);
        const worktree = yield* service.createWorktree(projectId, { name: "dirty" });
        writeFileSync(nodePath.join(worktree.path, "untracked.txt"), "not committed\n");

        const refused = yield* errorOf(
          service.removeWorktree(projectId, { path: worktree.path, force: false }),
        );
        expect(refused.code).toBe("conflict");
        expect(refused.message).toContain("would lose");
        expect(existsSync(worktree.path)).toBe(true);

        yield* service.removeWorktree(projectId, { path: worktree.path, force: true });
        expect(existsSync(worktree.path)).toBe(false);
        expect(git(root, "branch", "--list", "poseidon/dirty").trim()).toBe("poseidon/dirty");
      }),
    ),
  );

  it.live("refuses the project's own checkout, an unknown path and a relative one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject } = yield* stack;
        const projectId = yield* addProject(root);

        for (const path of [root, tempDir("poseidon-not-a-worktree-"), "relative/path"]) {
          const error = yield* errorOf(service.removeWorktree(projectId, { path, force: true }));
          expect(error.code).toBe("invalid");
        }
        expect(existsSync(root)).toBe(true);
      }),
    ),
  );

  it.live("refuses a project folder that is itself a linked worktree, and the main checkout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const main = makeRepo();
        const linked = nodePath.join(tempDir("poseidon-linked-parent-"), "linked");
        git(main, "worktree", "add", "-q", "-b", "linked", linked);
        writeFileSync(nodePath.join(linked, "untracked.txt"), "mine\n");
        const { git: service, addProject, settings } = yield* stack;
        const projectId = yield* addProject(linked);
        yield* settings.update({ projectSettings: { [projectId]: { setupScript: "touch ran" } } });

        // git lists the main checkout first; the project's own folder is then
        // an ordinary entry, and still not one Poseidon may remove or set up.
        for (const path of [linked, main]) {
          const error = yield* errorOf(service.removeWorktree(projectId, { path, force: true }));
          expect(error.code).toBe("invalid");
          const setup = yield* errorOf(frames(service.setupWorktree(projectId, path)));
          expect(setup).toMatchObject({ code: "invalid" });
        }
        expect(existsSync(nodePath.join(linked, "untracked.txt"))).toBe(true);
        expect(existsSync(nodePath.join(linked, "ran"))).toBe(false);
        expect(existsSync(nodePath.join(main, "ran"))).toBe(false);
      }),
    ),
  );

  it.live("refuses a worktree another project was added from", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject } = yield* stack;
        const projectId = yield* addProject(root);
        const worktree = yield* service.createWorktree(projectId, { name: "adopted" });
        yield* addProject(worktree.path, "Adopted");

        const error = yield* errorOf(
          service.removeWorktree(projectId, { path: worktree.path, force: true }),
        );
        expect(error.code).toBe("conflict");
        expect(error.message).toContain('"Adopted"');
        expect(existsSync(worktree.path)).toBe(true);
      }),
    ),
  );

  it.live("refuses while a thread still works in it, and not once that thread is deleted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject, addThread } = yield* stack;
        const projectId = yield* addProject(root);
        const worktree = yield* service.createWorktree(projectId, { name: "busy" });
        yield* addThread(projectId, worktree);

        const error = yield* errorOf(
          service.removeWorktree(projectId, { path: worktree.path, force: true }),
        );
        expect(error.code).toBe("conflict");
        expect(existsSync(worktree.path)).toBe(true);

        const later = yield* service.createWorktree(projectId, { name: "later" });
        yield* addThread(projectId, later, true);
        yield* service.removeWorktree(projectId, { path: later.path, force: false });
        expect(existsSync(later.path)).toBe(false);
      }),
    ),
  );
});

describe("git.worktree.setup", () => {
  it.live("answers a single skipped frame when the project has no script", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject, settings } = yield* stack;
        const projectId = yield* addProject(root);
        const worktree = yield* service.createWorktree(projectId, { name: "no script" });

        expect(yield* frames(service.setupWorktree(projectId, worktree.path))).toEqual([
          { kind: "skipped" },
        ]);
        yield* settings.update({ projectSettings: { [projectId]: { setupScript: "  \n" } } });
        expect(yield* frames(service.setupWorktree(projectId, worktree.path))).toEqual([
          { kind: "skipped" },
        ]);
      }),
    ),
  );

  it.live("streams stdout and stderr, then the exit code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject, settings } = yield* stack;
        const projectId = yield* addProject(root);
        const worktree = yield* service.createWorktree(projectId, { name: "echo" });
        yield* settings.update({
          projectSettings: { [projectId]: { setupScript: "echo hi; echo err 1>&2; exit 3" } },
        });

        const list = yield* frames(service.setupWorktree(projectId, worktree.path));
        expect(outputOf(list)).toContain("hi\n");
        expect(outputOf(list)).toContain("err\n");
        expect(list.at(-1)).toEqual({ kind: "exit", exitCode: 3 });
        expect(list.filter((frame) => frame.kind === "exit")).toHaveLength(1);
      }),
    ),
  );

  it.live("runs in the worktree and tells the script where the project is", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject, settings } = yield* stack;
        const projectId = yield* addProject(root);
        const worktree = yield* service.createWorktree(projectId, { name: "where" });
        yield* settings.update({
          projectSettings: {
            [projectId]: {
              setupScript:
                'pwd > where.txt; printf "%s|%s" "$POSEIDON_WORKTREE_PATH" "$POSEIDON_PROJECT_ROOT"',
            },
          },
        });

        const list = yield* frames(service.setupWorktree(projectId, worktree.path));
        expect(readFileSync(nodePath.join(worktree.path, "where.txt"), "utf8").trim()).toBe(
          worktree.path,
        );
        expect(outputOf(list)).toBe(`${worktree.path}|${root}`);
        expect(list.at(-1)).toEqual({ kind: "exit", exitCode: 0 });
      }),
    ),
  );

  it.live("refuses a path that is not one of the project's worktrees", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject, settings } = yield* stack;
        const projectId = yield* addProject(root);
        yield* settings.update({ projectSettings: { [projectId]: { setupScript: "touch ran" } } });

        for (const path of [root, tempDir("poseidon-elsewhere-")]) {
          const error = yield* errorOf(frames(service.setupWorktree(projectId, path)));
          expect(error).toMatchObject({ code: "invalid" });
          expect(existsSync(nodePath.join(path, "ran"))).toBe(false);
        }
      }),
    ),
  );

  it.live("caps the output at 1 MiB with a notice and still reports the exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject, settings } = yield* stack;
        const projectId = yield* addProject(root);
        const worktree = yield* service.createWorktree(projectId, { name: "loud" });
        yield* settings.update({
          projectSettings: {
            [projectId]: { setupScript: "head -c 3000000 /dev/zero | tr '\\0' a" },
          },
        });

        const list = yield* frames(service.setupWorktree(projectId, worktree.path));
        const [body, notice] = outputOf(list).split("\n[Poseidon:");
        expect(body).toBe("a".repeat(SETUP_OUTPUT_LIMIT_BYTES));
        expect(notice).toContain("1 MiB");
        expect(list.at(-1)).toEqual({ kind: "exit", exitCode: 0 });
      }),
    ),
  );

  it.live("kills the script and everything it started when the stream is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject, settings } = yield* stack;
        const projectId = yield* addProject(root);
        const worktree = yield* service.createWorktree(projectId, { name: "slow" });
        const pidFile = nodePath.join(tempDir("poseidon-setup-pid-"), "sleep.pid");
        yield* settings.update({
          projectSettings: {
            [projectId]: { setupScript: `sleep 30 & echo $! > '${pidFile}'; echo started; wait` },
          },
        });

        // Read until the script says it started, then stop reading: that
        // ends the stream early, the way a client going away does.
        const list = yield* frames(
          service
            .setupWorktree(projectId, worktree.path)
            .pipe(
              Stream.takeUntil(
                (frame) => frame.kind === "output" && frame.text.includes("started"),
              ),
            ),
        );
        expect(list.some((frame) => frame.kind === "exit")).toBe(false);

        const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
        expect(pid).toBeGreaterThan(0);
        expect(() => process.kill(pid, 0)).toThrow();
      }),
    ),
  );

  it.live("a removal right after an interrupted setup waits for the script to stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { git: service, addProject, settings } = yield* stack;
        const projectId = yield* addProject(root);
        const worktree = yield* service.createWorktree(projectId, { name: "unwinding" });
        const pidFile = nodePath.join(tempDir("poseidon-setup-pid-"), "sh.pid");
        // Like a package manager: SIGTERM is trapped and unwinding takes a while.
        yield* settings.update({
          projectSettings: {
            [projectId]: {
              setupScript: `echo $$ > '${pidFile}'; trap 'sleep 0.5; exit 0' TERM; echo started; while :; do sleep 0.05; done`,
            },
          },
        });

        const started = yield* Deferred.make<void>();
        const setup = yield* Effect.forkChild(
          Stream.runForEach(service.setupWorktree(projectId, worktree.path), (frame) =>
            frame.kind === "output" && frame.text.includes("started")
              ? Deferred.succeed(started, undefined)
              : Effect.void,
          ),
        );
        yield* Deferred.await(started);
        const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
        // The client interrupts and removes at once, without waiting for the
        // server's stop to finish.
        yield* Effect.forkChild(Fiber.interrupt(setup));
        yield* service.removeWorktree(projectId, { path: worktree.path, force: true });

        expect(() => process.kill(pid, 0)).toThrow();
        expect(existsSync(worktree.path)).toBe(false);
      }),
    ),
  );
});
