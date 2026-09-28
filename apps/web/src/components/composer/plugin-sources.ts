/**
 * The plugins behind the `@` menu: Poseidon's own, which every harness gets
 * (the built-in Browser plugin among them), ahead of the ones the thread's
 * instance has installed.
 *
 * Both lists go through `menuSource` first, so each keeps its loading and
 * failure reading: a failed Poseidon list is read like a failed instance
 * list. The menu only ever offers enabled plugins, so the merge keeps those,
 * and a name listed twice keeps its first row — Poseidon's, which is the one
 * a session of any harness loads.
 */

import type { PluginSummary } from "@poseidon/contracts/connectors";
import type { PluginsState } from "@poseidon/contracts/plugins";

import type { MenuSource, MenuSourceStatus } from "@/components/composer/menu-source";

/** What `PluginSummary.source` says for a Poseidon plugin. */
export const POSEIDON_PLUGIN_SOURCE = "Poseidon";

/** Poseidon's enabled, valid plugins, as the rows an instance would answer. */
export const poseidonPluginSummaries = (state: PluginsState): ReadonlyArray<PluginSummary> =>
  state.plugins
    .filter((plugin) => plugin.enabled && plugin.error === undefined)
    .map((plugin) => ({
      name: plugin.name,
      ...(plugin.description === undefined ? {} : { description: plugin.description }),
      source: POSEIDON_PLUGIN_SOURCE,
      enabled: true,
    }));

const mergedStatus = (statuses: ReadonlyArray<MenuSourceStatus>): MenuSourceStatus =>
  statuses.includes("loading") ? "loading" : statuses.includes("failed") ? "failed" : "ready";

/** Poseidon's plugins, then the instance's, deduplicated by name. */
export const mergePluginSources = (
  poseidon: MenuSource<PluginSummary>,
  instance: MenuSource<PluginSummary>,
): MenuSource<PluginSummary> => {
  const seen = new Set<string>();
  const entries: Array<PluginSummary> = [];
  for (const plugin of [...poseidon.entries, ...instance.entries]) {
    if (!plugin.enabled || seen.has(plugin.name)) {
      continue;
    }
    seen.add(plugin.name);
    entries.push(plugin);
  }
  return { status: mergedStatus([poseidon.status, instance.status]), entries };
};
