/**
 * The real `GitService` behind the `git.status`/`git.diff`/`checkpoints.list`,
 * discard, branch, commit, push, pull-request and worktree RPCs:
 * argv-form git over `process.ts`, porcelain-v2 parsing for status, and
 * unified patches split per file for the changes pane. Branch listing,
 * creation and switching live in `Branches.ts`, commit and push in
 * `Commits.ts`, discard in `Review.ts`, pull requests in
 * `GitHubCli.ts`, worktrees in `Worktrees.ts` and the setup script in
 * `SetupScript.ts`; this layer resolves the root, reads the settings those
 * need, and adds the guards that need the read models — no switch or commit
 * while a turn runs in the same root, no removing a worktree a thread still
 * works in. Each call runs in the thread's own root when it names a thread (see
 * `orchestration/workspaceRoot.ts`). A missing `projectId` or a non-repository
 * root answers `isRepository: false` with empty results rather than an RPC
 * error, so the pane can say "not a git repository" instead of showing what
 * looks like a clean tree.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import type { ProjectId } from "@poseidon/contracts/ids";
import type { GitDiff, GitDiffFile, GitFileChange, GitStatus } from "@poseidon/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { PoseidonRpcError } from "@poseidon/contracts/rpc";

import { worktreeOf } from "../orchestration/state";
import {
  projectRootedAt,
  resolveWorkspaceRoot,
  workspaceRootBusy,
  worktreeInUse,
} from "../orchestration/workspaceRoot";
import { ReadModelStore } from "../persistence/ReadModels";
import { GitService, SettingsStore, type WorkspaceScope } from "../rpc/services";
import {
  checkoutBranch,
  createBranch,
  listBranches,
  mergeBaseOf,
  notRepositoryBranches,
  validRef,
} from "./Branches";
import { make as checkpointStore } from "./CheckpointStore";
import { commit, push } from "./Commits";
import { createPullRequest, GhRunner, pullRequestBlocker } from "./GitHubCli";
import { GitError, isRepository, run } from "./process";
import { discard, discardBase, repositoryTop } from "./Review";
import { runSetupScript, setupsStopped } from "./SetupScript";
import {
  createWorktree,
  listWorktrees,
  registeredWorktree,
  removeWorktree,
  WorktreesRoot,
} from "./Worktrees";

const toRpcError = (error: GitError) =>
  new PoseidonRpcError({ code: "internal", message: error.message });

/** Passes a classified refusal through and turns an unexpected git failure into `internal`. */
const asRpcError = (error: GitError | PoseidonRpcError) =>
  error instanceof PoseidonRpcError ? error : toRpcError(error);

const NUL = "\0";

/** Porcelain v2 XY → the contract's status word. `?` rows are untracked. */
const statusOf = (xy: string): GitFileChange["status"] => {
  if (xy === "??") return "untracked";
  if (xy.includes("R") || xy.includes("C")) return "renamed";
  if (xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  return "modified";
};

const parseStatus = (stdout: string): GitStatus => {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: Array<GitFileChange> = [];
  const lines = stdout.split(NUL).filter((line) => line.length > 0);
  // Index-based: `2 ` rename rows consume the following NUL record too.
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length) || null;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length) || null;
    } else if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      ahead = match === null ? 0 : Number.parseInt(match[1]!, 10);
      behind = match === null ? 0 : Number.parseInt(match[2]!, 10);
    } else if (line.startsWith("? ")) {
      files.push({ path: line.slice(2), status: "untracked", staged: false });
    } else if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      // Fixed-field counts before the path: `1 ` carries 8 (`<XY> <sub>
      // <mH> <mI> <mW> <hH> <hI>`), `2 ` adds the `<X><score>` token (9),
      // `u ` carries 10. The path itself may contain spaces, so it is the
      // remainder of the row re-joined, never a single part.
      const pathStart = line.startsWith("2 ") ? 9 : line.startsWith("u ") ? 10 : 8;
      const path = parts.slice(pathStart).join(" ");
      let oldPath: string | undefined;
      if (line.startsWith("2 ")) {
        // A rename/copy row is followed by a second NUL record carrying the
        // original path — consume it so it is not mistaken for an entry.
        oldPath = lines[index + 1];
        if (oldPath !== undefined) {
          index += 1;
        }
      }
      files.push({
        path,
        ...(oldPath === undefined ? {} : { oldPath }),
        status: statusOf(xy),
        staged: xy[0] !== "." && xy[0] !== "?",
      });
    }
  }
  return { branch, upstream, ahead, behind, files };
};

