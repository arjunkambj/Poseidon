/**
 * A project's runnable scripts: the ones saved in its settings, and the
 * package.json scripts the server finds in its workspace, with the RPC that
 * lists the second kind.
 *
 * Kept apart from `rpc.ts` for the same reason `editors.ts` is: the method
 * name is spread into `RPC_METHODS`, and `rpc.ts` lists the RPC in
 * `PoseidonRpcGroup`. A detected script's `command` is built by the server
 * from the package manager it found and the package's directory; the client
 * runs it as it is, in a terminal (`terminal.open`'s `script`).
 */

import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { NonEmptyString } from "./base";
import { ProjectId, ThreadId } from "./ids";
import { PoseidonRpcError } from "./rpcError";
import { TERMINAL_SCRIPT_COMMAND_MAX_CHARS } from "./terminal";

/**
 * A script saved in a project's settings. `command` runs through the user's
 * login shell in the workspace root; `primary` marks the one the Run button
 * starts, and at most one script of a project should carry it — the first
 * marked one wins when several do.
 */
export const ProjectScript = Schema.Struct({
  id: NonEmptyString,
  name: NonEmptyString,
  command: NonEmptyString.check(Schema.isMaxLength(TERMINAL_SCRIPT_COMMAND_MAX_CHARS)),
  primary: Schema.optional(Schema.Boolean),
});
export type ProjectScript = typeof ProjectScript.Type;

/** The package manager a workspace uses, read off `packageManager` or its lockfile. */
export const PackageManager = Schema.Literals(["npm", "pnpm", "yarn", "bun"]);
export type PackageManager = typeof PackageManager.Type;

/**
 * One `scripts` entry of a package.json in the workspace: the root's, or a
 * monorepo package's. `id` is stable across listings (`pkg:<dir>:<name>`),
 * `packageDir` is relative to the workspace root with `""` for the root, and
 * `command` is ready to run from the root — `pnpm run dev`, or
 * `cd 'apps/web' && pnpm run dev` for a nested package.
 */
export const DetectedScript = Schema.Struct({
  id: NonEmptyString,
  name: NonEmptyString,
  packageName: Schema.NullOr(Schema.String),
  packageDir: Schema.String,
  command: NonEmptyString,
  packageManager: PackageManager,
});
export type DetectedScript = typeof DetectedScript.Type;

// ── Method names and RPCs ──────────────────────────────────────

/** Spread into `RPC_METHODS`, so the names stay in the one table. */
export const SCRIPT_RPC_METHODS = {
  scriptsDetect: "scripts.detect",
} as const;

/**
 * The package.json scripts of the workspace root and of every monorepo
 * package it declares (pnpm-workspace.yaml, or package.json `workspaces`),
 * root first and then by directory. The root is the thread's when `threadId`
 * names one of the project's threads, the project's otherwise; an unknown
 * project fails `not-found`, and a workspace with no package.json lists none.
 */
export const ScriptsDetectRpc = Rpc.make(SCRIPT_RPC_METHODS.scriptsDetect, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
  }),
  success: Schema.Array(DetectedScript),
  error: PoseidonRpcError,
});
