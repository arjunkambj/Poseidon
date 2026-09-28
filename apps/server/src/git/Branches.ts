/**
 * Branches: list them, find the default one, cut one, switch to one.
 *
 * Pure parsing of git's porcelain output plus the `run` calls that produce it;
 * `Git.ts` resolves the workspace root and applies the guards that need the
 * read models (a turn running in the same root) before delegating here. The
 * guards git itself can answer — a malformed name, a dirty tracked tree — live
 * here, so every caller gets them.
 *
 * Every branch this module cuts is cut with `--no-track`. A branch cut from
 * `origin/main` would otherwise track `origin/main`, and its first plain
 * `git push` would land on main.
 */
import type { GitBranch, GitBranchList } from "@poseidon/contracts/git";
import * as Effect from "effect/Effect";

import { PoseidonRpcError } from "@poseidon/contracts/rpc";

import { GitError, run } from "./process";

/** What a workspace that is not a repository answers. */
export const notRepositoryBranches: GitBranchList = {
  isRepository: false,
  current: null,
  defaultBranch: null,
  remotes: [],
  branches: [],
};

/**
 * A ref argument that lands in argv: letters, digits, `.`, `_`, `/`, `-`, and
 * never a leading `-`, which git would read as an option (`--output=...`).
 * Branch names, remote branches, SHAs and the hidden checkpoint refs all fit.
 */
const REF_ARG = /^[A-Za-z0-9._/-]+$/;

export const isSafeRefArg = (value: string): boolean =>
  !value.startsWith("-") && REF_ARG.test(value);

const invalid = (message: string) => new PoseidonRpcError({ code: "invalid", message });
const conflict = (message: string) => new PoseidonRpcError({ code: "conflict", message });

/** A ref argument, or `invalid` before git ever sees it. */
export const validRef = (value: string, name: string): Effect.Effect<string, PoseidonRpcError> =>
  isSafeRefArg(value)
    ? Effect.succeed(value)
    : Effect.fail(invalid(`invalid ${name} ref: ${value}`));

// ── Parsing ────────────────────────────────────────────────────

const FIELD = "\u0000";
/** `for-each-ref` fields, NUL-separated, one ref per line. */
const REF_FORMAT = ["%(refname)", "%(upstream:short)", "%(HEAD)", "%(symref)"].join("%00");

interface RefRow {
  readonly refname: string;
  readonly upstream: string;
  readonly isHead: boolean;
  readonly symref: string;
}

const parseRefRows = (stdout: string): Array<RefRow> =>
  stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [refname = "", upstream = "", head = "", symref = ""] = line.split(FIELD);
      return { refname, upstream, isHead: head === "*", symref };
    });

/**
 * `git worktree list --porcelain -z`: blocks of `worktree <path>`, `HEAD
 * <sha>`, `branch refs/heads/<name>` (or `detached`) records, each block ended
 * by an empty record. Answers the branch → path map of checked-out branches.
 */
const parseWorktreeBranches = (stdout: string): Map<string, string> => {
  const byBranch = new Map<string, string>();
  let path: string | null = null;
  for (const record of stdout.split(FIELD)) {
    if (record.startsWith("worktree ")) {
      path = record.slice("worktree ".length);
    } else if (record.startsWith("branch refs/heads/") && path !== null) {
      byBranch.set(record.slice("branch refs/heads/".length), path);
    } else if (record.length === 0) {
      path = null;
    }
  }
  return byBranch;
};

/**
 * The branch rows, local then remote, in refname order. A remote's own
 * `<remote>/HEAD` is a pointer to one of its branches, not a branch, so it is
 * skipped.
 */
const toBranches = (
  rows: ReadonlyArray<RefRow>,
  checkedOut: ReadonlyMap<string, string>,
): Array<GitBranch> => {
  const branches: Array<GitBranch> = [];
  for (const row of rows) {
    if (row.symref.length > 0 || row.refname.endsWith("/HEAD")) continue;
    if (row.refname.startsWith("refs/heads/")) {
      const name = row.refname.slice("refs/heads/".length);
      const worktreePath = row.isHead ? undefined : checkedOut.get(name);
      branches.push({
        name,
        kind: "local",
        isCurrent: row.isHead,
        ...(row.upstream.length > 0 ? { upstream: row.upstream } : {}),
        ...(worktreePath === undefined ? {} : { worktreePath }),
      });
    } else if (row.refname.startsWith("refs/remotes/")) {
      branches.push({
        name: row.refname.slice("refs/remotes/".length),
        kind: "remote",
        isCurrent: false,
      });
    }
  }
  return branches;
};

