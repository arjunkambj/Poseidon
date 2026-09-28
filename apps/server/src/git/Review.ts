/**
 * Discard and blame: the Changes pane's two git calls beyond the diff.
 *
 * Like `Commits.ts`, this is the git half only. `Git.ts` resolves the
 * workspace root, refuses a discard while a turn or a restore runs in it and
 * hands over the repository's top level; everything here runs from that top
 * level, because the paths the pane sends are the ones `git.diff` answered
 * with, which are relative to it and not to the workspace root.
 *
 * A discard deletes work, so every path is checked before git sees it
 * (`validPath`), reaches git only as a `:(literal)` pathspec after `--`, and a
 * file is deleted from disk only when git itself lists it as untracked and
 * not ignored. Nothing here ever runs `git clean`.
 */
import { lstatSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import * as nodePath from "node:path";
import type { GitBlame, GitBlameEntry } from "@poseidon/contracts/git-review";
import * as Effect from "effect/Effect";

import { GIT_BLAME_MAX_LINES } from "@poseidon/contracts/git-review";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";

import { mergeBaseOf, validRef } from "./Branches";
import { GitError, run } from "./process";

const invalid = (message: string) => new PoseidonRpcError({ code: "invalid", message });

/** The repository's top level for a root inside it: where review paths are rooted. */
export const repositoryTop = (root: string) =>
  run(root, ["rev-parse", "--show-toplevel"]).pipe(
    Effect.map((result) => result.stdout.replace(/\n$/, "")),
  );

/**
 * A top-relative path a review call may act on, or `invalid`. It must be in
 * the normal form git prints (no `./`, no doubled or trailing `/`), relative,
 * free of NUL and backslashes, with no `..` segment and no leading `-`, never
 * inside `.git`, and must resolve inside `top`.
 */
const validPath = (top: string, path: string): Effect.Effect<string, PoseidonRpcError> => {
  const segments = path.split("/");
  const safe =
    path.length > 0 &&
    !path.startsWith("-") &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !nodePath.posix.isAbsolute(path) &&
    !nodePath.win32.isAbsolute(path) &&
    nodePath.posix.normalize(path) === path &&
    !path.endsWith("/") &&
    !segments.includes("..") &&
    !segments.includes(".") &&
    segments[0] !== ".git";
  if (!safe) return Effect.fail(invalid(`invalid path: ${path}`));
  const resolved = nodePath.resolve(top, path);
  return resolved.startsWith(`${nodePath.resolve(top)}${nodePath.sep}`)
    ? Effect.succeed(path)
    : Effect.fail(invalid(`path is outside the repository: ${path}`));
};

const literal = (path: string) => `:(literal)${path}`;

/** Whether `ls-files` with these flags lists exactly `path`. */
const listed = (top: string, flags: ReadonlyArray<string>, path: string) =>
  run(top, ["ls-files", ...flags, "-z", "--", literal(path)]).pipe(
    Effect.map((result) => result.stdout.split("\0").includes(path)),
  );

const isTracked = (top: string, path: string) => listed(top, ["--cached"], path);
const isUntracked = (top: string, path: string) =>
  listed(top, ["--others", "--exclude-standard"], path);

/**
 * What `ref` has at `path`: a `file` (a blob, which covers symlinks, or a
 * submodule's commit), a `folder` (a tree), or `none`.
 */
const entryIn = (top: string, ref: string, path: string) =>
  run(top, ["cat-file", "-t", `${ref}:${path}`], { allowNonZeroExit: true }).pipe(
    Effect.map((result): "file" | "folder" | "none" => {
      if (result.exitCode !== 0) return "none";
      const type = result.stdout.trim();
      return type === "tree" ? "folder" : type === "blob" || type === "commit" ? "file" : "none";
    }),
  );

const fsError = (command: string, top: string, error: unknown) =>
  new GitError({
    command,
    cwd: top,
    exitCode: null,
    message: error instanceof Error ? error.message : String(error),
  });

/**
 * Deletes one untracked file, then every parent directory the deletion left
 * empty, up to (never including) `top`, the way git would not list them
 * either. A directory — an untracked nested repository — is left alone.
 */
const deleteUntracked = (top: string, path: string) =>
  Effect.try({
    try: () => {
      const root = nodePath.resolve(top);
      const absolute = nodePath.join(root, path);
      if (lstatSync(absolute).isDirectory()) return;
      unlinkSync(absolute);
      for (let dir = nodePath.dirname(absolute); dir.startsWith(`${root}${nodePath.sep}`);) {
        try {
          rmdirSync(dir);
        } catch {
          break; // not empty: everything above it is not either
        }
        dir = nodePath.dirname(dir);
      }
    },
    catch: (error) => fsError(`delete ${path}`, top, error),
  });

/** What a discard restores to: a commit, and whether the index follows it. */
export interface DiscardBase {
  readonly ref: string;
  /** Only against `HEAD`: the index is reset too, so a staged change goes as well. */
  readonly resetIndex: boolean;
}

/**
 * The base a discard restores to: the `source` ref (a turn's checkpoint),
 * else the fork point of `HEAD` and `mergeBase`, else `HEAD`. `invalid` for a
 * ref that is malformed or names no commit, or for both at once.
 */
export const discardBase = (
  top: string,
  options: { readonly source?: string | undefined; readonly mergeBase?: string | undefined },
) =>
  Effect.gen(function* () {
    if (options.source !== undefined && options.mergeBase !== undefined) {
      return yield* Effect.fail(invalid("a discard takes a `source` or a `mergeBase`, not both"));
    }
    if (options.mergeBase !== undefined) {
      return { ref: yield* mergeBaseOf(top, options.mergeBase), resetIndex: false };
    }
    const ref = options.source === undefined ? "HEAD" : yield* validRef(options.source, "source");
    const verified = yield* run(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      allowNonZeroExit: true,
    });
    if (verified.exitCode !== 0) {
      return yield* Effect.fail(
        invalid(
          options.source === undefined
            ? "The repository has no commits yet — there is nothing to restore to."
            : `No commit to restore to at ${ref}.`,
        ),
      );
    }
    return { ref, resetIndex: options.source === undefined };
  });

