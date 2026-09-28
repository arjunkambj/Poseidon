/**
 * Optional things a connector instance can manage besides sessions.
 *
 * Some harnesses keep user-facing configuration of their own — skills in a
 * skills directory, installed plugins, MCP servers in a JSON file — and the
 * Customize page and the composer's menus read and edit it — and the session
 * files it records, which an import reads. The file formats and locations
 * belong to the harness, so the code that reads and writes them lives in the
 * connector, behind these interfaces. An instance that has none of it leaves
 * `extensions` out, and the server answers the matching RPCs with
 * `unavailable`.
 *
 * Extensions know nothing about projects or RPCs: the server resolves a
 * project to its workspace root before calling, and maps
 * `ConnectorExtensionFailed` onto its own error. `workspaceRoot: null` means
 * the user scope alone.
 */

import type {
  AgentSkill,
  McpServerConfig,
  McpServerScope,
  PluginSummary,
  SkillSummary,
} from "@poseidon/contracts/connectors";
import type { HarnessCommand } from "@poseidon/contracts/harnessCommands";
import type { ImportableSession } from "@poseidon/contracts/sessionImport";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

/**
 * Why an extension call failed. `code` is what the renderer switches on —
 * the same vocabulary as the RPC error, minus `unavailable`, which is the
 * server's answer for an instance that has no extension at all.
 */
export class ConnectorExtensionFailed extends Data.TaggedError("ConnectorExtensionFailed")<{
  readonly code: "conflict" | "not-found" | "invalid" | "internal";
  readonly message: string;
}> {}

/** What a call is resolved against: the user scope, plus one project when set. */
export interface ExtensionScope {
  readonly workspaceRoot: string | null;
}

/**
 * Skills the harness loads. `available` and `link` are the optional second
 * half: skills in a shared folder the harness does not load yet, and linking
 * one in. An extension without them has nothing to offer there.
 */
export interface SkillsExtension {
  readonly list: (
    scope: ExtensionScope,
  ) => Effect.Effect<ReadonlyArray<SkillSummary>, ConnectorExtensionFailed>;
  readonly available?: Effect.Effect<ReadonlyArray<AgentSkill>, ConnectorExtensionFailed>;
  /** Links one `available` entry in; answers the new `available` list. */
  readonly link?: (
    entry: string,
  ) => Effect.Effect<ReadonlyArray<AgentSkill>, ConnectorExtensionFailed>;
}

/**
 * Plugins the harness has installed, in the user scope plus the project's
 * when one is set. Read-only: installing and removing stay with the harness.
 */
export interface PluginsExtension {
  readonly list: (
    scope: ExtensionScope,
  ) => Effect.Effect<ReadonlyArray<PluginSummary>, ConnectorExtensionFailed>;
}

/**
 * MCP servers in the harness's own config. `add` is an upsert keyed by the
 * server's scope and name; every call answers the whole list for the scope.
 */
export interface McpServersExtension {
  readonly list: (
    scope: ExtensionScope,
  ) => Effect.Effect<ReadonlyArray<McpServerConfig>, ConnectorExtensionFailed>;
  readonly add: (
    scope: ExtensionScope,
    server: McpServerConfig,
  ) => Effect.Effect<ReadonlyArray<McpServerConfig>, ConnectorExtensionFailed>;
  readonly remove: (
    scope: ExtensionScope,
    serverScope: McpServerScope,
    name: string,
  ) => Effect.Effect<ReadonlyArray<McpServerConfig>, ConnectorExtensionFailed>;
}

/**
 * The harness's own slash commands — the ones it runs itself when a message
 * starts with `/name` — for the composer's `/` menu. Read-only, and only the
 * commands the harness can name truthfully: an instance that cannot list them
 * leaves this out rather than guessing.
 */
export interface CommandsExtension {
  readonly list: (
    scope: ExtensionScope,
  ) => Effect.Effect<ReadonlyArray<HarnessCommand>, ConnectorExtensionFailed>;
}

/** One message of an imported transcript: what was said, never the tools. */
export interface ImportedMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp?: string;
}

/**
 * One session read back for an import. `messages` are its newest ones, within
 * the reader's caps, oldest first; `session.messageCount` counts them all.
 * `sessionRef` is exactly what this connector's own `resumeSession` accepts,
 * so a thread bound to it carries the harness's conversation on.
 */
export interface ImportedTranscript {
  readonly session: ImportableSession;
  readonly messages: ReadonlyArray<ImportedMessage>;
  readonly sessionRef: unknown;
}

/**
 * Sessions the harness recorded on its own, read from its session files for
 * an import. Read-only: a reader opens those files for reading and writes
 * nothing, beside them or anywhere. `list` answers the newest `limit`
 * sessions, newest first, and `[]` when the harness has none; `read` fails
 * `not-found` for an id it has no file for.
 */
export interface SessionsExtension {
  readonly list: (options: {
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ImportableSession>, ConnectorExtensionFailed>;
  readonly read: (sourceId: string) => Effect.Effect<ImportedTranscript, ConnectorExtensionFailed>;
  /**
   * The `sourceId` of the session a thread's persisted `sessionRef` names, or
   * `undefined` when it names none this reader lists. Poseidon's own threads
   * run their sessions in the harness's usual session folders, so this is how
   * a list tells those apart from sessions the harness ran on its own.
   */
  readonly sourceIdOf?: (sessionRef: unknown) => string | undefined;
}

/** Every extension an instance may carry; each one is optional. */
export interface ConnectorExtensions {
  readonly skills?: SkillsExtension;
  readonly plugins?: PluginsExtension;
  readonly mcpServers?: McpServersExtension;
  readonly commands?: CommandsExtension;
  readonly sessions?: SessionsExtension;
}