const lines = (stdout: string) =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

// ── Reads ──────────────────────────────────────────────────────

/** The checked-out branch, or `null` on a detached HEAD. Unborn branches count. */
export const currentBranch = (cwd: string) =>
  run(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowNonZeroExit: true }).pipe(
    Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)),
  );

export const refExists = (cwd: string, ref: string) =>
  run(cwd, ["show-ref", "--verify", "--quiet", ref], { allowNonZeroExit: true }).pipe(
    Effect.map((result) => result.exitCode === 0),
  );

const remotesOf = (cwd: string) => run(cwd, ["remote"]).pipe(Effect.map((r) => lines(r.stdout)));

/**
 * The branch new work is cut from, in order: the remote's HEAD (`origin`, or
 * the first remote), a local `main` then `master`, `init.defaultBranch` when
 * that branch exists, and finally whatever is checked out.
 *
 * The remote's HEAD is named by its short name (`main`) only when a local
 * branch of that name exists. A clone made with `-b develop`, or one whose
 * local main was deleted, has only `origin/main`, and a bare `main` would be
 * a base no worktree can be cut from and no merge base can be found for; the
 * remote-tracking name works for both, and a pull request strips the remote.
 */
const defaultBranch = (
  cwd: string,
  remotes: ReadonlyArray<string>,
  current: string | null,
): Effect.Effect<string | null, GitError> =>
  Effect.gen(function* () {
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    if (remote !== undefined) {
      const head = yield* run(
        cwd,
        ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
        { allowNonZeroExit: true },
      );
      const target = head.stdout.trim();
      if (head.exitCode === 0 && target.startsWith(`${remote}/`)) {
        const short = target.slice(remote.length + 1);
        if (yield* refExists(cwd, `refs/heads/${short}`)) return short;
        if (yield* refExists(cwd, `refs/remotes/${target}`)) return target;
      }
    }
    for (const candidate of ["main", "master"]) {
      if (yield* refExists(cwd, `refs/heads/${candidate}`)) return candidate;
    }
    const configured = yield* run(cwd, ["config", "--get", "init.defaultBranch"], {
      allowNonZeroExit: true,
    });
    const initial = configured.stdout.trim();
    if (
      configured.exitCode === 0 &&
      isSafeRefArg(initial) &&
      (yield* refExists(cwd, `refs/heads/${initial}`))
    ) {
      return initial;
    }
    return current;
  });

/** Every branch of a repository `cwd`, read fresh. The caller has checked it is one. */
export const listBranches = (cwd: string): Effect.Effect<GitBranchList, GitError> =>
  Effect.gen(function* () {
    const refs = yield* run(cwd, [
      "for-each-ref",
      `--format=${REF_FORMAT}`,
      "refs/heads",
      "refs/remotes",
    ]);
    const worktrees = yield* run(cwd, ["worktree", "list", "--porcelain", "-z"]);
    const current = yield* currentBranch(cwd);
    const remotes = yield* remotesOf(cwd);
    return {
      isRepository: true,
      current,
      defaultBranch: yield* defaultBranch(cwd, remotes, current),
      remotes,
      branches: toBranches(parseRefRows(refs.stdout), parseWorktreeBranches(worktrees.stdout)),
    };
  });

// ── Guards ─────────────────────────────────────────────────────

/**
 * Refuses a switch while a tracked file has uncommitted changes. Untracked
 * files are deliberately ignored: git carries them across a switch (and
 * refuses by itself when one would be overwritten), and the config files a
 * harness session writes into its workspace are untracked, so counting them
 * would make every branch switch fail while a session is open.
 */
const requireCleanTrackedTree = (cwd: string) =>
  Effect.gen(function* () {
    const status = yield* run(cwd, ["status", "--porcelain=v2", "--untracked-files=no", "-z"]);
    if (status.stdout.split(FIELD).some((record) => /^[12u] /.test(record))) {
      return yield* Effect.fail(
        conflict(
          "The working tree has uncommitted changes — commit or discard them before switching branches.",
        ),
      );
    }
  });

