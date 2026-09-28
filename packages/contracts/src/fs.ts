/**
 * The folder picker's payloads on the wire: what `fs.browse` answers and why it
 * refuses. `rpc.ts` re-exports every one, so importers keep reading them from
 * `@poseidon/contracts/rpc`.
 */

import * as Schema from "effect/Schema";

import { NonEmptyString } from "./base";

/**
 * One subdirectory inside a browsed directory. Files are never listed: this
 * surface exists to choose a *folder*, and the picker that reads it has nothing
 * to do with a file.
 *
 * `isGitRepo` is the badge the picker shows beside a repository, and it is
 * computed only for a real directory. A symlinked entry always reports `false`:
 * resolving it to look for `.git` would follow the link out of the directory
 * that was asked for, which is a traversal nobody asked for and a badge is not
 * worth it.
 */
export const FsEntry = Schema.Struct({
  name: NonEmptyString,
  path: NonEmptyString,
  isGitRepo: Schema.Boolean,
});
export type FsEntry = typeof FsEntry.Type;

/**
 * One directory as `fs.browse` answers it.
 *
 * `path` is the server's normalized, symlink-resolved absolute path — never the
 * string the client sent — so a breadcrumb built from it addresses the same
 * directory on the next call. `parent` is `null` at the root of the filesystem,
 * which is how the picker knows "up" has run out. `truncated` says the
 * directory holds more subfolders than `FS_BROWSE_ENTRY_LIMIT`, so the picker
 * can say so instead of implying the listing is complete.
 */
export const FsListing = Schema.Struct({
  path: NonEmptyString,
  parent: Schema.NullOr(NonEmptyString),
  entries: Schema.Array(FsEntry),
  truncated: Schema.Boolean,
});
export type FsListing = typeof FsListing.Type;

/**
 * The most subfolders one `fs.browse` answer carries. A directory with more
 * than this comes back truncated rather than turning a home folder full of
 * build output into a megabyte-sized frame.
 */
export const FS_BROWSE_ENTRY_LIMIT = 500;

/** Why a directory could not be listed, in the words the picker shows. */
export const FsBrowseFailure = Schema.Literals([
  "not-absolute",
  "not-found",
  "not-a-directory",
  "permission-denied",
  "internal",
]);
export type FsBrowseFailure = typeof FsBrowseFailure.Type;

/**
 * `fs.browse`'s own error, rather than the shared `PoseidonRpcError`: the picker
 * renders four of these five as a message *about the path the user typed* and
 * offers a different next step for each, which a single `invalid` code cannot
 * carry. `path` is the path the client asked for, echoed so a late answer can
 * be matched to the field it belongs to. Nothing else is carried — no cause, no
 * errno, no server-side path the client did not already name.
 */
export class FsBrowseError extends Schema.TaggedError<FsBrowseError>()("FsBrowseError", {
  reason: FsBrowseFailure,
  path: Schema.String,
  message: Schema.String,
}) {}