const KIND_BY_PATCH_MARKER: ReadonlyArray<[RegExp, GitDiffFile["kind"]]> = [
  [/^new file mode/m, "create"],
  [/^deleted file mode/m, "delete"],
  [/^rename from /m, "edit"],
];

const kindOf = (patch: string): GitDiffFile["kind"] =>
  KIND_BY_PATCH_MARKER.find(([marker]) => marker.test(patch))?.[1] ?? "edit";

/** Split a unified patch into per-file entries on `diff --git` boundaries. */
const splitPatch = (patch: string): Array<{ path: string; oldPath?: string; chunk: string }> => {
  const chunks: Array<{ path: string; oldPath?: string; chunk: string }> = [];
  let current: { path: string; oldPath?: string; chunk: string } | undefined;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (header !== null) {
      current = { path: header[2]!, oldPath: header[1], chunk: `${line}\n` };
      chunks.push(current);
      continue;
    }
    if (current !== undefined) {
      current.chunk += `${line}\n`;
    }
  }
  return chunks;
};

/**
 * `diff --numstat -z` records: `added\tdeleted\tpath` NUL for an ordinary
 * change, and `added\tdeleted\t` NUL `old` NUL `new` NUL for a rename or copy.
 * The NUL form is what makes the rename case usable — the plain output writes
 * it as the single field `old => new`, which matches no path the patch split
 * ever produces, so renamed files came back as +0/-0. Binary rows are `-\t-`.
 */
const parseNumstat = (stdout: string): Map<string, { added: number; deleted: number }> => {
  const map = new Map<string, { added: number; deleted: number }>();
  const records = stdout.split(NUL);
  for (let index = 0; index < records.length; index += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(records[index]!);
    if (match === null) continue;
    const counts = {
      added: match[1] === "-" ? 0 : Number.parseInt(match[1]!, 10),
      deleted: match[2] === "-" ? 0 : Number.parseInt(match[2]!, 10),
    };
    if (match[3]!.length > 0) {
      map.set(match[3]!, counts);
      continue;
    }
    // An empty path field means the next two records are `old` then `new`;
    // the patch split keys its entry on the new path.
    const newPath = records[index + 2];
    if (newPath !== undefined) map.set(newPath, counts);
    index += 2;
  }
  return map;
};

/**
 * Diff the worktree against `base` including untracked files: stage them with
 * `--intent-to-add` in a throwaway index so they appear as new-file diffs.
 * Ref→ref diffs skip this — every file is already tracked.
 */
