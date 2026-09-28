/**
 * What one card on the Plugins page says, worked out apart from the markup so
 * it can be tested: the source badge, the contents line, whether the plugin
 * is broken, and whether its switch does anything.
 *
 * Poseidon's own plugins (built-in and global) are toggled here through
 * `plugins.setEnabled`. A harness's own plugins, such as the ones a CLI
 * installed, are listed read-only: that harness owns their on/off state.
 */

import type { PluginSummary } from "@poseidon/contracts/connectors";
import type { PluginContents, PluginId, PoseidonPlugin } from "@poseidon/contracts/plugins";

export interface PluginCardModel {
  /** Unique within the page. */
  readonly key: string;
  readonly name: string;
  readonly description: string | undefined;
  /** "Built-in", "Global", or the harness that owns the plugin. */
  readonly sourceLabel: string;
  /** "2 skills · 1 MCP server", empty when there is nothing to count. */
  readonly contents: string;
  readonly enabled: boolean;
  /** Why the plugin failed validation; the card shows it and cannot be turned on. */
  readonly error: string | undefined;
  /** The id the switch toggles, `null` when the switch is read-only. */
  readonly pluginId: PluginId | null;
}

const count = (n: number, one: string, many: string): string | null =>
  n === 0 ? null : `${n} ${n === 1 ? one : many}`;

/** The contents line: each non-zero part, in a fixed order, joined with a dot. */
export const contentsLine = (contents: PluginContents): string =>
  [
    count(contents.skills.length, "skill", "skills"),
    count(contents.mcpServers.length, "MCP server", "MCP servers"),
    count(contents.commands, "command", "commands"),
    count(contents.agents, "agent", "agents"),
    contents.hooks ? "hooks" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

export const sourceLabel = (source: PoseidonPlugin["source"]): string =>
  source === "builtin" ? "Built-in" : "Global";

export const poseidonPluginCard = (plugin: PoseidonPlugin): PluginCardModel => ({
  key: plugin.pluginId,
  name: plugin.name,
  description: plugin.description,
  sourceLabel: sourceLabel(plugin.source),
  contents: plugin.error === undefined ? contentsLine(plugin.contents) : "",
  enabled: plugin.error === undefined && plugin.enabled,
  error: plugin.error,
  pluginId: plugin.pluginId,
});

/**
 * A plugin a harness installed itself. Its summary carries no contents, so
 * the line names where it came from and its install scope instead.
 */
export const harnessPluginCard = (
  plugin: PluginSummary,
  owner: string,
  instanceKey: string,
): PluginCardModel => ({
  key: `${instanceKey}:${plugin.source ?? ""}:${plugin.scope ?? ""}:${plugin.name}`,
  name: plugin.name,
  description: plugin.description,
  sourceLabel: owner,
  contents: [plugin.source, plugin.scope === undefined ? undefined : `${plugin.scope} scope`]
    .filter((part) => part !== undefined)
    .join(" · "),
  enabled: plugin.enabled,
  error: undefined,
  pluginId: null,
});

/** Poseidon's plugins split for the page: built-in and global, each in list order. */
export const splitBySource = (
  plugins: ReadonlyArray<PoseidonPlugin>,
): {
  readonly builtin: ReadonlyArray<PoseidonPlugin>;
  readonly global: ReadonlyArray<PoseidonPlugin>;
} => ({
  builtin: plugins.filter((plugin) => plugin.source === "builtin"),
  global: plugins.filter((plugin) => plugin.source === "global"),
});
