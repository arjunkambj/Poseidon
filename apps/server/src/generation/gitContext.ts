/**
 * What the model reads about a change, straight from git.
 *
 * Every call is a read: `git diff` against `HEAD` (or the base), `git log`,
 * `git ls-files` and the files themselves. The index is never written — a
 * commit message is drafted from what the working tree holds against `HEAD`,
 * so it covers staged and unstaged edits alike and costs the user nothing
 * they staged. External diff drivers and colour are always off, so the model
 * reads plain unified diffs whatever the user's config says.
 */

import { readFileSync, statSync } from "node:fs";
import * as nodePath from "node:path";
import type { GitSettings } from "@poseidon/contracts/settings";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import * as Effect from "effect/Effect";

import { currentBranch, listBranches, validRef } from "../git/Branches";
import { isRepository, run, type GitError } from "../git/process";
import { PATCH_CAP, SUMMARY_CAP, capText, type StyleContext } from "./prompts";

const invalid = (message: string) => new PoseidonRpcError({ code: "invalid", message });

/** Plain unified diffs, whatever the user's config says. */
const DIFF_FLAGS = ["--no-ext-diff", "--no-color"];

/** The most untracked files whose contents are shown, and how much of each. */
const UNTRACKED_FILES = 20;
const UNTRACKED_FILE_CAP = 4_000;
/** A file larger than this is named, never read. */
const UNTRACKED_READ_LIMIT = 1024 * 1024;

/** How many commit subjects the repository's style is read from. */
const STYLE_SUBJECTS = 20;
/** How many of a branch's commits a pull request is written from. */
const BRANCH_COMMITS = 50;

const lines = (stdout: string): Array<string> =>
  stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");

const mustBeRepository = (root: string) =>
  Effect.gen(function* () {
    if (!(yield* isRepository(root))) {
      return yield* Effect.fail(invalid("This folder is not a git repository."));
    }
  });

/** `HEAD`, or the empty tree while the repository has no commit yet. */
const headOrEmptyTree = (root: string) =>
  Effect.gen(function* () {
    const head = yield* run(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
      allowNonZeroExit: true,
    });
    if (head.exitCode === 0) {
      return "HEAD";
    }
    const empty = yield* run(root, ["hash-object", "-t", "tree", "--stdin"], { stdin: "" });
    return empty.stdout.trim();
  });

/** The text of an untracked file for the prompt, or null when it is binary or too large. */
const untrackedText = (root: string, path: string): string | null => {
  try {
    const absolute = nodePath.join(root, path);
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size > UNTRACKED_READ_LIMIT) {
      return null;
    }
    const text = readFileSync(absolute, "utf8");
    return text.includes("\0") ? null : capText(text, UNTRACKED_FILE_CAP);
  } catch {
    return null;
  }
};

// ── Commit ─────────────────────────────────────────────────────

export interface CommitContext {
  /** One line per changed path, as `--name-status` prints it; untracked ones as `A`. */
  readonly files: ReadonlyArray<string>;
  readonly patch: string;
}

/**
 * The change a commit of `paths` (every changed path when absent) would
 * record: the working tree against `HEAD`, plus the untracked files with their
 * contents. `invalid` when there is nothing to describe.
 */
