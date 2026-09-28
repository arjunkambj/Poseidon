/**
 * The Changes pane's review writes beyond the diff itself: discard a file's
 * change.
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

// ── Method names and RPCs ──────────────────────────────────────

/** Spread into `RPC_METHODS`, so the names stay in the one table. */
export const GIT_REVIEW_RPC_METHODS = {
  gitDiscard: "git.discard",
} as const;

/**
 * Throws away the working tree's change to `paths`, bringing each back to the
 * comparison's base: the `source` ref (a turn's `from` checkpoint), else the
 * fork point of `HEAD` and `mergeBase` (the branch scope), else `HEAD` — where
 * the index is reset as well. A path the base does not have is removed: from
 * the index and the disk when git tracks it, from the disk when it is
 * untracked; an ignored file is never touched. A rename is discarded by
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
