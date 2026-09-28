/**
 * The Connectors settings page body. Each configured instance is a card: its
 * `ConnectorSummary` supplies probe state — a status badge, and the binary,
 * version, account, model count and fixing command (`connector-status.tsx`) —
 * and its settings entry supplies the editable config — rendered
 * by `SchemaForm` off the form fields its connector describes over
 * `connectors.describe`, as are the name, icon and docs link. So this file
 * contains no connector-kind-specific markup, and a kind the server does not
 * describe gets a card with no config form.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@poseidon/ui/components/button";
import { Card, CardContent } from "@poseidon/ui/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@poseidon/ui/components/empty";
import { Separator } from "@poseidon/ui/components/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { makeConnectorInstanceId } from "@poseidon/contracts/ids";
import type { ConnectorDescriptor, ConnectorSummary } from "@poseidon/contracts/connectors";
import { ConnectorInstanceConfig } from "@poseidon/contracts/settings";
import * as Exit from "effect/Exit";
import { isObject } from "effect/Predicate";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { useAppAtoms } from "@/lib/app-runtime";
import { connectorIconFor } from "@/lib/connector-icon";

import { ConnectorStatusBadge, ConnectorStatusLine } from "./connector-status";
import { SchemaForm, StructForm, type SelectOption } from "./schema-form";
import { SettingsPageHeader, SettingsSection } from "./settings-section";
import { Add as AddIcon, Connect, Repeat, Spinner, Trash } from "@honeyicons/react";

const asRecord = (value: unknown): Record<string, unknown> =>
  isObject(value) ? (value as Record<string, unknown>) : {};

function ConnectorCard({
  conn,
  descriptor,
  summary,
  onChange,
  onRemove,
}: {
  readonly conn: ConnectorInstanceConfig;
  /** What the server says about this kind; absent when it ships no such connector. */
  readonly descriptor: ConnectorDescriptor | undefined;
  readonly summary: ConnectorSummary | undefined;
  readonly onChange: (next: ConnectorInstanceConfig) => void;
  readonly onRemove: () => void;
}) {
  const atoms = useAppAtoms();
  const models = useAtomValue(atoms.connectorModelsAtom(conn.connectorInstanceId));
  const modelOptions: ReadonlyArray<SelectOption> = AsyncResult.isSuccess(models)
    ? models.value.map((model) => ({ value: model.id, label: model.label }))
    : [];

  const setField = (key: string, value: unknown) => {
    const next = { ...conn } as Record<string, unknown>;
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(next as ConnectorInstanceConfig);
  };

  const setConfigField = (key: string, value: unknown) => {
    const config = { ...asRecord(conn.config) };
    if (value === undefined) {
      delete config[key];
    } else {
      config[key] = value;
    }
    onChange({ ...conn, config });
  };

  // `metadata.accent` is data only: the renderer paints nothing from a
  // connector-supplied colour, and keeps to the theme's tokens.
  const Icon = connectorIconFor(descriptor?.metadata.iconKey);

  return (
    <Card size="sm">
      <CardContent className="flex flex-col">
        <div className="flex items-center gap-3 pb-2">
          <Icon variant="bold" className="size-4 text-foreground/85" />
          <span className="text-sm font-medium">{conn.displayName}</span>
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            {conn.kind}
          </span>
          {summary === undefined ? null : <ConnectorStatusBadge summary={summary} />}
          <span className="flex-1" />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${conn.displayName}`}
                  onClick={onRemove}
                />
              }
            >
              <Trash variant="bold" />
            </TooltipTrigger>
            <TooltipContent>Remove connector</TooltipContent>
          </Tooltip>
        </div>
        {summary === undefined ? null : (
          <ConnectorStatusLine summary={summary} docsUrl={descriptor?.metadata.docsUrl ?? null} />
        )}
        <Separator />
        <StructForm
          schema={ConnectorInstanceConfig}
          value={conn as unknown as Record<string, unknown>}
          onFieldChange={setField}
          skip={["kind", "config"]}
        />
        {descriptor === undefined || descriptor.configFields.length === 0 ? null : (
          <>
            <Separator />
            <SchemaForm
              fields={descriptor.configFields}
              value={asRecord(conn.config)}
              onFieldChange={setConfigField}
              optionsFor={() => modelOptions}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function ConnectorsPanel() {
  const atoms = useAppAtoms();
  const settingsResult = useAtomValue(atoms.settingsAtom);
  const connectorsResult = useAtomValue(atoms.connectorsAtom);
  const descriptorsResult = useAtomValue(atoms.connectorDescriptorsAtom);
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "promiseExit" });
  const probeAll = useAtomSet(atoms.probeConnectorsAtom, { mode: "promise" });
  const [probing, setProbing] = React.useState(false);

  const [removing, setRemoving] = React.useState<ConnectorInstanceConfig | null>(null);

  const settings = AsyncResult.isSuccess(settingsResult) ? settingsResult.value : null;
  const summaries = AsyncResult.isSuccess(connectorsResult) ? connectorsResult.value : [];
  const byInstanceId = new Map(summaries.map((s) => [s.connectorInstanceId, s]));
  const descriptors = AsyncResult.isSuccess(descriptorsResult) ? descriptorsResult.value : [];

  const runProbe = async () => {
    setProbing(true);
    try {
      await probeAll();
    } finally {
      setProbing(false);
    }
  };

  const write = async (connectors: ReadonlyArray<ConnectorInstanceConfig>) => {
    const exit = await updateSettings({ connectors: [...connectors] });
    if (!Exit.isSuccess(exit)) {
      toast.error("Could not save connectors");
      return;
    }
    // The server reconciles the edit on its own schedule, so the summaries this
    // page holds describe the connectors as they were. Re-probe the way the
    // button does rather than leave a new or toggled instance reading
    // "Probing…" until the user presses it themselves.
    await runProbe();
  };

  const addInstance = async (kind: string, displayName: string) => {
    if (settings === null) {
      return;
    }
    // The empty record is the starting config: the connector's definition
    // decodes it on load and fills its own defaults when it opens the
    // instance.
    const entry: ConnectorInstanceConfig = {
      connectorInstanceId: makeConnectorInstanceId(),
      kind,
      displayName,
      enabled: true,
      config: {},
    };
    await write([...settings.connectors, entry]);
  };

  if (settings === null) {
    return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        title="Connectors"
        description="Harnesses your threads run on."
        actions={
          <Button variant="outline" size="sm" onClick={() => void runProbe()} disabled={probing}>
            {probing ? <Spinner variant="bold" /> : <Repeat variant="bold" />}
            {probing ? "Probing…" : "Probe all"}
          </Button>
        }
      />

      {settings.connectors.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Connect variant="bold" />
            </EmptyMedia>
            <EmptyTitle>No connectors yet</EmptyTitle>
            <EmptyDescription>Add one below to run threads on it.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        settings.connectors.map((conn) => (
          <ConnectorCard
            key={conn.connectorInstanceId}
            conn={conn}
            descriptor={descriptors.find((descriptor) => descriptor.kind === conn.kind)}
            summary={byInstanceId.get(conn.connectorInstanceId)}
            onChange={(next) =>
              void write(
                settings.connectors.map((c) =>
                  c.connectorInstanceId === next.connectorInstanceId ? next : c,
                ),
              )
            }
            onRemove={() => setRemoving(conn)}
          />
        ))
      )}

      {/* A removal rewrites the settings document and cannot be undone — the
          same reason `RestoreCheckpointDialog` asks first. */}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) {
            setRemoving(null);
          }
        }}
        title={removing === null ? "Remove connector?" : `Remove ${removing.displayName}?`}
        description="Its configuration is deleted with it, and every thread bound to this instance loses its session binding. Nothing else on this machine is touched."
        confirmLabel="Remove connector"
        onConfirm={() => {
          if (removing === null || settings === null) {
            return;
          }
          const instanceId = removing.connectorInstanceId;
          setRemoving(null);
          void write(settings.connectors.filter((c) => c.connectorInstanceId !== instanceId));
        }}
      />

      <SettingsSection title="Add a connector" card={false}>
        <div className="flex flex-wrap gap-2">
          {descriptors.map((descriptor) => (
            <Button
              key={descriptor.kind}
              variant="outline"
              size="sm"
              onClick={() => void addInstance(descriptor.kind, descriptor.metadata.displayName)}
            >
              <AddIcon variant="bold" />
              Add {descriptor.metadata.displayName}
            </Button>
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
