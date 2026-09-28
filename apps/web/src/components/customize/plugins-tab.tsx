/**
 * The Plugins tab: Poseidon's own plugins first — the built-in ones the app
 * ships and the global ones in `POSEIDON_HOME/plugins` — as a card grid with
 * a switch each, then one section per connector instance that has plugins of
 * its own (the plugins its CLI installed), shown read-only because that
 * harness owns their state.
 *
 * It lists only what exists: no empty block for a missing global plugin, and
 * no section for a harness with none. "Plugins folder" in the header opens
 * the global folder (creating it), where a new plugin goes.
 *
 * A switch changes which plugins sessions started from now on load; a running
 * session keeps what it started with.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@poseidon/ui/components/button";
import type { ConnectorSummary } from "@poseidon/contracts/connectors";
import type { PluginId, PoseidonPlugin } from "@poseidon/contracts/plugins";
import * as Exit from "effect/Exit";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";
import { instancesWith } from "@/lib/customize-instances";

import { InstanceSection } from "./customize-instances";
import { useCustomizeScope } from "./customize-layout";
import { CustomizeEmpty, CustomizeSearch, matchesQuery } from "./customize-list";
import { PluginCard } from "./plugin-card";
import { harnessPluginCard, poseidonPluginCard, splitBySource } from "./plugin-card-model";
import { FolderOpen, Package } from "@honeyicons/react";

const GRID = "grid grid-cols-1 gap-3 sm:grid-cols-2";

export function PluginsTab() {
  const [query, setQuery] = React.useState("");

  return (
    <div className="flex flex-col gap-8">
      <CustomizeSearch value={query} onChange={setQuery} placeholder="Search plugins" />
      <PoseidonPlugins query={query} />
      <HarnessPlugins query={query} />
    </div>
  );
}

/** One section per enabled instance that has plugins of its own to show. */
function HarnessPlugins({ query }: { readonly query: string }) {
  const atoms = useAppAtoms();
  const connectorsResult = useAtomValue(atoms.connectorsAtom);
  if (!AsyncResult.isSuccess(connectorsResult)) {
    return null;
  }
  return instancesWith(connectorsResult.value, "plugins").map((instance) => (
    <InstancePlugins key={instance.connectorInstanceId} instance={instance} query={query} />
  ));
}

function PoseidonPlugins({ query }: { readonly query: string }) {
  const atoms = useAppAtoms();
  const result = useAtomValue(atoms.poseidonPluginsAtom);
  const setEnabled = useAtomSet(atoms.pluginsSetEnabledAtom, { mode: "promiseExit" });
  const openFolder = useAtomSet(atoms.pluginsOpenFolderAtom, { mode: "promiseExit" });
  // The value each switch was flipped to, until the reloaded list agrees.
  const [pending, setPending] = React.useState<ReadonlyMap<PluginId, boolean>>(new Map());

  const state = AsyncResult.isSuccess(result) ? result.value : null;

  React.useEffect(() => {
    if (state === null) {
      return;
    }
    setPending((current) => {
      const next = new Map(
        [...current].filter(
          ([id, enabled]) => state.plugins.find((p) => p.pluginId === id)?.enabled !== enabled,
        ),
      );
      return next.size === current.size ? current : next;
    });
  }, [state]);

  const toggle = async (plugin: PoseidonPlugin, enabled: boolean) => {
    setPending((current) => new Map(current).set(plugin.pluginId, enabled));
    const exit = await setEnabled({ pluginId: plugin.pluginId, enabled });
    if (!Exit.isSuccess(exit)) {
      setPending((current) => {
        const next = new Map(current);
        next.delete(plugin.pluginId);
        return next;
      });
      toast.error(
        describeExitError(exit, `Could not turn ${enabled ? "on" : "off"} ${plugin.name}`),
      );
    }
  };

  const showFolder = async () => {
    const exit = await openFolder();
    if (!Exit.isSuccess(exit)) {
      toast.error(describeExitError(exit, "Could not open the plugins folder"));
    }
  };

  const card = (plugin: PoseidonPlugin) => {
    const target = pending.get(plugin.pluginId);
    const model = poseidonPluginCard(plugin);
    return (
      <PluginCard
        key={model.key}
        plugin={target === undefined ? model : { ...model, enabled: target }}
        pending={target !== undefined}
        onToggle={(enabled) => void toggle(plugin, enabled)}
      />
    );
  };

  const shown =
    state?.plugins.filter((plugin) => matchesQuery(query, [plugin.name, plugin.description])) ?? [];
  const { builtin, global } = splitBySource(shown);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="flex items-center gap-2 text-base font-medium">
            <Package variant="bold" className="size-4 shrink-0 text-foreground/85" />
            Poseidon
          </h2>
          <p className="text-xs text-muted-foreground">
            Loaded into every harness. Changes apply to sessions started after them. On Command
            Code, a plugin's MCP servers stay while a session in the same project still uses them.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void showFolder()}>
          <FolderOpen variant="bold" />
          Plugins folder
        </Button>
      </div>

      {AsyncResult.isFailure(result) ? (
        <CustomizeEmpty>Could not list plugins.</CustomizeEmpty>
      ) : state === null ? (
        <CustomizeEmpty>Loading…</CustomizeEmpty>
      ) : shown.length === 0 && query.trim() !== "" ? (
        <CustomizeEmpty>No plugins match “{query.trim()}”.</CustomizeEmpty>
      ) : (
        <div className={GRID}>{[...builtin, ...global].map(card)}</div>
      )}
    </section>
  );
}

function InstancePlugins({
  instance,
  query,
}: {
  readonly instance: ConnectorSummary;
  readonly query: string;
}) {
  const atoms = useAppAtoms();
  const projectId = useCustomizeScope();
  const descriptorsResult = useAtomValue(atoms.connectorDescriptorsAtom);
  const result = useAtomValue(atoms.pluginsAtom(instance.connectorInstanceId)(projectId));

  // The badge names the harness, not the instance's own label.
  const owner =
    (AsyncResult.isSuccess(descriptorsResult)
      ? descriptorsResult.value.find((descriptor) => descriptor.kind === instance.kind)?.metadata
          .displayName
      : undefined) ?? instance.displayName;

  if (AsyncResult.isFailure(result)) {
    return (
      <InstanceSection instance={instance}>
        <CustomizeEmpty>Could not list {owner}’s plugins.</CustomizeEmpty>
      </InstanceSection>
    );
  }
  const plugins = AsyncResult.isSuccess(result) ? result.value : [];
  const shown = plugins.filter((plugin) => matchesQuery(query, [plugin.name, plugin.description]));

  // Nothing installed, still loading, or nothing matching the search: no section.
  if (shown.length === 0) {
    return null;
  }
  return (
    <InstanceSection instance={instance}>
      <div className={GRID}>
        {shown.map((plugin) => {
          const model = harnessPluginCard(plugin, owner, instance.connectorInstanceId);
          return (
            <PluginCard key={model.key} plugin={model} readOnlyReason={`Managed by ${owner}`} />
          );
        })}
      </div>
    </InstanceSection>
  );
}
