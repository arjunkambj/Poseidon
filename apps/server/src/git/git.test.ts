/**
 * Two checkpointed turns diff correctly against each other, a
 * restore reverts the worktree, `files.search` answers warm, and `files.read`
 * caps large files. Repositories are real `git init` directories in tmp.
 */
import { describe, expect, it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { makeProjectId, makeThreadId, makeTurnId } from "@poseidon/contracts/ids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runMigrations } from "../persistence/Migrations";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { ReadModelStore } from "../persistence/ReadModels";
import { FileService, GitService, SettingsStore } from "../rpc/services";
import { layer as fileLayer } from "./Files";
import { layer as gitLayer } from "./Git";
import { GhRunner } from "./GitHubCli";
import { WorktreesRoot } from "./Worktrees";
import { make as checkpointStore } from "./CheckpointStore";
import { GitError, run } from "./process";

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

/** A fresh repo with one committed file. */
const makeRepo = () => {
  const root = mkdtempSync(nodePath.join(tmpdir(), "poseidon-git-test-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@poseidon.local");
  git(root, "config", "user.name", "Poseidon Test");
  writeFileSync(nodePath.join(root, "a.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
};

/** Real sqlite + read models + both services, with a project row for `root`. */
const stack = (root: string) =>
  Effect.gen(function* () {
    const sqliteContext = yield* Layer.build(sqliteTestLayer());
    const sqlite = Layer.succeedContext(sqliteContext);
    yield* runMigrations.pipe(Effect.provide(sqlite));
    const rmContext = yield* Layer.build(ReadModelStore.layer.pipe(Layer.provide(sqlite)));
    const readModels = Context.get(rmContext, ReadModelStore);
    const projectId = makeProjectId();
    const now = new Date().toISOString();
    yield* readModels.putProject({
      projectId,
      name: "test",
      workspaceRoot: root,
      createdAt: now,
      updatedAt: now,
      removed: false,
    });
    const servicesContext = yield* Layer.build(
      Layer.mergeAll(gitLayer, fileLayer).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeedContext(rmContext),
            GhRunner.layer,
            SettingsStore.layer.pipe(Layer.provide(sqlite)),
            // No test here cuts a worktree, so nothing is created under it.
            Layer.succeed(WorktreesRoot, {
              path: nodePath.join(tmpdir(), "poseidon-no-worktrees"),
            }),
          ),
        ),
      ),
    );
    return {
      projectId,
      git: Context.get(servicesContext, GitService),
      files: Context.get(servicesContext, FileService),
    };
  });

describe("w8 git", () => {
  it.live("run fails with GitError when git cannot be spawned", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        // An empty PATH makes the git binary itself unresolvable — the spawn
        // error carries the string code "ENOENT", which must fail the effect
        // rather than report exit 0 with empty output.
        const error = yield* run(root, ["status"], { env: { PATH: "/nonexistent" } }).pipe(
          Effect.flip,
        );
        expect(error).toBeInstanceOf(GitError);
        expect(error.exitCode).toBeNull();

        // A truncated result is a process failure too, not a silent success.
        const overflow = yield* run(root, ["--version"], { maxOutputBytes: 1 }).pipe(Effect.flip);
        expect(overflow).toBeInstanceOf(GitError);
      }),
    ),
  );

  it.live("two checkpoints diff correctly and restore reverts the worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const threadId = makeThreadId();

        // Turn 1: modify a.txt and add b.txt.
        writeFileSync(nodePath.join(root, "a.txt"), "one\ntwo\n");
        writeFileSync(nodePath.join(root, "b.txt"), "beta\n");
        const cp1 = yield* checkpointStore.capture({
          threadId,
          turnId: makeTurnId(),
          workspaceRoot: root,
        });

        // Turn 2: change a.txt again, delete b.txt, add c.txt.
        writeFileSync(nodePath.join(root, "a.txt"), "one\ntwo\nthree\n");
        writeFileSync(nodePath.join(root, "c.txt"), "gamma\n");
        // b.txt is untracked — checkpoints are hidden refs, not commits.
        unlinkSync(nodePath.join(root, "b.txt"));
        const cp2 = yield* checkpointStore.capture({
          threadId,
          turnId: makeTurnId(),
          workspaceRoot: root,
        });

        // list sees both, oldest first — and reports the same checkpointIds
        // capture minted, so a restore driven by a list() response validates.
        const listed = yield* checkpointStore.list({ threadId, workspaceRoot: root });
        expect(listed.map((c) => c.ref)).toEqual([cp1.ref, cp2.ref]);
        expect(listed.map((c) => c.checkpointId)).toEqual([cp1.checkpointId, cp2.checkpointId]);

        // The ids are stable across calls — they derive from the commit.
        const relisted = yield* checkpointStore.list({ threadId, workspaceRoot: root });
        expect(relisted.map((c) => c.checkpointId)).toEqual([cp1.checkpointId, cp2.checkpointId]);

        // The diff between checkpoints is exactly turn 2's changes.
        const { projectId, git: gitService } = yield* stack(root);
        const diff = yield* gitService.diff({ projectId }, { from: cp1.ref, to: cp2.ref });
        const byPath = new Map(diff.files.map((f) => [f.path, f]));
        expect(byPath.get("a.txt")?.additions).toBe(1);
        expect(byPath.get("b.txt")?.kind).toBe("delete");
        expect(byPath.get("c.txt")?.kind).toBe("create");

        // Restore to cp1 → worktree matches turn 1 exactly.
        yield* checkpointStore.restore({ workspaceRoot: root, checkpoint: cp1 });
        expect(readFileSync(nodePath.join(root, "a.txt"), "utf8")).toBe("one\ntwo\n");
        expect(readFileSync(nodePath.join(root, "b.txt"), "utf8")).toBe("beta\n");
        // c.txt was never in cp1 — clean removes it.
        expect(() => readFileSync(nodePath.join(root, "c.txt"))).toThrow();

        // The user's real index/HEAD are untouched — still one commit.
        expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("1");
        expect(git(root, "status", "--porcelain").trim()).not.toBe("");
      }),
    ),
  );

  it.live("checkpoints.list reports only the refs that still exist", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const threadId = makeThreadId();
        const kept = yield* checkpointStore.capture({
          threadId,
          turnId: makeTurnId(),
          workspaceRoot: root,
        });
        writeFileSync(nodePath.join(root, "a.txt"), "one\ntwo\n");
        const removed = yield* checkpointStore.capture({
          threadId,
          turnId: makeTurnId(),
          workspaceRoot: root,
        });

        const { projectId, git: gitService } = yield* stack(root);
        expect((yield* gitService.checkpoints(projectId, threadId)).map((c) => c.ref)).toEqual([
          kept.ref,
          removed.ref,
        ]);

        // Pruned outside the app — the thread's own projection still folds
        // both, so this is the list a pane intersects it with.
        git(root, "update-ref", "-d", removed.ref);
        const live = yield* gitService.checkpoints(projectId, threadId);
        expect(live.map((c) => c.ref)).toEqual([kept.ref]);
        expect(live[0]?.checkpointId).toBe(kept.checkpointId);

        // A workspace with no repository simply has none.
        const plain = mkdtempSync(nodePath.join(tmpdir(), "poseidon-plain-"));
        const { projectId: plainProject, git: plainGit } = yield* stack(plain);
        expect(yield* plainGit.checkpoints(plainProject, threadId)).toEqual([]);
      }),
    ),
  );

  it.live("restore leaves staged work outside the workspace root alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A project whose root is a subdirectory of the repository: the
        // restore is scoped to that subdirectory, so everything the user has
        // staged elsewhere in the repository must survive it.
        const repo = makeRepo();
        const workspaceRoot = nodePath.join(repo, "project");
        mkdirSync(workspaceRoot);
        writeFileSync(nodePath.join(workspaceRoot, "inside.txt"), "v1\n");
        git(repo, "add", "-A");
        git(repo, "commit", "-qm", "add the project subdirectory");

        const cp = yield* checkpointStore.capture({
          threadId: makeThreadId(),
          turnId: makeTurnId(),
          workspaceRoot,
        });
        writeFileSync(nodePath.join(workspaceRoot, "inside.txt"), "v2\n");
        // Staged, outside the restored subdirectory.
        writeFileSync(nodePath.join(repo, "a.txt"), "staged elsewhere\n");
        git(repo, "add", "a.txt");

        yield* checkpointStore.restore({ workspaceRoot, checkpoint: cp });

        expect(readFileSync(nodePath.join(workspaceRoot, "inside.txt"), "utf8")).toBe("v1\n");
        // `M ` — still staged. A whole-index reset would have made it ` M`.
        const rows = git(repo, "status", "--porcelain").trim().split("\n");
        expect(rows).toContain("M  a.txt");
      }),
    ),
  );

  it.live("restore fails when git clean cannot remove a path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const threadId = makeThreadId();
        const cp = yield* checkpointStore.capture({
          threadId,
          turnId: makeTurnId(),
          workspaceRoot: root,
        });

        // chmod 000 cannot block a root-owned clean — the scenario needs a
        // permission boundary to exist at all.
        if (typeof process.getuid === "function" && process.getuid() === 0) {
          return;
        }
        // An untracked directory the server user cannot traverse makes
        // `git clean -fd` exit non-zero — the restore must report failure
        // rather than leave the file behind and claim success.
        const locked = nodePath.join(root, "locked");
        mkdirSync(locked);
        writeFileSync(nodePath.join(locked, "stuck.txt"), "stuck\n");
        chmodSync(locked, 0o000);
        try {
          const error = yield* checkpointStore
            .restore({ workspaceRoot: root, checkpoint: cp })
            .pipe(Effect.flip);
          expect(error.message.length).toBeGreaterThan(0);
        } finally {
          chmodSync(locked, 0o755);
        }
      }),
    ),
  );

  it.live("status reports branch and pending changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { projectId, git: gitService } = yield* stack(root);
        writeFileSync(nodePath.join(root, "new.txt"), "untracked\n");
        writeFileSync(nodePath.join(root, "a.txt"), "changed\n");
        const status = yield* gitService.status({ projectId });
        expect(status.branch).not.toBeNull();
        const paths = new Map(status.files.map((f) => [f.path, f.status]));
        expect(paths.get("new.txt")).toBe("untracked");
        expect(paths.get("a.txt")).toBe("modified");
      }),
    ),
  );

  it.live("diff rejects refs that would land in flag position", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { projectId, git: gitService } = yield* stack(root);
        const marker = nodePath.join(root, "injected.patch");

        // `--output=<path>` as `from` would make git write the diff to disk.
        const from = yield* gitService
          .diff({ projectId }, { from: `--output=${marker}` })
          .pipe(Effect.exit);
        expect(from._tag).toBe("Failure");
        const to = yield* gitService
          .diff({ projectId }, { from: "HEAD", to: "--no-ext-diff" })
          .pipe(Effect.exit);
        expect(to._tag).toBe("Failure");
        // Nothing was executed — no file materialized.
        expect(() => readFileSync(marker)).toThrow();
      }),
    ),
  );

  it.live("status parses paths with spaces and staged renames", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { projectId, git: gitService } = yield* stack(root);

        writeFileSync(nodePath.join(root, "has space.txt"), "v1\n");
        git(root, "add", "-A");
        git(root, "commit", "-qm", "add spaced file");
        // Unstaged `1 ` row whose path contains a space.
        writeFileSync(nodePath.join(root, "has space.txt"), "v2\n");
        // Staged `2 ` rename row: path and origPath both carry spaces, and
        // the origPath travels as a second NUL record.
        git(root, "mv", "has space.txt", "renamed file.txt");
        writeFileSync(nodePath.join(root, "untracked space.txt"), "new\n");

        const status = yield* gitService.status({ projectId });
        const byPath = new Map(status.files.map((f) => [f.path, f]));
        const renamed = byPath.get("renamed file.txt");
        expect(renamed?.status).toBe("renamed");
        expect(renamed?.oldPath).toBe("has space.txt");
        expect(renamed?.staged).toBe(true);
        expect(byPath.get("untracked space.txt")?.status).toBe("untracked");
        // The origPath record must not surface as its own file entry.
        expect(byPath.has("has space.txt")).toBe(false);
        expect(status.files.every((f) => !f.path.includes("R100"))).toBe(true);
      }),
    ),
  );

  it.live("worktree diff includes untracked files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { projectId, git: gitService } = yield* stack(root);
        writeFileSync(nodePath.join(root, "fresh.txt"), "brand new\n");
        const diff = yield* gitService.diff({ projectId }, {});
        const fresh = diff.files.find((f) => f.path === "fresh.txt");
        expect(fresh?.kind).toBe("create");
        expect(fresh?.diff).toContain("brand new");
      }),
    ),
  );

  it.live("a renamed file carries its real addition and deletion counts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { projectId, git: gitService } = yield* stack(root);
        git(root, "mv", "a.txt", "b.txt");
        writeFileSync(nodePath.join(root, "b.txt"), "one\ntwo\n");
        git(root, "add", "-A");
        git(root, "commit", "-qm", "rename and edit");

        // `--numstat` writes a rename as the single field `old => new`, which
        // matches no path the patch split produces — the counts used to come
        // back as +0/-0 while the patch plainly had a hunk.
        const before = git(root, "rev-parse", "HEAD^").trim();
        const between = yield* gitService.diff({ projectId }, { from: before, to: "HEAD" });
        const renamed = between.files.find((f) => f.path === "b.txt");
        expect(renamed?.oldPath).toBe("a.txt");
        expect(renamed?.additions).toBe(1);
        expect(renamed?.deletions).toBe(0);
      }),
    ),
  );

  it.live("worktree diff includes files the user has staged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { projectId, git: gitService } = yield* stack(root);
        // Staged, never committed: absent from HEAD and from the throwaway
        // index the diff builds, so it has to arrive as an intent-to-add.
        writeFileSync(nodePath.join(root, "staged.txt"), "staged\n");
        git(root, "add", "staged.txt");
        // A staged rename is the same problem wearing a different hat.
        git(root, "mv", "a.txt", "b.txt");
        writeFileSync(nodePath.join(root, "b.txt"), "one\ntwo\n");

        const diff = yield* gitService.diff({ projectId }, {});
        const byPath = new Map(diff.files.map((f) => [f.path, f]));
        expect(byPath.get("staged.txt")?.kind).toBe("create");
        expect(byPath.get("staged.txt")?.diff).toContain("staged");
        const renamed = byPath.get("b.txt");
        expect(renamed?.oldPath).toBe("a.txt");
        expect(renamed?.additions).toBe(1);
        expect(byPath.has("a.txt")).toBe(false);
      }),
    ),
  );

  it.live("a diff says where a subfolder project sits in its repository", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repo = makeRepo();
        const root = nodePath.join(repo, "packages", "app");
        mkdirSync(root, { recursive: true });
        writeFileSync(nodePath.join(root, "fresh.txt"), "brand new\n");
        const { projectId, git: gitService } = yield* stack(root);
        const diff = yield* gitService.diff({ projectId }, {});
        expect(diff.prefix).toBe("packages/app/");
        expect(diff.files.map((f) => f.path)).toContain("packages/app/fresh.txt");

        const top = yield* stack(repo);
        expect((yield* top.git.diff({ projectId: top.projectId }, {})).prefix).toBe("");
      }),
    ),
  );

  it.live("worktree diff removes its temporary index directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { projectId, git: gitService } = yield* stack(root);
        writeFileSync(nodePath.join(root, "fresh.txt"), "brand new\n");
        const tempIndexes = () =>
          readdirSync(tmpdir()).filter((name) => name.startsWith("poseidon-index-"));
        const before = new Set(tempIndexes());
        yield* gitService.diff({ projectId }, {});
        const leaked = tempIndexes().filter((name) => !before.has(name));
        expect(leaked).toEqual([]);
      }),
    ),
  );

  it.live("files.search honors gitignore and reads cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        writeFileSync(nodePath.join(root, ".gitignore"), "ignored/\n");
        mkdirSync(nodePath.join(root, "ignored"));
        mkdirSync(nodePath.join(root, "src"));
        writeFileSync(nodePath.join(root, "ignored", "hidden.txt"), "secret\n");
        writeFileSync(nodePath.join(root, "src", "keep-me.ts"), "export const a = 1\n");
        git(root, "add", "-A");
        git(root, "commit", "-qm", "add files");

        const { projectId, files } = yield* stack(root);
        const hits = yield* files.search({ projectId }, "keep");
        expect(hits.map((h) => h.path)).toContain("src/keep-me.ts");
        const ignored = yield* files.search({ projectId }, "hidden");
        expect(ignored).toEqual([]);

        const content = yield* files.read({ projectId }, "src/keep-me.ts");
        expect(content.text).toContain("export const a = 1");
        const outside = yield* files.read({ projectId }, "../outside").pipe(Effect.exit);
        expect(outside._tag).toBe("Failure");
      }),
    ),
  );

  it.live("files.search answers with directories as well as files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        mkdirSync(nodePath.join(root, "widgets"), { recursive: true });
        mkdirSync(nodePath.join(root, "widgets", "nested"), { recursive: true });
        writeFileSync(nodePath.join(root, "widgets", "nested", "widgets.ts"), "export {}\n");
        git(root, "add", "-A");
        git(root, "commit", "-qm", "add widgets");

        const { projectId, files } = yield* stack(root);
        const hits = yield* files.search({ projectId }, "widgets");
        const byPath = new Map(hits.map((h) => [h.path, h.isDirectory]));
        expect(byPath.get("widgets")).toBe(true);
        expect(byPath.get("widgets/nested/widgets.ts")).toBe(false);
        // A file outranks the directory that merely contains it.
        expect(hits[0]?.path).toBe("widgets/nested/widgets.ts");
      }),
    ),
  );

  it.live("a workspace that is not a repository is named, not guessed at", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plain = mkdtempSync(nodePath.join(tmpdir(), "poseidon-plain-"));
        const { projectId, git: gitService } = yield* stack(plain);

        // Empty results, but the pane can tell this apart from a clean repo.
        const status = yield* gitService.status({ projectId });
        expect(status.isRepository).toBe(false);
        expect(status.files).toEqual([]);
        const diff = yield* gitService.diff({ projectId }, {});
        expect(diff.isRepository).toBe(false);

        // Checkpoints report it as a field rather than as git's wording.
        const threadId = makeThreadId();
        const captureError = yield* checkpointStore
          .capture({ threadId, turnId: makeTurnId(), workspaceRoot: plain })
          .pipe(Effect.flip);
        expect(captureError.notARepository).toBe(true);
        const listError = yield* checkpointStore
          .list({ threadId, workspaceRoot: plain })
          .pipe(Effect.flip);
        expect(listError.notARepository).toBe(true);
        // Nothing to prune is not a failure.
        yield* checkpointStore.prune({ threadId, workspaceRoot: plain });

        // A real repository says so too.
        const { projectId: repoProject, git: repoGit } = yield* stack(makeRepo());
        expect((yield* repoGit.status({ projectId: repoProject })).isRepository).toBe(true);
        expect((yield* repoGit.diff({ projectId: repoProject }, {})).isRepository).toBe(true);
      }),
    ),
  );

  it.live("files.search and files.read work in a workspace that is not a repository", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A plain folder, never `git init`ed — opening one as a project must
        // not turn every `#` keystroke in the composer into an RPC error.
        const root = mkdtempSync(nodePath.join(tmpdir(), "poseidon-plain-"));
        mkdirSync(nodePath.join(root, "src"));
        mkdirSync(nodePath.join(root, "node_modules"));
        mkdirSync(nodePath.join(root, "build"));
        writeFileSync(nodePath.join(root, ".gitignore"), "node_modules/\n/build\n*.log\n");
        writeFileSync(nodePath.join(root, "src", "keep-me.ts"), "export const a = 1\n");
        writeFileSync(nodePath.join(root, "node_modules", "keep-me.ts"), "vendored\n");
        writeFileSync(nodePath.join(root, "build", "keep-me.ts"), "built\n");
        writeFileSync(nodePath.join(root, "keep-me.log"), "logged\n");

        const { projectId, files } = yield* stack(root);
        const hits = yield* files.search({ projectId }, "keep-me");
        // The walk is ignore-aware: only the one real source file survives.
        expect(hits.map((h) => h.path)).toEqual(["src/keep-me.ts"]);

        const content = yield* files.read({ projectId }, "src/keep-me.ts");
        expect(content.text).toContain("export const a = 1");
      }),
    ),
  );

  it.live("a leading **/ in .gitignore matches at every depth, root included", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // `**/node_modules` is the idiom half of the ecosystem writes, and git
        // treats the leading `**/` as "the bare pattern, at any depth" — the
        // root copy has to be ignored just as the nested one is.
        const root = mkdtempSync(nodePath.join(tmpdir(), "poseidon-plain-"));
        mkdirSync(nodePath.join(root, "node_modules"));
        mkdirSync(nodePath.join(root, "src"));
        mkdirSync(nodePath.join(root, "src", "node_modules"));
        writeFileSync(nodePath.join(root, ".gitignore"), "**/node_modules\n**/*.tmp\n");
        writeFileSync(nodePath.join(root, "node_modules", "keep-me.ts"), "vendored\n");
        writeFileSync(nodePath.join(root, "src", "node_modules", "keep-me.ts"), "vendored\n");
        writeFileSync(nodePath.join(root, "keep-me.tmp"), "scratch\n");
        writeFileSync(nodePath.join(root, "src", "keep-me.ts"), "export const a = 1\n");

        const { projectId, files } = yield* stack(root);
        const hits = yield* files.search({ projectId }, "keep-me");
        expect(hits.map((h) => h.path)).toEqual(["src/keep-me.ts"]);
      }),
    ),
  );

  it.live("the fallback walk lists symlinks without following them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // `git ls-files` lists a symlink (mode 120000), so the fallback must
        // not silently drop one — linked config files and pnpm-style layouts
        // would go missing from the `#` menu.
        const root = mkdtempSync(nodePath.join(tmpdir(), "poseidon-plain-"));
        mkdirSync(nodePath.join(root, "src"));
        writeFileSync(nodePath.join(root, "src", "keep-me-real.ts"), "export const a = 1\n");
        symlinkSync("keep-me-real.ts", nodePath.join(root, "src", "keep-me-link.ts"));
        // A link to a directory is listed, but never descended into.
        const outside = mkdtempSync(nodePath.join(tmpdir(), "poseidon-outside-"));
        writeFileSync(nodePath.join(outside, "keep-me-hidden.ts"), "unreachable\n");
        symlinkSync(outside, nodePath.join(root, "keep-me-elsewhere"));

        const { projectId, files } = yield* stack(root);
        const hits = yield* files.search({ projectId }, "keep-me");
        expect(hits.map((h) => h.path).sort()).toEqual([
          "keep-me-elsewhere",
          "src/keep-me-link.ts",
          "src/keep-me-real.ts",
        ]);
        // The walk stopped at the link: nothing behind it was enumerated.
        expect(hits.some((h) => h.path.includes("keep-me-hidden"))).toBe(false);
      }),
    ),
  );

  it.live("files.read refuses a symlink that escapes the workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const outside = mkdtempSync(nodePath.join(tmpdir(), "poseidon-outside-"));
        writeFileSync(nodePath.join(outside, "secret.txt"), "do not serve\n");
        // A symlink inside the repo whose target lives outside it — the
        // lexical prefix check passes, the canonical one must not.
        symlinkSync(outside, nodePath.join(root, "linked"));

        const { projectId, files } = yield* stack(root);
        const viaDir = yield* files.read({ projectId }, "linked/secret.txt").pipe(Effect.exit);
        expect(viaDir._tag).toBe("Failure");
        const viaDirItself = yield* files.read({ projectId }, "linked").pipe(Effect.exit);
        expect(viaDirItself._tag).toBe("Failure");

        // A symlink to an in-repo file still resolves — canonical containment
        // is the check, not the mere presence of a link.
        writeFileSync(nodePath.join(root, "real.txt"), "real\n");
        symlinkSync("real.txt", nodePath.join(root, "alias.txt"));
        const aliased = yield* files.read({ projectId }, "alias.txt");
        expect(aliased.text).toContain("real");
      }),
    ),
  );

  it.live("files.read pages into a file far past the text cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        // 40,000 lines of ~30 bytes — about 1.2MB, so line 20,000 is well
        // beyond anything a single 512KB window could reach.
        const lines = Array.from({ length: 40_000 }, (_, i) => `line ${i} ${"-".repeat(20)}`);
        writeFileSync(nodePath.join(root, "long.txt"), `${lines.join("\n")}\n`);
        const { projectId, files } = yield* stack(root);

        const page = yield* files.read({ projectId }, "long.txt", 20_000, 3);
        expect(page.text.split("\n")).toEqual([lines[20_000], lines[20_001], lines[20_002]]);
        // The trailing newline makes the last line an empty one, as
        // String.split("\n") would report it.
        expect(page.totalLines).toBe(40_001);
        expect(page.truncated).toBe(true);

        // The final page reaches the end of the file rather than a window.
        const tail = yield* files.read({ projectId }, "long.txt", 39_999, 2);
        expect(tail.text).toBe(`${lines[39_999]}\n`);
        expect(tail.truncated).toBe(false);
      }),
    ),
  );

  it.live("files.read bounds a large file at the read cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        // ~600KB — comfortably over the 512KB cap.
        writeFileSync(nodePath.join(root, "big.txt"), "x".repeat(600 * 1024));
        const { projectId, files } = yield* stack(root);
        const content = yield* files.read({ projectId }, "big.txt");
        expect(content.truncated).toBe(true);
        expect(content.text.length).toBeLessThanOrEqual(512 * 1024);
      }),
    ),
  );

  it.live("search stays warm under the cache TTL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        // ~600 files — enough to make the warm/cold difference meaningful.
        for (let i = 0; i < 600; i++) {
          writeFileSync(nodePath.join(root, `f${i}.txt`), "x\n");
        }
        const { projectId, files } = yield* stack(root);
        yield* files.search({ projectId }, "f1"); // populate the cache
        const start = Date.now();
        yield* files.search({ projectId }, "f5");
        expect(Date.now() - start).toBeLessThan(200);
      }),
    ),
  );
});
