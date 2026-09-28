/**
 * Sessions a harness recorded on its own, outside Poseidon, that can be
 * brought in as threads. Each connector that can read its harness's session
 * files lists them through its `sessions` extension
 * (`@poseidon/connector-sdk/extensions`); the file formats and the harness's
 * own session reference stay inside that connector, so this is all the wire
 * ever carries about one.
 */

import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { IsoDateTime, NonEmptyString, NonNegativeInt } from "./base";
import { ConnectorInstanceId, ConnectorKind, ProjectId, ThreadId } from "./ids";
import { PoseidonRpcError } from "./rpcError";

/**
 * One session, as the list names it. `sourceId` is the harness's own id for
 * it, the key an import asks for; `cwd` is the directory it ran in, which a
 * resume must run in too. `title` is the harness's title when it keeps one,
 * else the first prompt, shortened. `startedAt` is its first record's time and
 * `updatedAt` the file's last write.
 *
 * `messageCount` counts its user and assistant messages. A list reads only
 * the head of each file, so a listing stays cheap however long the sessions
 * are; it gives the count only when the whole file fit in that head, and
 * leaves it out rather than give a short one. Reading a session always
 * counts them all.
 */
export const ImportableSession = Schema.Struct({
  sourceId: NonEmptyString,
  cwd: NonEmptyString,
  title: NonEmptyString,
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  messageCount: Schema.optional(NonNegativeInt),
});
export type ImportableSession = typeof ImportableSession.Type;

/**
 * One session as `sessions.importable` lists it: the session, the connector
 * instance whose files it came from (`connectorName` is that instance's name
 * as the connectors page shows it), the project already open on its `cwd`
 * when there is one, and the thread that already holds it while that thread
 * still exists: the one an earlier import made of it, or a thread of
 * Poseidon's own whose session runs it.
 */
export const ImportableSessionEntry = Schema.Struct({
  ...ImportableSession.fields,
  connectorInstanceId: ConnectorInstanceId,
  connectorKind: ConnectorKind,
  connectorName: NonEmptyString,
  projectId: Schema.NullOr(ProjectId),
  importedThreadId: Schema.NullOr(ThreadId),
});
export type ImportableSessionEntry = typeof ImportableSessionEntry.Type;

/**
 * What an import made. `resumes` is true when the thread is bound to the
 * harness's own session, so its next turn carries that conversation on; false
 * when the instance cannot resume and the thread starts a fresh session.
 */
export const SessionImportResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  resumes: Schema.Boolean,
});
export type SessionImportResult = typeof SessionImportResult.Type;

// ── Method names and RPCs ──────────────────────────────────────

/** Spread into `RPC_METHODS`, so the names stay in the one table. */
export const SESSION_IMPORT_RPC_METHODS = {
  sessionsImportable: "sessions.importable",
  sessionsImport: "sessions.import",
} as const;

/**
 * The sessions every open instance with a `sessions` extension can import,
 * newest first. An instance whose files cannot be read is left out rather
 * than failing the list.
 */
const SessionsImportableRpc = Rpc.make(SESSION_IMPORT_RPC_METHODS.sessionsImportable, {
  payload: Schema.Struct({}),
  success: Schema.Array(ImportableSessionEntry),
  error: PoseidonRpcError,
});

/**
 * Brings one session in as a thread on the project for its `cwd` (added when
 * there is none yet), its messages as the thread's timeline. Importing a
 * session whose earlier import still exists answers that thread again.
 */
const SessionsImportRpc = Rpc.make(SESSION_IMPORT_RPC_METHODS.sessionsImport, {
  payload: Schema.Struct({
    connectorInstanceId: ConnectorInstanceId,
    sourceId: NonEmptyString,
  }),
  success: SessionImportResult,
  error: PoseidonRpcError,
});

/** Both RPCs, spread into `PoseidonRpcGroup`. */
export const SESSION_IMPORT_RPCS = [SessionsImportableRpc, SessionsImportRpc] as const;