const worktreeDiff = (cwd: string, base: string, path?: string, ignoreWhitespace = false) =>
  Effect.gen(function* () {
    const pathspec = path === undefined ? [] : ["--", path];
    const ws = ignoreWhitespace ? ["-w"] : [];
    const tempDir = mkdtempSync(nodePath.join(tmpdir(), "poseidon-index-"));
    const tempIndex = nodePath.join(tempDir, "index");
    const env = { GIT_INDEX_FILE: tempIndex };
    try {
      yield* run(cwd, ["read-tree", base], { env }).pipe(
        Effect.catch(() => Effect.void), // unborn HEAD: empty temp index is fine
      );
      // "Untracked" has to mean untracked *by the temporary index*, not by
      // the user's: a path the user has staged but not committed is absent
      // from the temp index too, so reading the real index here dropped every
      // staged-but-uncommitted file — and the new half of a staged rename —
      // out of the diff entirely.
      const untracked = yield* run(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], {
        env,
      });
      const paths = untracked.stdout.split("\0").filter(Boolean);
      if (paths.length > 0) {
        yield* run(
          cwd,
          [
            "--literal-pathspecs",
            "add",
            "--intent-to-add",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
          ],
          { env, stdin: `${paths.join("\0")}\0` },
        );
      }
      const patch = yield* run(
        cwd,
        [
          "diff",
          "--patch",
          "--no-color",
          "--no-ext-diff",
          "--find-renames",
          ...ws,
          base,
          ...pathspec,
        ],
        { env },
      );
      const numstat = yield* run(
        cwd,
        ["diff", "--numstat", "-z", "--find-renames", ...ws, base, ...pathspec],
        { env },
      );
      return { patch: patch.stdout, numstat: numstat.stdout };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

const refDiff = (
  cwd: string,
  from: string,
  to: string | undefined,
  path?: string,
  ignoreWhitespace = false,
) =>
  Effect.gen(function* () {
    const range = to === undefined ? [from] : [from, to];
    const pathspec = path === undefined ? [] : ["--", path];
    const ws = ignoreWhitespace ? ["-w"] : [];
    const patch = yield* run(cwd, [
      "diff",
      "--patch",
      "--no-color",
      "--no-ext-diff",
      "--find-renames",
      ...ws,
      ...range,
      ...pathspec,
    ]);
    const numstat = yield* run(cwd, [
      "diff",
      "--numstat",
      "-z",
      "--find-renames",
      ...ws,
      ...range,
      ...pathspec,
    ]);
    return { patch: patch.stdout, numstat: numstat.stdout };
  });

/**
 * Under `-w` some git versions still print a whitespace-only edit's header with
 * no hunk. Such a plain edit keeps its row but no patch, so the pane lists it
 * without offering to open raw headers; a mode change or binary edit keeps its.
 */
const headerOnly = (chunk: string) => !/^(@@|Binary files |old mode )/m.test(chunk);

const toDiffFiles = (
  patch: string,
  numstat: string,
  ignoreWhitespace = false,
): Array<GitDiffFile> => {
  const counts = parseNumstat(numstat);
  return splitPatch(patch).map(({ path, oldPath, chunk }) => {
    const count = counts.get(path) ?? { added: 0, deleted: 0 };
    const renamed = oldPath !== undefined && oldPath !== path;
    const kind = kindOf(chunk);
    const empty = ignoreWhitespace && kind === "edit" && !renamed && headerOnly(chunk);
    return {
      path,
      ...(renamed ? { oldPath } : {}),
      kind,
      diff: empty ? "" : chunk,
      additions: count.added,
      deletions: count.deleted,
    };
  });
};

const notRepo: GitDiff = { from: null, to: null, isRepository: false, files: [] };

export const layer = Layer.effect(
  GitService,
  Effect.gen(function* () {
    const readModels = yield* ReadModelStore;
    const gh = yield* GhRunner;
    const settings = yield* SettingsStore;
    const worktreesRoot = yield* WorktreesRoot;

    /** The thread's root when the scope names one, the project's otherwise. */
    const workspaceRoot = (scope: WorkspaceScope) =>
      resolveWorkspaceRoot(readModels, scope.projectId, scope.threadId).pipe(
        Effect.mapError(
          (error) =>
            new GitError({
              command: "project lookup",
              cwd: ".",
              exitCode: null,
              message: error.message,
            }),
        ),
      );

    /** A root a branch write can run in, or the reason it cannot. */
    const repositoryRoot = (scope: WorkspaceScope) =>
      Effect.gen(function* () {
        const root = yield* workspaceRoot(scope);
        if (root === null) {
          return yield* Effect.fail(
            new PoseidonRpcError({ code: "not-found", message: "unknown project" }),
          );
        }
        if (!(yield* isRepository(root))) {
          return yield* Effect.fail(
            new PoseidonRpcError({ code: "invalid", message: "not a git repository" }),
          );
        }
        return root;
      });

    /**
     * The project itself, when its root is a repository. Worktree RPCs always
     * run from the project's root: that is the repository every one of its
     * worktrees is registered with.
     */
    const projectRepository = (projectId: ProjectId) =>
      Effect.gen(function* () {
        const project = yield* readModels
          .getProjectDoc(projectId)
          .pipe(
            Effect.mapError(
              (error) => new PoseidonRpcError({ code: "internal", message: error.message }),
            ),
          );
        if (project === null || project.removed) {
          return yield* Effect.fail(
            new PoseidonRpcError({ code: "not-found", message: "unknown project" }),
          );
        }
        if (!(yield* isRepository(project.workspaceRoot))) {
          return yield* Effect.fail(
            new PoseidonRpcError({ code: "invalid", message: "not a git repository" }),
          );
        }
        return project;
      });

    /** No branch switch or commit under a running turn or a checkpoint restore in the same root. */
    const requireIdle = (root: string, action: string) =>
      Effect.gen(function* () {
        const busy = yield* workspaceRootBusy(readModels, root).pipe(
          Effect.mapError(
            (error) => new PoseidonRpcError({ code: "internal", message: error.message }),
          ),
        );
        if (busy) {
          return yield* Effect.fail(
            new PoseidonRpcError({
              code: "conflict",
              message: `A turn is running in this workspace — stop it before ${action}.`,
            }),
          );
        }
      });

    /** The branch the scope's thread was cut from, when it has a worktree that says. */
    const worktreeBase = (scope: WorkspaceScope) =>
      Effect.gen(function* () {
        if (scope.threadId === undefined) return null;
        const doc = yield* readModels.getThreadDoc(scope.threadId);
        if (doc === null || doc.deleted || doc.projectId !== scope.projectId) return null;
        return worktreeOf(doc)?.baseBranch ?? null;
      }).pipe(
        Effect.mapError(
          (error) => new PoseidonRpcError({ code: "internal", message: error.message }),
        ),
      );

    return GitService.of({
      status: (scope) =>
        Effect.gen(function* () {
          const root = yield* workspaceRoot(scope);
          if (root === null || !(yield* isRepository(root))) {
            // Named, not guessed: an empty `files` list with `isRepository`
            // false is what the pane renders as "not a git repository".
            return {
              branch: null,
              upstream: null,
              ahead: 0,
              behind: 0,
              isRepository: false,
              files: [],
            };
          }
          const result = yield* run(root, [
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=normal",
          ]);
          return { ...parseStatus(result.stdout), isRepository: true };
        }).pipe(Effect.mapError(toRpcError)),

      diff: (scope, options) =>
        Effect.gen(function* () {
          if (options.mergeBase !== undefined && options.to !== undefined) {
            return yield* Effect.fail(
              new PoseidonRpcError({
                code: "invalid",
                message: "a merge-base diff runs against the working tree and takes no `to`",
              }),
            );
          }
          const from = yield* validRef(options.from ?? "HEAD", "from");
          const to = options.to === undefined ? undefined : yield* validRef(options.to, "to");
          const root = yield* workspaceRoot(scope);
          if (root === null || !(yield* isRepository(root))) {
            return { ...notRepo, from: options.from ?? null, to: options.to ?? null };
          }
          // Branch against base: the fork point, not the base's tip, so the
          // base's own later commits never read as reverted here.
          const base =
            options.mergeBase === undefined ? from : yield* mergeBaseOf(root, options.mergeBase);
          const { patch, numstat } =
            to === undefined
              ? yield* worktreeDiff(root, base, options.path, options.ignoreWhitespace)
              : yield* refDiff(root, from, to, options.path, options.ignoreWhitespace);
          // The paths are the top level's; a project in a subfolder of its
          // repository needs this to find them under its own root.
          const prefix = yield* run(root, ["rev-parse", "--show-prefix"]);
          return {
            from: options.mergeBase === undefined ? (options.from ?? null) : base,
            to: options.to ?? null,
            isRepository: true,
            prefix: prefix.stdout.replace(/\n$/, ""),
            files: toDiffFiles(patch, numstat, options.ignoreWhitespace),
          };
        }).pipe(Effect.mapError(asRpcError)),

      /** Run from the repository's top level: the pane's paths are relative to it. */
      discard: (scope, options) =>
        Effect.gen(function* () {
          const root = yield* repositoryRoot(scope);
          yield* requireIdle(root, "discarding changes");
          if (options.paths === undefined && (options.source ?? options.mergeBase) !== undefined) {
            return yield* Effect.fail(
              new PoseidonRpcError({
                code: "invalid",
                message: "Discarding everything is only possible in the uncommitted scope.",
              }),
            );
          }
          const top = yield* repositoryTop(root);
          yield* discard(top, yield* discardBase(top, options), options.paths);
        }).pipe(Effect.mapError(asRpcError)),

      branches: (scope) =>
        Effect.gen(function* () {
          const root = yield* workspaceRoot(scope);
          if (root === null || !(yield* isRepository(root))) {
            return notRepositoryBranches;
          }
          return yield* listBranches(root);
        }).pipe(Effect.mapError(toRpcError)),

      createBranch: (scope, options) =>
        Effect.gen(function* () {
          const root = yield* repositoryRoot(scope);
          if (options.checkout) {
            yield* requireIdle(root, "switching branches");
          }
          yield* createBranch(root, options);
          return yield* listBranches(root);
        }).pipe(Effect.mapError(asRpcError)),

      checkout: (scope, branch) =>
        Effect.gen(function* () {
          const root = yield* repositoryRoot(scope);
          yield* requireIdle(root, "switching branches");
          yield* checkoutBranch(root, branch);
          return yield* listBranches(root);
        }).pipe(Effect.mapError(asRpcError)),

      commit: (scope, options) =>
        Effect.gen(function* () {
          const root = yield* repositoryRoot(scope);
          yield* requireIdle(root, "committing");
          return yield* commit(root, options);
        }).pipe(Effect.mapError(asRpcError)),

      push: (scope) =>
        Effect.gen(function* () {
          const root = yield* repositoryRoot(scope);
          return yield* push(root);
        }).pipe(Effect.mapError(asRpcError)),

      createPullRequest: (scope, options) =>
        Effect.gen(function* () {
          const root = yield* repositoryRoot(scope);
          const list = yield* listBranches(root);
          if (list.current === null) {
            return yield* Effect.fail(
              new PoseidonRpcError({
                code: "invalid",
                message: "HEAD is detached — check out a branch before opening a pull request.",
              }),
            );
          }
          const base = options.base ?? (yield* worktreeBase(scope)) ?? list.defaultBranch;
          if (base === null) {
            return yield* Effect.fail(
              new PoseidonRpcError({
                code: "invalid",
                message: "No base branch to open the pull request into.",
              }),
            );
          }
          // gh wants the base as the remote knows it: `origin/main` is `main` there.
          const remote = list.remotes.find((name) => base.startsWith(`${name}/`));
          const baseName = yield* validRef(
            remote === undefined ? base : base.slice(remote.length + 1),
            "base",
          );
          return yield* createPullRequest(gh, root, {
            head: list.current,
            base: baseName,
            title: options.title,
            body: options.body,
          });
        }).pipe(Effect.mapError(asRpcError)),

      pullRequestReadiness: (scope) =>
        Effect.gen(function* () {
          const root = yield* workspaceRoot(scope);
          // No folder, no repository: the header offers no git action at all.
          return { reason: root === null ? null : yield* pullRequestBlocker(gh, root) };
        }).pipe(Effect.mapError(toRpcError)),

      createWorktree: (projectId, options) =>
        Effect.gen(function* () {
          const project = yield* projectRepository(projectId);
          const { git: gitSettings } = yield* settings.get;
          return yield* createWorktree(project.workspaceRoot, {
            worktreesRoot: worktreesRoot.path,
            projectName: project.name,
            branchPrefix: gitSettings.branchPrefix,
            name: options.name,
            baseBranch: options.baseBranch,
          });
        }).pipe(Effect.mapError(asRpcError)),

      listWorktrees: (projectId) =>
        Effect.gen(function* () {
          const project = yield* projectRepository(projectId);
          return yield* listWorktrees(project.workspaceRoot);
        }).pipe(Effect.mapError(asRpcError)),

      removeWorktree: (projectId, options) =>
        Effect.gen(function* () {
          const project = yield* projectRepository(projectId);
          const worktree = yield* registeredWorktree(project.workspaceRoot, options.path);
          const inUse = yield* worktreeInUse(readModels, worktree.path).pipe(
            Effect.mapError(
              (error) => new PoseidonRpcError({ code: "internal", message: error.message }),
            ),
          );
          if (inUse) {
            return yield* Effect.fail(
              new PoseidonRpcError({
                code: "conflict",
                message: "A thread still works in this worktree — delete the thread first.",
              }),
            );
          }
          const ownerProject = yield* projectRootedAt(readModels, worktree.path).pipe(
            Effect.mapError(
              (error) => new PoseidonRpcError({ code: "internal", message: error.message }),
            ),
          );
          if (ownerProject !== null) {
            return yield* Effect.fail(
              new PoseidonRpcError({
                code: "conflict",
                message: `This worktree is the folder of the project "${ownerProject}" — remove that project first.`,
              }),
            );
          }
          // A setup cut short a moment ago may still be stopping; removing
          // the tree under it would race its last writes.
          yield* setupsStopped(worktree.path);
          yield* removeWorktree(project.workspaceRoot, worktree, options.force);
        }).pipe(Effect.mapError(asRpcError)),

      setupWorktree: (projectId, path) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const project = yield* projectRepository(projectId);
            const worktree = yield* registeredWorktree(project.workspaceRoot, path);
            // From the settings document only: a client names the worktree,
            // never the command that runs in it.
            const script = (yield* settings.get).projectSettings[projectId]?.setupScript ?? "";
            if (script.trim() === "") {
              return Stream.make({ kind: "skipped" as const });
            }
            return runSetupScript({
              script,
              cwd: worktree.path,
              projectRoot: project.workspaceRoot,
            });
          }).pipe(Effect.mapError(asRpcError)),
        ),

      /**
       * The refs that are actually there. The timeline's checkpoint list is a
       * fold of `thread.checkpoint.created`, so it still names refs removed
       * outside the app — a prune, a re-clone — and a caller intersects the
       * two rather than offering a restore that can only fail.
       */
      checkpoints: (projectId, threadId) =>
        Effect.gen(function* () {
          const root = yield* workspaceRoot({ projectId, threadId });
          if (root === null || !(yield* isRepository(root))) {
            return [];
          }
          return yield* checkpointStore.list({ threadId, workspaceRoot: root });
        }).pipe(
          Effect.mapError(
            (error) => new PoseidonRpcError({ code: "internal", message: error.message }),
          ),
        ),
    });
  }),
);
