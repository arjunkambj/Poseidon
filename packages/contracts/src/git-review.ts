/**
 * The Changes pane's review writes and reads beyond the diff itself: discard
 * a file's change, and blame the lines of one.
 *
 * Kept apart from `rpc.ts` for the same reason `git.ts` is: the method names
 * are spread into `RPC_METHODS`, and `rpc.ts` lists the RPCs in
 * `PoseidonRpcGroup`. Paths here are the ones `git.diff` answers with —
 * relative to the repository's top level, not the workspace root — and the
 * server refuses anything that could reach outside that top level.
 */

import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { NonEmptyString } from "./base";
import { ProjectId, ThreadId } from "./ids";
import { PoseidonRpcError } from "./rpcError";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * The most lines one `git.blame` answers for. A call without a range blames
 * the first this many lines of the file; a range is cut to this many.
 */
export const GIT_BLAME_MAX_LINES = 5000;

/**
 * A run of consecutive lines last changed by one commit. `startLine` is the
 * line in the working file (1-based). `uncommitted` lines are the working
 * tree's own, not in any commit yet: their `sha` is all zeros and their
 * author reads "Not committed yet". `time` is the author time, as ISO-8601.
 */
export const GitBlameEntry = Schema.Struct({
  sha: NonEmptyString,
  author: Schema.String,
  time: Schema.String,
  summary: Schema.String,
  uncommitted: Schema.Boolean,
  startLine: PositiveInt,
  lineCount: PositiveInt,
});
export type GitBlameEntry = typeof GitBlameEntry.Type;

/**
 * The blame of one file, in line order. `untracked` is true for a file git
 * does not track, which has no history to show: its `entries` are empty.
 */
export const GitBlame = Schema.Struct({
  path: NonEmptyString,
  untracked: Schema.Boolean,
  entries: Schema.Array(GitBlameEntry),
});
export type GitBlame = typeof GitBlame.Type;

// ── Method names and RPCs ──────────────────────────────────────

/** Spread into `RPC_METHODS`, so the names stay in the one table. */
export const GIT_REVIEW_RPC_METHODS = {
  gitDiscard: "git.discard",
  gitBlame: "git.blame",
} as const;

/**
 * Throws away the working tree's change to `paths`, bringing each back to the
 * comparison's base: the `source` ref (a turn's `from` checkpoint), else the
 * fork point of `HEAD` and `mergeBase` (the branch scope), else `HEAD` — where
 * the index is reset as well. A path the base does not have is removed: from
 * the index and the disk when git tracks it, from the disk when it is
 * untracked; an ignored file is never touched, and a folder is refused
 * (`invalid`) rather than restored or deleted whole. A rename is discarded by
 * naming both of its paths.
 *
 * Omitting `paths` discards everything uncommitted in the repository — every
 * tracked change back to `HEAD` and every untracked, non-ignored file deleted
 * — and is allowed only without `source` and `mergeBase`. `invalid` for a path
 * that is absolute, climbs out with `..`, or starts with `-`, and `conflict`
 * while a turn or a restore runs in that workspace.
 */
export const GitDiscardRpc = Rpc.make(GIT_REVIEW_RPC_METHODS.gitDiscard, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    paths: Schema.optional(Schema.NonEmptyArray(NonEmptyString)),
    source: Schema.optional(NonEmptyString),
    mergeBase: Schema.optional(NonEmptyString),
  }),
  success: Schema.Struct({}),
  error: PoseidonRpcError,
});

/**
 * `git blame` of the working file at `path`, optionally only lines
 * `startLine`..`endLine` (1-based, inclusive; an end past the file is cut to
 * its last line). At most `GIT_BLAME_MAX_LINES` lines are blamed per call.
 */
export const GitBlameRpc = Rpc.make(GIT_REVIEW_RPC_METHODS.gitBlame, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    path: NonEmptyString,
    startLine: Schema.optional(PositiveInt),
    endLine: Schema.optional(PositiveInt),
  }),
  success: GitBlame,
  error: PoseidonRpcError,
});
