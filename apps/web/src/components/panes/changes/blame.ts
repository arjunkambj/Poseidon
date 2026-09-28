/**
 * A `git.blame` answer as the Changes pane shows it, with no React in the
 * way: a file's blame as the commits that wrote it (`blameCommits`), one
 * line's blame (`blameAt`), and how long ago a commit was (`blameAge`).
 */

import type { GitBlameEntry } from "@poseidon/contracts/git-review";

import { relativeTime } from "@/lib/format";

/** One commit's share of a file: every run of lines it last changed, summed. */
export interface BlameCommit {
  readonly sha: string;
  /** The first seven characters, as `git log --oneline` prints them. */
  readonly shortSha: string;
  readonly author: string;
  readonly time: string;
  readonly summary: string;
  readonly uncommitted: boolean;
  readonly lines: number;
}

/**
 * The commits behind a file's lines, one row per commit however many runs it
 * has: the working tree's own lines first, then newest first by author time.
 */
export const blameCommits = (entries: ReadonlyArray<GitBlameEntry>): ReadonlyArray<BlameCommit> => {
  const bySha = new Map<string, BlameCommit>();
  for (const entry of entries) {
    const seen = bySha.get(entry.sha);
    bySha.set(
      entry.sha,
      seen === undefined
        ? {
            sha: entry.sha,
            shortSha: entry.sha.slice(0, 7),
            author: entry.author,
            time: entry.time,
            summary: entry.summary,
            uncommitted: entry.uncommitted,
            lines: entry.lineCount,
          }
        : { ...seen, lines: seen.lines + entry.lineCount },
    );
  }
  const at = (commit: BlameCommit) => {
    const ms = Date.parse(commit.time);
    return Number.isNaN(ms) ? 0 : ms;
  };
  return [...bySha.values()].sort(
    (a, b) => Number(b.uncommitted) - Number(a.uncommitted) || at(b) - at(a),
  );
};

/** The entry that covers `line` (1-based), or `undefined` past the blamed lines. */
export const blameAt = (
  entries: ReadonlyArray<GitBlameEntry>,
  line: number,
): GitBlameEntry | undefined =>
  entries.find((entry) => line >= entry.startLine && line < entry.startLine + entry.lineCount);

/**
 * How long ago a commit was, for a blame row: "just now", "5m ago", "3d ago",
 * and past a year the month it happened, "Mar 2025". Empty for a time git
 * did not give.
 */
export const blameAge = (nowMs: number, iso: string): string => {
  const ago = relativeTime(nowMs, iso);
  if (ago === "now") {
    return "just now";
  }
  return /^\d/.test(ago) ? `${ago} ago` : ago;
};
