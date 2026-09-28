/**
 * The Plugins tab: Poseidon's own plugins first — the built-in ones the app
 * ships and the global ones in `POSEIDON_HOME/plugins` — as a card grid with
 * a switch each, then one section per connector instance that has plugins of
 * its own (the plugins its CLI installed), shown read-only because that
 * harness owns their state.
 *
 * A switch changes which plugins sessions started from now on load; a running
 * session keeps what it started with.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@poseidon/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@poseidon/ui/components/empty";
import type { ConnectorSummary } from "@poseidon/contracts/connectors";
import type { PluginId, PoseidonPlugin } from "@poseidon/contracts/plugins";
import * as Exit from "effect/Exit";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { copyPath } from "@/lib/copy-path";
import { describeExitError, useAppAtoms } from "@/lib/app-runtime";

import { CustomizeInstances } from "./customize-instances";
import { useCustomizeScope } from "./customize-layout";
import { CustomizeEmpty, CustomizeSearch, matchesQuery } from "./customize-list";
import { PluginCard } from "./plugin-card";
import { harnessPluginCard, poseidonPluginCard, splitBySource } from "./plugin-card-model";
import { Copy, FolderOpen, Package } from "@honeyicons/react";

const GRID = "grid grid-cols-1 gap-3 sm:grid-cols-2";

export function PluginsTab() {
  const [query, setQuery] = React.useState("");

  return (
    <div className="flex flex-col gap-8">
      <CustomizeSearch value={query} onChange={setQuery} placeholder="Search plugins" />
      <PoseidonPlugins query={query} />
      <CustomizeInstances kind="plugins" empty="No enabled connector has plugins of its own.">
        {(instance) => <InstancePlugins instance={instance} query={query} />}
      </CustomizeInstances>
    </div>
  );
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
  const hasGlobal = state?.plugins.some((plugin) => plugin.source === "global") ?? false;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="flex items-center gap-2 text-base font-medium">
            <Package variant="bold" className="size-4 shrink-0 text-foreground/85" />
            Poseidon
          </h2>
          <p className="text-xs text-muted-foreground">
            Loaded into every harness. Changes apply to sessions started after them.
          </p>
        </div>
        {hasGlobal ? (
          <Button variant="outline" size="sm" onClick={() => void showFolder()}>
            <FolderOpen variant="bold" />
            Open folder
          </Button>
        ) : null}
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

      {state === null || hasGlobal ? null : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpen variant="bold" />
            </EmptyMedia>
            <EmptyTitle>No global plugins</EmptyTitle>
            <EmptyDescription>
              Put a plugin folder in{" "}
              <span className="font-mono break-all text-foreground">{state.globalDir}</span> and it
              shows here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            <Button variant="outline" size="sm" onClick={() => void copyPath(state.globalDir)}>
              <Copy variant="bold" />
              Copy path
            </Button>
            <Button variant="outline" size="sm" onClick={() => void showFolder()}>
              <FolderOpen variant="bold" />
              Open folder
            </Button>
          </EmptyContent>
        </Empty>
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
    return <CustomizeEmpty>Could not list {owner}’s plugins.</CustomizeEmpty>;
  }
  const plugins = AsyncResult.isSuccess(result) ? result.value : [];
  const shown = plugins.filter((plugin) => matchesQuery(query, [plugin.name, plugin.description]));

  if (plugins.length === 0) {
    return <CustomizeEmpty>No plugins installed in {owner}.</CustomizeEmpty>;
  }
  if (shown.length === 0) {
    return <CustomizeEmpty>No plugins match “{query.trim()}”.</CustomizeEmpty>;
  }
  return (
    <div className={GRID}>
      {shown.map((plugin) => {
        const model = harnessPluginCard(plugin, owner, instance.connectorInstanceId);
        return <PluginCard key={model.key} plugin={model} readOnlyReason={`Managed by ${owner}`} />;
      })}
    </div>
  );
}
