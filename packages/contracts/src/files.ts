/**
 * The workspace file RPCs and their payloads on the wire: a `files.search`
 * hit, a `files.read` window, a `files.stat` answer and a `files.create`
 * result. `rpc.ts` re-exports every payload, so importers keep reading them
 * from `@poseidon/contracts/rpc`, and adds the RPCs to `PoseidonRpcGroup`.
 */

import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { NonEmptyString, NonNegativeInt } from "./base";
import { ProjectId, ThreadId } from "./ids";
import { PoseidonRpcError } from "./rpcError";

/** One hit from the composer's `#` file search. */
export const FileSearchResult = Schema.Struct({
  path: NonEmptyString,
  name: NonEmptyString,
  isDirectory: Schema.Boolean,
});
export type FileSearchResult = typeof FileSearchResult.Type;

/**
 * A file the client asked to read. `truncated` says the server stopped early —
 * the files pane shows a notice rather than pretending it has the whole file.
 */
export const FileContent = Schema.Struct({
  path: NonEmptyString,
  text: Schema.String,
  totalLines: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type FileContent = typeof FileContent.Type;

/** The most paths one `files.stat` call may ask about. */
export const FILES_STAT_MAX_PATHS = 100;

/**
 * One path `files.stat` confirmed: it exists, and it resolves — symlinks
 * followed — to somewhere strictly inside the workspace root. `path` is the
 * string as it was asked, so a caller maps answers back to its own
 * candidates; `relativePath` is the path under the root with `/` separators
 * (the link's own name when it went through an in-root symlink, which is the
 * name `files.read` accepts back); `absolutePath` joins that onto the root.
 */
export const FileStat = Schema.Struct({
  path: NonEmptyString,
  relativePath: NonEmptyString,
  absolutePath: NonEmptyString,
  isDirectory: Schema.Boolean,
});
export type FileStat = typeof FileStat.Type;

/** The one extension `files.create` writes: it saves notes such as a plan, never code. */
export const FILES_CREATE_EXTENSION = ".md";

/**
 * A file `files.create` wrote: `path` is where it now sits under the
 * workspace root, `/`-separated, as `files.read` takes it back.
 */
export const FileCreated = Schema.Struct({
  path: NonEmptyString,
});
export type FileCreated = typeof FileCreated.Type;

// ── Method names and RPCs ──────────────────────────────────────

/** Spread into `RPC_METHODS`, so the names stay in the one table. */
export const FILE_RPC_METHODS = {
  filesSearch: "files.search",
  filesRead: "files.read",
  filesStat: "files.stat",
  filesCreate: "files.create",
} as const;

/**
 * `threadId`, on this and the other workspace reads below, reads the thread's
 * own root — its worktree, when it has one — instead of the project's.
 */
export const FilesSearchRpc = Rpc.make(FILE_RPC_METHODS.filesSearch, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    query: Schema.String,
    limit: Schema.optional(NonNegativeInt),
  }),
  success: Schema.Array(FileSearchResult),
  error: PoseidonRpcError,
});

export const FilesReadRpc = Rpc.make(FILE_RPC_METHODS.filesRead, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    path: NonEmptyString,
    offset: Schema.optional(NonNegativeInt),
    limit: Schema.optional(NonNegativeInt),
  }),
  success: FileContent,
  error: PoseidonRpcError,
});

/**
 * Which of up to `FILES_STAT_MAX_PATHS` paths exist inside the workspace root.
 * A relative path resolves against the root, an absolute one counts only when
 * it lies inside it. A missing, escaping or unreadable path is left out of the
 * answer rather than failing the call, so one bad candidate never costs the
 * others theirs.
 */
export const FilesStatRpc = Rpc.make(FILE_RPC_METHODS.filesStat, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    paths: Schema.Array(NonEmptyString).check(Schema.isMaxLength(FILES_STAT_MAX_PATHS)),
  }),
  success: Schema.Array(FileStat),
  error: PoseidonRpcError,
});

/**
 * Writes a new Markdown file into the workspace — a plan saved from its card.
 * It only ever creates: `path` is relative to the root, stays inside it
 * (symlinks followed), ends in `FILES_CREATE_EXTENSION`, and must not exist
 * yet — an existing file fails `conflict` and is left as it was, anything
 * else refused fails `invalid`. Missing folders on the way are made.
 */
export const FilesCreateRpc = Rpc.make(FILE_RPC_METHODS.filesCreate, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    path: NonEmptyString,
    content: Schema.String,
  }),
  success: FileCreated,
  error: PoseidonRpcError,
});