/**
 * A branch name git accepts, checked by git itself. The leading `-` and the
 * characters argv must never carry are refused first, so `check-ref-format`
 * never sees an option.
 */
const validBranchName = (cwd: string, name: string) =>
  Effect.gen(function* () {
    if (!isSafeRefArg(name)) {
      return yield* Effect.fail(invalid(`"${name}" is not a valid branch name.`));
    }
    const checked = yield* run(cwd, ["check-ref-format", "--branch", name], {
      allowNonZeroExit: true,
    });
    if (checked.exitCode !== 0) {
      return yield* Effect.fail(invalid(`"${name}" is not a valid branch name.`));
    }
    return name;
  });

/** A git refusal (a branch checked out elsewhere, an untracked file in the way) as `conflict`. */
const refusal = (error: GitError) => conflict(error.message);

// ── Writes ─────────────────────────────────────────────────────

/**
 * Switches to `branch`. A local branch is switched to; a remote-tracking one
 * (`origin/feature`) becomes the local `feature` tracking it, or switches to
 * an existing local `feature`. The dirty-tree guard runs first.
 */
export const checkoutBranch = (cwd: string, branch: string) =>
  Effect.gen(function* () {
    const name = yield* validRef(branch, "branch");
    yield* requireCleanTrackedTree(cwd);
    if (yield* refExists(cwd, `refs/heads/${name}`)) {
      yield* run(cwd, ["switch", "--no-guess", name]).pipe(Effect.mapError(refusal));
      return;
    }
    if (yield* refExists(cwd, `refs/remotes/${name}`)) {
      const remotes = yield* remotesOf(cwd);
      // Longest match first: a remote named `team/a` owns `team/a/x`, not `team`.
      const remote = [...remotes]
        .sort((a, b) => b.length - a.length)
        .find((candidate) => name.startsWith(`${candidate}/`));
      const local = remote === undefined ? undefined : name.slice(remote.length + 1);
      if (local !== undefined && (yield* refExists(cwd, `refs/heads/${local}`))) {
        yield* run(cwd, ["switch", "--no-guess", local]).pipe(Effect.mapError(refusal));
        return;
      }
      yield* run(cwd, ["switch", "--track", name]).pipe(Effect.mapError(refusal));
      return;
    }
    return yield* Effect.fail(
      new PoseidonRpcError({ code: "not-found", message: `No branch named "${name}".` }),
    );
  });

/**
 * Cuts `name` from `from` (default `HEAD`) with `--no-track`, and switches to
 * it when `checkout` is set — after the same dirty-tree guard a plain switch
 * has.
 */
export const createBranch = (
  cwd: string,
  options: {
    readonly name: string;
    readonly from?: string | undefined;
    readonly checkout: boolean;
  },
) =>
  Effect.gen(function* () {
    const name = yield* validBranchName(cwd, options.name);
    const from = yield* validRef(options.from ?? "HEAD", "from");
    const resolved = yield* run(cwd, ["rev-parse", "--verify", "--quiet", `${from}^{commit}`], {
      allowNonZeroExit: true,
    });
    if (resolved.exitCode !== 0) {
      return yield* Effect.fail(invalid(`There is no commit at "${from}" to cut a branch from.`));
    }
    if (yield* refExists(cwd, `refs/heads/${name}`)) {
      return yield* Effect.fail(conflict(`A branch named "${name}" already exists.`));
    }
    if (options.checkout) {
      yield* requireCleanTrackedTree(cwd);
      yield* run(cwd, ["switch", "--no-track", "-c", name, from]).pipe(Effect.mapError(refusal));
    } else {
      yield* run(cwd, ["branch", "--no-track", name, from]).pipe(Effect.mapError(refusal));
    }
  });

/**
 * The commit the branch forked from `base` at: what "branch against base"
 * diffs the working tree against, so the base's own later commits never show
 * up as changes this branch reverted.
 */
export const mergeBaseOf = (cwd: string, base: string) =>
  Effect.gen(function* () {
    const ref = yield* validRef(base, "merge base");
    const result = yield* run(cwd, ["merge-base", "HEAD", ref], { allowNonZeroExit: true });
    const sha = result.stdout.trim();
    if (result.exitCode !== 0 || sha.length === 0) {
      return yield* Effect.fail(invalid(`No common ancestor between HEAD and ${ref}.`));
    }
    return sha;
  });
