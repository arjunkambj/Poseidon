/**
 * Worktrees: cut one for a new thread, list a repository's, remove one.
 *
 * A thread that asks for its own worktree gets a branch
 * `<branchPrefix><slug>` cut `--no-track` from its base, checked out in
 * `<worktrees root>/<project slug>/<slug>` — under the Poseidon home, never
 * inside the user's repository. The slug is made unique against the
 * repository's branches *and* the directories already there, since two
 * projects with the same name share a parent directory.
 *
 * Every path a caller hands back (to remove, to run the setup script in) has
 * to be a registered worktree of the project's repository other than the
 * project's own folder and the repository's main checkout, compared by real
 * path: git prints resolved paths, and macOS's tmp is `/var` →
 * `/private/var`. Removal never deletes the branch, so committed work outlives
 * the directory. `Git.ts` resolves the project and applies the guard that
 * needs the read models (a thread still working in the worktree).
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import * as nodePath from "node:path";
import type { GitWorktreeInfo, ThreadWorktree } from "@poseidon/contracts/git";
import { branchSlug } from "@poseidon/shared/branchSlug";
import { worktreesDir } from "@poseidon/shared/paths";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PoseidonRpcError } from "@poseidon/contracts/rpc";

import { canonicalPath } from "../orchestration/workspaceRoot";
import { isSafeRefArg, listBranches, refExists, validRef } from "./Branches";
import { run } from "./process";

/**
 * The directory new worktrees are created under. A service rather than a
 * constant so a test points it at a tmp directory instead of moving
 * `POSEIDON_HOME` for the whole process; `boot` provides `worktreesDir()`.
 */
export class WorktreesRoot extends Context.Service<WorktreesRoot, { readonly path: string }>()(
  "server/git/WorktreesRoot",
) {
  static readonly layer = Layer.sync(WorktreesRoot, () =>
    WorktreesRoot.of({ path: worktreesDir() }),
  );
}

const invalid = (message: string) => new PoseidonRpcError({ code: "invalid", message });
const conflict = (message: string) => new PoseidonRpcError({ code: "conflict", message });

/** How many `-2`, `-3`… suffixes are tried before giving up on a name. */
const MAX_SUFFIX = 100;

// ── Listing ────────────────────────────────────────────────────

/**
 * `git worktree list --porcelain -z`: one block per worktree — `worktree
 * <path>`, `HEAD <sha>`, then `branch refs/heads/<name>` or `detached` — each
 * ended by an empty record. The first block is the repository's own checkout.
 * A bare entry has no HEAD and no files, so it is left out.
 */
const parseWorktreeList = (stdout: string): Array<GitWorktreeInfo> => {
  const worktrees: Array<GitWorktreeInfo> = [];
  let block: { path: string; head: string | null; branch: string | null } | null = null;
  let index = 0;
  const flush = () => {
    if (block !== null && block.head !== null) {
      worktrees.push({
        path: block.path,
        branch: block.branch,
        head: block.head,
        isMain: index === 0,
      });
    }
    if (block !== null) index += 1;
    block = null;
  };
  for (const record of stdout.split("\0")) {
    if (record.startsWith("worktree ")) {
      flush();
      block = { path: record.slice("worktree ".length), head: null, branch: null };
    } else if (block === null) {
      continue;
    } else if (record.startsWith("HEAD ")) {
      block.head = record.slice("HEAD ".length) || null;
    } else if (record.startsWith("branch refs/heads/")) {
      block.branch = record.slice("branch refs/heads/".length);
    } else if (record === "bare") {
      block.head = null;
    } else if (record.length === 0) {
      flush();
    }
  }
  flush();
  return worktrees;
};

/** Every worktree of the repository `root` belongs to, its own checkout first. */
export const listWorktrees = (root: string) =>
  run(root, ["worktree", "list", "--porcelain", "-z"]).pipe(
    Effect.map((result) => parseWorktreeList(result.stdout)),
  );

/**
 * The worktree at `path`, when it is one of `root`'s and neither `root` itself
 * nor the repository's main checkout; `invalid` otherwise. The two differ when
 * the project was added from a linked worktree: git lists the main checkout
 * first, and the project's own folder is then just another entry. Whatever a
 * client names goes through here before anything is removed or run in it.
 */
