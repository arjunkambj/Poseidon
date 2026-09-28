/**
 * Commit and push: the two writes behind the git actions control.
 *
 * Like `Branches.ts`, this is the git half only. `Git.ts` resolves the
 * workspace root and refuses a commit while a turn runs in it; the rules git
 * itself decides — what gets staged, whether anything is, which remote a
 * branch pushes to — live here.
 *
 * Both run as the user, not as Poseidon: no author environment (that is the
 * checkpoint store's, for its hidden refs only) and never `--no-verify`, so
 * the user's identity, signing config and hooks apply exactly as they would in
 * a terminal. A hook that refuses surfaces its own output.
 */
import type { GitCommitResult, GitPushResult } from "@poseidon/contracts/git";
import * as Effect from "effect/Effect";

import { PoseidonRpcError } from "@poseidon/contracts/rpc";

import { run, type GitResult } from "./process";

const invalid = (message: string) => new PoseidonRpcError({ code: "invalid", message });
const conflict = (message: string) => new PoseidonRpcError({ code: "conflict", message });

/** What git said when it refused: stderr, else stdout (some hooks print there), else the code. */
const refusalText = (result: GitResult) =>
  result.stderr.trim() || result.stdout.trim() || `git exited ${result.exitCode}`;

/** The checked-out branch, or `null` on a detached HEAD. */
const currentBranch = (cwd: string) =>
  run(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowNonZeroExit: true }).pipe(
    Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)),
  );

// ── Commit ─────────────────────────────────────────────────────

/**
 * The staged renames, as `new path → old path`. `-z` keeps odd names intact:
 * each rename is `R<score>` NUL `old` NUL `new` NUL, every other change one
 * status and one path.
 */
const stagedRenames = (cwd: string) =>
  run(cwd, ["diff", "--cached", "--name-status", "-z", "--find-renames"]).pipe(
    Effect.map((result) => {
      const renames = new Map<string, string>();
      const fields = result.stdout.split("\0");
      for (let index = 0; index < fields.length;) {
        const kind = fields[index] ?? "";
        if (kind.startsWith("R") || kind.startsWith("C")) {
          const from = fields[index + 1];
          const to = fields[index + 2];
          // A copy keeps its source, so only a rename's source goes with it.
          if (kind.startsWith("R") && from !== undefined && to !== undefined) {
            renames.set(to, from);
          }
          index += 3;
        } else {
          index += 2;
        }
      }
      return renames;
    }),
  );

/** `paths`, plus the old path of every staged rename among them. */
const withRenameSources = (cwd: string, paths: ReadonlyArray<string>) =>
  stagedRenames(cwd).pipe(
    Effect.map((renames) => {
      const sources = paths.flatMap((path) => {
        const from = renames.get(path);
        return from === undefined || paths.includes(from) ? [] : [from];
      });
      return [...paths, ...sources];
    }),
  );

/**
 * The operation a commit would conclude — a merge, cherry-pick or revert that
 * stopped for the user — or `null`. Its `*_HEAD` ref is what makes the
 * commit a merge commit or carries the picked commit's author.
 */
