/**
 * Poseidon plugins on the wire: what the server's plugin registry found, and
 * the three RPCs that list plugins, turn one on or off, and open the folder
 * global plugins live in.
 *
 * A Poseidon plugin is a directory in the Claude Code plugin layout —
 * `.claude-plugin/plugin.json` plus `skills/`, `commands/`, `agents/`,
 * `hooks/` and `.mcp.json` — so an existing Claude Code plugin works
 * unchanged. The registry reads its manifest and counts its contents; which
 * harness loads which part is the connectors' business, not this module's.
 *
 * Kept apart from `rpc.ts` like `editors.ts`: the method names are spread into
 * `RPC_METHODS`, and `rpc.ts` lists the RPCs in `PoseidonRpcGroup`.
 */

import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { NonEmptyString, NonNegativeInt } from "./base";
import { PoseidonRpcError } from "./rpcError";

/**
 * Where a plugin came from. `builtin` ships with the app (the Browser plugin);
 * `global` is a directory the user put in `POSEIDON_HOME/plugins`.
 */
export const PluginSource = Schema.Literals(["builtin", "global"]);
export type PluginSource = typeof PluginSource.Type;

/**
 * A plugin's stable id: `builtin:<name>` for one the app ships, `global:<dir>`
 * for one in the global plugins folder, keyed by its directory name so a
 * manifest that fails to parse still has an id to show its error under. The
 * settings document's per-plugin overrides are keyed by it.
 */
export const PluginId = Schema.String.check(Schema.isPattern(/^(builtin|global):.+$/));
export type PluginId = typeof PluginId.Type;

/** One skill a plugin carries: a `skills/<name>/SKILL.md` folder. */
export const PluginSkill = Schema.Struct({
  name: NonEmptyString,
  description: Schema.optional(Schema.String),
});
export type PluginSkill = typeof PluginSkill.Type;

/**
 * What is inside a plugin. Skills and MCP servers are listed by name because
 * every harness gets them; commands and agents are only counted, and hooks
 * only noted, because not every harness can load them.
 */
export const PluginContents = Schema.Struct({
  skills: Schema.Array(PluginSkill),
  mcpServers: Schema.Array(NonEmptyString),
  commands: NonNegativeInt,
  agents: NonNegativeInt,
  hooks: Schema.Boolean,
});
export type PluginContents = typeof PluginContents.Type;

/**
 * One plugin the registry discovered. `path` is its absolute directory on the
 * server. `enabled` is the effective value: the settings override when there
 * is one, the plugin's default otherwise.
 *
 * A plugin that fails validation is still listed, never dropped: it carries
 * `error`, `enabled: false` and empty contents, so the plugins page can say
 * what is wrong with it. `warnings` are problems that did not stop it loading,
 * such as one malformed skill among good ones.
 */
export const PoseidonPlugin = Schema.Struct({
  pluginId: PluginId,
  name: NonEmptyString,
  description: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  source: PluginSource,
  path: NonEmptyString,
  enabled: Schema.Boolean,
  contents: PluginContents,
  error: Schema.optional(Schema.String),
  warnings: Schema.optional(Schema.Array(Schema.String)),
});
export type PoseidonPlugin = typeof PoseidonPlugin.Type;

/**
 * Every plugin the registry knows, built-in first, with the absolute global
 * plugins folder so an empty page can name where to put one.
 */
export const PluginsState = Schema.Struct({
  globalDir: Schema.String,
  plugins: Schema.Array(PoseidonPlugin),
});
export type PluginsState = typeof PluginsState.Type;

// ── Method names and RPCs ──────────────────────────────────────

/** Spread into `RPC_METHODS`, so the names stay in the one table. */
export const PLUGIN_RPC_METHODS = {
  pluginsList: "plugins.list",
  pluginsSetEnabled: "plugins.setEnabled",
  pluginsOpenFolder: "plugins.openFolder",
} as const;

/** Rescans the built-in and global plugins and answers what it found. */
export const PluginsListRpc = Rpc.make(PLUGIN_RPC_METHODS.pluginsList, {
  payload: Schema.Struct({}),
  success: PluginsState,
  error: PoseidonRpcError,
});

/**
 * Turns one plugin on or off for sessions started from now on, and answers the
 * state after the change. An id the registry does not know fails `not-found`;
 * a plugin that failed validation cannot be turned on and fails `invalid`.
 */
export const PluginsSetEnabledRpc = Rpc.make(PLUGIN_RPC_METHODS.pluginsSetEnabled, {
  payload: Schema.Struct({ pluginId: PluginId, enabled: Schema.Boolean }),
  success: PluginsState,
  error: PoseidonRpcError,
});

/** Creates the global plugins folder when it is missing and opens it in the file manager. */
export const PluginsOpenFolderRpc = Rpc.make(PLUGIN_RPC_METHODS.pluginsOpenFolder, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: PoseidonRpcError,
});