export const registeredWorktree = (root: string, path: string) =>
  Effect.gen(function* () {
    if (!nodePath.isAbsolute(path)) {
      return yield* Effect.fail(invalid(`"${path}" is not an absolute path.`));
    }
    const target = canonicalPath(path);
    const found = (yield* listWorktrees(root)).find(
      (worktree) => canonicalPath(worktree.path) === target,
    );
    if (found === undefined) {
      return yield* Effect.fail(invalid(`"${path}" is not a worktree of this project.`));
    }
    if (target === canonicalPath(root)) {
      return yield* Effect.fail(
        invalid(
          "That is the project's own checkout, not a worktree Poseidon can remove or set up.",
        ),
      );
    }
    if (found.isMain) {
      return yield* Effect.fail(
        invalid(
          "That is the repository's main checkout, not a worktree Poseidon can remove or set up.",
        ),
      );
    }
    return found;
  });

// ── Creating ───────────────────────────────────────────────────

/**
 * The branch `prefix + slug` names, or `invalid` naming the prefix setting —
 * the slug alone is always a valid name, so a refusal here is the prefix's.
 */
const validPrefix = (root: string, prefix: string, slug: string) =>
  Effect.gen(function* () {
    const branch = `${prefix}${slug}`;
    const checked = isSafeRefArg(branch)
      ? yield* run(root, ["check-ref-format", "--branch", branch], { allowNonZeroExit: true })
      : null;
    if (checked === null || checked.exitCode !== 0) {
      return yield* Effect.fail(
        invalid(
          `The branch prefix "${prefix}" makes "${branch}" an invalid branch name — change it in Settings → Git.`,
        ),
      );
    }
  });

/** The first `slug`, `slug-2`, `slug-3`… free as both a branch and a directory. */
const freeName = (root: string, parent: string, prefix: string, slug: string) =>
  Effect.gen(function* () {
    for (let n = 1; n <= MAX_SUFFIX; n += 1) {
      const name = n === 1 ? slug : `${slug}-${n}`;
      const branch = `${prefix}${name}`;
      const dir = nodePath.join(parent, name);
      if (existsSync(dir) || (yield* refExists(root, `refs/heads/${branch}`))) continue;
      return { branch, dir };
    }
    return yield* Effect.fail(
      conflict(`Every name from "${prefix}${slug}" to "-${MAX_SUFFIX}" is taken.`),
    );
  });

/**
 * Cuts a new worktree for a thread named `name`, from `baseBranch` or the
 * repository's default branch, and answers what the thread records.
 */
export const createWorktree = (
  root: string,
  options: {
    readonly worktreesRoot: string;
    readonly projectName: string;
    readonly branchPrefix: string;
    readonly name: string;
    readonly baseBranch?: string | undefined;
  },
) =>
  Effect.gen(function* () {
    const slug = branchSlug(options.name);
    yield* validPrefix(root, options.branchPrefix, slug);
    const base = options.baseBranch ?? (yield* listBranches(root)).defaultBranch;
    if (base === null) {
      return yield* Effect.fail(
        invalid("There is no branch to cut a worktree from yet — make a first commit."),
      );
    }
    yield* validRef(base, "base");
    const resolved = yield* run(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], {
      allowNonZeroExit: true,
    });
    if (resolved.exitCode !== 0) {
      return yield* Effect.fail(invalid(`There is no commit at "${base}" to cut a worktree from.`));
    }
    const parent = nodePath.join(
      nodePath.resolve(options.worktreesRoot),
      branchSlug(options.projectName),
    );
    const { branch, dir } = yield* freeName(root, parent, options.branchPrefix, slug);
    mkdirSync(parent, { recursive: true });
    // `--no-track`: a branch cut from `origin/main` would otherwise track it,
    // and the thread's first push would land on main.
    yield* run(root, ["worktree", "add", "--quiet", "--no-track", "-b", branch, dir, base]).pipe(
      Effect.mapError((error) => conflict(error.message)),
    );
    const worktree: ThreadWorktree = { path: realpathSync(dir), branch, baseBranch: base };
    return worktree;
  });

// ── Removing ───────────────────────────────────────────────────

/**
 * Removes a worktree `registeredWorktree` vouched for, then prunes git's
 * bookkeeping. Without `force` git refuses a tree with modified or untracked
 * files, which is answered as the work it would lose; the branch is never
 * deleted.
 */
export const removeWorktree = (root: string, worktree: GitWorktreeInfo, force: boolean) =>
  Effect.gen(function* () {
    const result = yield* run(
      root,
      ["worktree", "remove", ...(force ? ["--force"] : []), worktree.path],
      { allowNonZeroExit: true },
    );
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim();
      if (!force && /modified or untracked files/.test(detail)) {
        return yield* Effect.fail(
          conflict(
            "The worktree has uncommitted or untracked changes — removing it would lose that work.",
          ),
        );
      }
      return yield* Effect.fail(
        conflict(detail || `git worktree remove exited ${result.exitCode}`),
      );
    }
    yield* run(root, ["worktree", "prune"]);
  });
