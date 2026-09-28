/**
 * The editors, file manager and terminal a workspace can be opened in, and the
 * two RPCs that list them and open a folder or file in one.
 *
 * Kept apart from `rpc.ts` for the same reason `git.ts` is: the method names
 * are spread into `RPC_METHODS`, and `rpc.ts` lists the RPCs in
 * `PoseidonRpcGroup`. The server decides what is installed and builds every
 * launch itself; a client names an editor by id and a path relative to the
 * workspace root, never a command.
 */

import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { NonEmptyString } from "./base";
import { ProjectId, ThreadId } from "./ids";
import { PoseidonRpcError } from "./rpcError";

/**
 * Every app the server knows how to launch. `finder` is the platform's file
 * manager (Finder, Explorer, or whatever `xdg-open` hands a folder to) and
 * `terminal` the platform's terminal app; the server labels both per platform.
 */
export const EditorId = Schema.Literals([
  "vscode",
  "vscode-insiders",
  "cursor",
  "windsurf",
  "zed",
  "sublime",
  "finder",
  "terminal",
]);
export type EditorId = typeof EditorId.Type;

export const EditorKind = Schema.Literals(["editor", "file-manager", "terminal"]);
export type EditorKind = typeof EditorKind.Type;

/**
 * One app the server found installed. `supportsLine` is true when the server
 * can open a file at a line in it — only through the app's own CLI, so an
 * editor found by its app bundle alone opens files at their top.
 */
export const DetectedEditor = Schema.Struct({
  id: EditorId,
  label: NonEmptyString,
  kind: EditorKind,
  supportsLine: Schema.Boolean,
});
export type DetectedEditor = typeof DetectedEditor.Type;

// ── Method names and RPCs ──────────────────────────────────────

/** Spread into `RPC_METHODS`, so the names stay in the one table. */
export const EDITOR_RPC_METHODS = {
  editorsList: "editors.list",
  editorsOpen: "editors.open",
} as const;

/** The apps found on the server's machine: editors first, then the file manager and terminal. */
export const EditorsListRpc = Rpc.make(EDITOR_RPC_METHODS.editorsList, {
  payload: Schema.Struct({}),
  success: Schema.Array(DetectedEditor),
  error: PoseidonRpcError,
});

/**
 * Opens the workspace root, or a path inside it, in one detected app. The
 * root is the thread's when `threadId` names one of the project's threads,
 * the project's otherwise. `path` is relative to that root and omitted for
 * the root itself; one that escapes it — `..`, an absolute path elsewhere, a
 * symlink out — fails `invalid`, a missing one `not-found`, and an app the
 * server did not detect `unavailable`. `line` is honoured where the app
 * supports it; `reveal` selects the path in the file manager rather than
 * opening it.
 */
export const EditorsOpenRpc = Rpc.make(EDITOR_RPC_METHODS.editorsOpen, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    editor: EditorId,
    path: Schema.optional(Schema.String),
    line: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    reveal: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({}),
  error: PoseidonRpcError,
});