export const commitContext = (
  root: string,
  paths: ReadonlyArray<string> | undefined,
): Effect.Effect<CommitContext, PoseidonRpcError | GitError> =>
  Effect.gen(function* () {
    yield* mustBeRepository(root);
    const from = yield* headOrEmptyTree(root);
    const pathspec = paths === undefined || paths.length === 0 ? [] : ["--", ...paths];
    const git = (args: ReadonlyArray<string>) =>
      run(root, ["--literal-pathspecs", ...args, ...pathspec]).pipe(Effect.map((r) => r.stdout));
    const tracked = lines(yield* git(["diff", ...DIFF_FLAGS, "--name-status", from]));
    const patch = yield* git(["diff", ...DIFF_FLAGS, from]);
    const untracked = (yield* git(["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter((path) => path !== "");
    if (tracked.length === 0 && untracked.length === 0) {
      return yield* Effect.fail(invalid("There are no changes to write a message for."));
    }
    const added = untracked.slice(0, UNTRACKED_FILES).map((path) => {
      const text = untrackedText(root, path);
      return `--- /dev/null\n+++ b/${path}\n${text === null ? "(binary or too large to show)" : text}`;
    });
    return {
      files: [...tracked, ...untracked.map((path) => `A\t${path}`)],
      patch: capText(
        [patch.trimEnd(), ...added].filter((part) => part !== "").join("\n"),
        PATCH_CAP,
      ),
    };
  });

// ── Pull request ───────────────────────────────────────────────

export interface PullRequestContext {
  readonly base: string;
  readonly branch: string | null;
  readonly commits: string;
  readonly patch: string;
}

/**
 * The base a pull request is written against: the one asked for, else the
 * branch the thread's worktree was cut from, else the repository's default.
 */
export const pullRequestBase = (
  root: string,
  requested: string | undefined,
  worktreeBase: string | undefined,
): Effect.Effect<string, PoseidonRpcError | GitError> =>
  Effect.gen(function* () {
    const base = requested ?? worktreeBase ?? (yield* listBranches(root)).defaultBranch;
    if (base === null) {
      return yield* Effect.fail(invalid("There is no base branch to compare this branch with."));
    }
    return yield* validRef(base, "base");
  });

/**
 * What a pull request of the current branch into `base` carries: its commits
 * beyond the base and its diff against where it forked. `invalid` when the
 * base is unknown or the branch has nothing on top of it.
 */
export const pullRequestContext = (
  root: string,
  base: string,
): Effect.Effect<PullRequestContext, PoseidonRpcError | GitError> =>
  Effect.gen(function* () {
    yield* mustBeRepository(root);
    const known = yield* run(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], {
      allowNonZeroExit: true,
    });
    if (known.exitCode !== 0) {
      return yield* Effect.fail(invalid(`There is no branch "${base}" to compare with.`));
    }
    const log = yield* run(root, [
      "log",
      "--no-merges",
      `-n${BRANCH_COMMITS}`,
      "--format=- %s%n%w(0,2,2)%b",
      `${base}..HEAD`,
    ]);
    const patch = yield* run(root, ["diff", ...DIFF_FLAGS, `${base}...HEAD`]);
    if (log.stdout.trim() === "" && patch.stdout.trim() === "") {
      return yield* Effect.fail(invalid(`This branch has no changes against ${base} to describe.`));
    }
    return {
      base,
      branch: yield* currentBranch(root),
      commits: capText(lines(log.stdout).join("\n"), SUMMARY_CAP),
      patch: capText(patch.stdout, PATCH_CAP),
    };
  });

// ── Style ──────────────────────────────────────────────────────

/** The first agent notes file at the root: AGENTS.md, then CLAUDE.md. */
const agentNotes = (root: string): string | null => {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const text = readFileSync(nodePath.join(root, name), "utf8").trim();
      if (text !== "") return capText(text, SUMMARY_CAP);
    } catch {
      // Not there: try the next one.
    }
  }
  return null;
};

/**
 * What the style instruction is built from. The repository's own subjects
 * and notes are read only when the style needs them; a repository with no
 * commits yet has none. Never fails: a style with no context is still one.
 */
export const styleContext = (
  root: string,
  git: Pick<GitSettings, "writingStyle" | "customInstructions">,
): Effect.Effect<StyleContext> =>
  Effect.gen(function* () {
    const base = {
      style: git.writingStyle,
      customInstructions: git.customInstructions,
      recentSubjects: [] as ReadonlyArray<string>,
      agentNotes: null,
    };
    const needsRepository =
      git.writingStyle === "repository" ||
      (git.writingStyle === "custom" && git.customInstructions.trim() === "");
    if (!needsRepository) {
      return base;
    }
    const log = yield* run(root, ["log", `-n${STYLE_SUBJECTS}`, "--no-merges", "--format=%s"], {
      allowNonZeroExit: true,
    }).pipe(Effect.catch(() => Effect.succeed({ stdout: "", exitCode: 1 })));
    return {
      ...base,
      recentSubjects: log.exitCode === 0 ? lines(log.stdout) : [],
      agentNotes: agentNotes(root),
    };
  });