const pendingOperation = (cwd: string) =>
  Effect.gen(function* () {
    for (const [ref, name] of [
      ["MERGE_HEAD", "merge"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
    ] as const) {
      const found = yield* run(cwd, ["rev-parse", "-q", "--verify", ref], {
        allowNonZeroExit: true,
      });
      if (found.exitCode === 0) return name;
    }
    return null;
  });

/**
 * The paths with unresolved conflicts, repository-relative. `-u` prints one
 * `mode sha stage<TAB>path` entry per conflict stage, so a path repeats.
 */
const unmergedPaths = (cwd: string) =>
  run(cwd, ["ls-files", "--unmerged", "-z", "--full-name", "--", ":/"]).pipe(
    Effect.map((result) => [
      ...new Set(
        result.stdout
          .split("\0")
          .map((entry) => entry.slice(entry.indexOf("\t") + 1))
          .filter((path) => path.length > 0),
      ),
    ]),
  );

const listed = (paths: ReadonlyArray<string>) =>
  paths.length <= 3
    ? paths.join(", ")
    : `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more`;

/**
 * Refuses a commit git would refuse, or one that would lose the user's
 * in-progress state. Unresolved conflicts first: staging them would record
 * the conflict markers as the resolution, and the index they live in cannot
 * be saved to put back. Then, like `git commit -- <paths>`, a partial commit
 * mid-merge, cherry-pick or revert: that commit has to take every change, and
 * committing some of them would drop the other parent or the picked commit.
 */
const refuseUnfinished = (cwd: string, paths: ReadonlyArray<string> | undefined) =>
  Effect.gen(function* () {
    const unmerged = yield* unmergedPaths(cwd);
    if (unmerged.length > 0) {
      return yield* Effect.fail(
        conflict(`Resolve the conflicts in ${listed(unmerged)} before committing.`),
      );
    }
    if (paths === undefined) return;
    const pending = yield* pendingOperation(cwd);
    if (pending !== null) {
      return yield* Effect.fail(
        conflict(
          `A ${pending} is in progress, and its commit takes every change. ` +
            `Commit all the files, or finish the ${pending} in a terminal.`,
        ),
      );
    }
  });

/**
 * Stages what the commit should contain.
 *
 * Without `paths`, everything: `git add -A`, the "commit all my changes" the
 * control offers by default.
 *
 * With `paths`, only those. The index is reset first, so a file the user had
 * staged in a terminal but left unchecked in the dialog does not ride along:
 * the dialog's list is the whole commit. The cost is that such a file ends up
 * unstaged (its changes stay in the working tree), which is the lesser
 * surprise — a commit that silently carries more than the user picked cannot
 * be taken back once it is pushed. `--literal-pathspecs` makes every path
 * exactly that path, never a glob or a `:(magic)` pathspec.
 *
 * A staged rename is one change in `git status` — one row, one checkbox, named
 * by its new path — but two paths to `git add`. The reset splits it into a
 * deletion and an untracked file, so a picked rename's old path is staged
 * with it (`withRenameSources`); otherwise the commit would add a copy and
 * leave the deletion behind.
 *
 * Either way the index is only rearranged for a commit that is then made:
 * `commit` saves it first and puts it back when staging or the commit fails.
 */
const stage = (cwd: string, paths: ReadonlyArray<string> | undefined) =>
  Effect.gen(function* () {
    if (paths === undefined) {
      yield* run(cwd, ["add", "-A"]).pipe(Effect.mapError((error) => conflict(error.message)));
      return;
    }
    if (paths.length === 0) {
      return yield* Effect.fail(invalid("Choose at least one file to commit."));
    }
    const picked = yield* withRenameSources(cwd, paths);
    // `:/` is the whole repository, as a bare `reset` would be — but a reset
    // with a pathspec only unstages; it never clears a merge's or a
    // cherry-pick's state the way a pathless one does.
    yield* run(cwd, ["reset", "-q", "--", ":/"]);
    const added = yield* run(cwd, ["--literal-pathspecs", "add", "-A", "--", ...picked], {
      allowNonZeroExit: true,
    });
    if (added.exitCode !== 0) {
      return yield* Effect.fail(invalid(refusalText(added)));
    }
  });

/**
 * The index as a tree object, so a failed commit can put back what the user
 * had staged; `null` when it cannot be written. `refuseUnfinished` has
 * already turned away the unmerged entries that would make it fail.
 */
const saveIndex = (cwd: string) =>
  run(cwd, ["write-tree"], { allowNonZeroExit: true }).pipe(
    Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
  );

/** Puts the index saved by `saveIndex` back; the working tree is untouched. */
const restoreIndex = (cwd: string, tree: string | null) =>
  tree === null ? Effect.void : run(cwd, ["read-tree", tree]).pipe(Effect.ignore);

/**
 * Commits the working tree's changes — all of them, or only `paths` — with
 * `message`, and answers the commit that was made. A call that makes no
 * commit — unresolved conflicts, some files picked mid-merge, a path git
 * cannot stage, nothing staged, a hook that refuses — leaves the index and
 * any merge in progress as the user had them, as `git commit` itself does.
 */
export const commit = (
  cwd: string,
  options: { readonly message: string; readonly paths?: ReadonlyArray<string> | undefined },
) =>
  Effect.gen(function* () {
    yield* refuseUnfinished(cwd, options.paths);
    const saved = yield* saveIndex(cwd);
    yield* Effect.gen(function* () {
      yield* stage(cwd, options.paths);
      const staged = yield* run(cwd, ["diff", "--cached", "--quiet"], { allowNonZeroExit: true });
      if (staged.exitCode === 0) {
        return yield* Effect.fail(conflict("Nothing to commit."));
      }
      // `-m` means git never opens an editor; the hooks still run.
      const committed = yield* run(cwd, ["commit", "-q", "-m", options.message], {
        allowNonZeroExit: true,
      });
      if (committed.exitCode !== 0) {
        return yield* Effect.fail(conflict(refusalText(committed)));
      }
    }).pipe(Effect.onError(() => restoreIndex(cwd, saved)));
    const head = yield* run(cwd, ["log", "-1", "--format=%H%x00%s"]);
    const [sha = "", subject = ""] = head.stdout.replace(/\n$/, "").split("\0");
    return { sha, subject, branch: yield* currentBranch(cwd) } satisfies GitCommitResult;
  });

// ── Push ───────────────────────────────────────────────────────

/**
 * A push may wait on the network and a large upload, but never on a person:
 * no terminal credential prompt (it would hang this call forever, with no
 * terminal to answer it), and a ceiling that turns a stall into an error.
 */
const PUSH_ENV = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
const PUSH_TIMEOUT_MS = 5 * 60 * 1000;

const lines = (stdout: string) =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/**
 * The remote `branch` pushes to: its configured `branch.<name>.remote`, else
 * `origin`, else the repository's only remote. `.` (a branch tracking another
 * local branch) is not a remote to push to, so it falls through.
 */
export const remoteFor = (cwd: string, branch: string) =>
  Effect.gen(function* () {
    const remotes = lines((yield* run(cwd, ["remote"])).stdout);
    const configured = yield* run(cwd, ["config", "--get", `branch.${branch}.remote`], {
      allowNonZeroExit: true,
    });
    const named = configured.stdout.trim();
    if (configured.exitCode === 0 && remotes.includes(named)) return named;
    if (remotes.includes("origin")) return "origin";
    if (remotes.length === 1) return remotes[0]!;
    return yield* Effect.fail(
      new PoseidonRpcError({
        code: "unavailable",
        message:
          remotes.length === 0
            ? "This repository has no remote to push to."
            : `This branch has no remote configured and there is no origin among ${remotes.join(", ")}.`,
      }),
    );
  });

/**
 * Pushes the current branch. With an upstream, a plain `git push`, which
 * honours the user's `push.default`. Without one, `git push -u <remote>
 * <branch>`, which pushes to a branch of the same name and records it as the
 * upstream — a branch cut `--no-track` from `origin/main` lands on its own
 * name, never on main.
 */
export const push = (cwd: string) =>
  Effect.gen(function* () {
    const branch = yield* currentBranch(cwd);
    if (branch === null) {
      return yield* Effect.fail(invalid("HEAD is detached — check out a branch before pushing."));
    }
    const remote = yield* remoteFor(cwd, branch);
    if (remote.startsWith("-") || branch.startsWith("-")) {
      return yield* Effect.fail(invalid(`Refusing to push ${branch} to ${remote}.`));
    }
    const upstream = yield* run(
      cwd,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`],
      { allowNonZeroExit: true },
    );
    const setUpstream = upstream.exitCode !== 0;
    const args = setUpstream ? ["push", "-u", remote, branch] : ["push"];
    const pushed = yield* run(cwd, args, {
      env: PUSH_ENV,
      timeoutMs: PUSH_TIMEOUT_MS,
      allowNonZeroExit: true,
    }).pipe(Effect.mapError((error) => conflict(error.message)));
    if (pushed.exitCode !== 0) {
      return yield* Effect.fail(conflict(refusalText(pushed)));
    }
    return { remote, branch, setUpstream } satisfies GitPushResult;
  });