/**
 * One file back to `base`: restored when the base has a file there; otherwise
 * deleted when untracked, or removed from the index and the disk when
 * tracked. A folder — on disk or in the base — is refused, never restored or
 * deleted as a whole, and so is a path that is on disk but ignored. A file
 * that replaced a base folder is deleted like any file the base lacks.
 */
const discardPath = (top: string, base: DiscardBase, path: string) =>
  Effect.gen(function* () {
    const inBase = yield* entryIn(top, base.ref, path);
    if (inBase === "file") {
      yield* run(top, [
        "restore",
        `--source=${base.ref}`,
        "--worktree",
        ...(base.resetIndex ? ["--staged"] : []),
        "--",
        literal(path),
      ]);
      return;
    }
    if (yield* isUntracked(top, path)) {
      yield* deleteUntracked(top, path);
      return;
    }
    if (yield* isTracked(top, path)) {
      yield* run(top, ["rm", "-q", "-f", "--", literal(path)]);
      return;
    }
    const onDisk = yield* Effect.sync(() => {
      try {
        return lstatSync(nodePath.join(top, path)).isDirectory() ? "folder" : "file";
      } catch {
        return "none";
      }
    });
    if (onDisk === "folder" || inBase === "folder") {
      return yield* Effect.fail(invalid(`${path} is a folder — only files can be discarded.`));
    }
    if (onDisk === "file") {
      return yield* Effect.fail(invalid(`${path} is ignored by git — it was not discarded.`));
    }
    // Neither in the base nor anywhere now: already what the base has.
  });

/**
 * Every uncommitted change in the repository, gone: tracked and staged work
 * back to `HEAD`, and exactly the untracked files `ls-files --others
 * --exclude-standard` lists deleted — never an ignored file.
 */
const discardAll = (top: string) =>
  Effect.gen(function* () {
    const restored = yield* run(
      top,
      ["restore", "--source=HEAD", "--staged", "--worktree", "--", ":/"],
      { allowNonZeroExit: true },
    );
    // An empty HEAD tree with an empty index has nothing to restore.
    if (restored.exitCode !== 0 && !restored.stderr.includes("did not match")) {
      return yield* Effect.fail(
        new GitError({
          command: "git restore",
          cwd: top,
          exitCode: restored.exitCode,
          message: restored.stderr.trim(),
        }),
      );
    }
    const untracked = yield* run(top, ["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const path of untracked.stdout.split("\0")) {
      // `dir/` is an untracked nested repository: not a file to delete.
      if (path.length === 0 || path.endsWith("/")) continue;
      yield* deleteUntracked(top, path);
    }
  });

/**
 * Discards `paths` back to `base`, or every uncommitted change when `paths`
 * is omitted (only against `HEAD`). Every path is validated before anything
 * is touched.
 */
export const discard = (top: string, base: DiscardBase, paths: ReadonlyArray<string> | undefined) =>
  Effect.gen(function* () {
    if (paths === undefined) {
      if (!base.resetIndex) {
        return yield* Effect.fail(
          invalid("Discarding everything is only possible against HEAD — name the files."),
        );
      }
      return yield* discardAll(top);
    }
    const checked = yield* Effect.forEach(paths, (path) => validPath(top, path));
    for (const path of new Set(checked)) {
      yield* discardPath(top, base, path);
    }
  });

// ── Blame ──────────────────────────────────────────────────────

const ZERO_SHA = /^0+$/;
const HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/;

interface CommitInfo {
  author: string;
  time: string;
  summary: string;
}

/**
 * `git blame --porcelain`: per line a `<sha> <orig> <final> [<count>]`
 * header, the commit's fields the first time that commit appears, then the
 * line itself after a tab. Consecutive lines of one commit fold into one
 * entry.
 */
export const parsePorcelainBlame = (stdout: string): Array<GitBlameEntry> => {
  const commits = new Map<string, CommitInfo>();
  const entries: Array<GitBlameEntry> = [];
  let sha: string | null = null;
  let line = 0;
  for (const row of stdout.split("\n")) {
    if (sha === null) {
      const header = HEADER.exec(row);
      if (header === null) continue;
      sha = header[1]!;
      line = Number.parseInt(header[2]!, 10);
      if (!commits.has(sha)) commits.set(sha, { author: "", time: "", summary: "" });
      continue;
    }
    const info = commits.get(sha)!;
    if (row.startsWith("\t")) {
      const uncommitted = ZERO_SHA.test(sha);
      const last = entries[entries.length - 1];
      if (last !== undefined && last.sha === sha && last.startLine + last.lineCount === line) {
        entries[entries.length - 1] = { ...last, lineCount: last.lineCount + 1 };
      } else {
        entries.push({
          sha,
          author: uncommitted ? "Not committed yet" : info.author,
          time: info.time,
          summary: uncommitted ? "" : info.summary,
          uncommitted,
          startLine: line,
          lineCount: 1,
        });
      }
      sha = null;
    } else if (row.startsWith("author ")) {
      info.author = row.slice("author ".length);
    } else if (row.startsWith("author-time ")) {
      const seconds = Number.parseInt(row.slice("author-time ".length), 10);
      info.time = new Date(seconds * 1000).toISOString();
    } else if (row.startsWith("summary ")) {
      info.summary = row.slice("summary ".length);
    }
  }
  return entries;
};

/** Lines in a file's text: a last line without a newline still counts. */
const lineCountOf = (text: string) => {
  if (text.length === 0) return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
};

/**
 * The blame of the working file at `path`, lines `startLine`..`endLine`
 * (default: from the first line), never more than `GIT_BLAME_MAX_LINES` of
 * them. An untracked file has no history and answers `untracked: true`.
 */
export const blame = (
  top: string,
  path: string,
  range: { readonly startLine?: number | undefined; readonly endLine?: number | undefined },
): Effect.Effect<GitBlame, GitError | PoseidonRpcError> =>
  Effect.gen(function* () {
    const checked = yield* validPath(top, path);
    const start = range.startLine ?? 1;
    if (range.endLine !== undefined && range.endLine < start) {
      return yield* Effect.fail(invalid("endLine comes before startLine"));
    }
    if (!(yield* isTracked(top, checked))) {
      return { path: checked, untracked: true, entries: [] };
    }
    const text = yield* Effect.try({
      try: () => readFileSync(nodePath.join(top, checked), "utf8"),
      catch: () =>
        new PoseidonRpcError({ code: "not-found", message: `${checked} is not on disk` }),
    });
    const end = Math.min(
      range.endLine ?? Number.POSITIVE_INFINITY,
      start + GIT_BLAME_MAX_LINES - 1,
      lineCountOf(text),
    );
    if (end < start) return { path: checked, untracked: false, entries: [] };
    const result = yield* run(top, [
      "blame",
      "--porcelain",
      "-L",
      `${start},${end}`,
      "--",
      checked,
    ]);
    return { path: checked, untracked: false, entries: parsePorcelainBlame(result.stdout) };
  });
