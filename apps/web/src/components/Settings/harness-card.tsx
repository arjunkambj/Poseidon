/**
 * One harness on Settings → Models: its avatar, name and connector kind, a
 * switch that says whether the model pickers offer it, and a dense row per
 * model: its name, a muted line with its tagline (when the connector gives
 * one), id and family, its effort ladder and its own switch.
 *
 * The switches filter the pickers only (`@/lib/model-visibility`): a thread
 * already on a harness or model that is switched off keeps it and keeps
 * working. A model row under a harness that is off is shown with its switch
 * disabled, and the switch that would leave the pickers with nothing to offer
 * is disabled with a tooltip saying why.
 */

import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ModelOption } from "@poseidon/contracts/connectors";
import type { ModelPickerSettings } from "@poseidon/contracts/settings";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@poseidon/ui/components/card";
import { Switch } from "@poseidon/ui/components/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { cn } from "@poseidon/ui/lib/utils";
import type * as React from "react";

import { HarnessAvatar } from "@/components/harness-avatar";
import { orderEfforts } from "@/lib/efforts";
import {
  harnessOn,
  isLastVisible,
  isLastVisibleHarness,
  modelOn,
  setHarness,
  setModel,
} from "@/lib/model-visibility";

const LAST_VISIBLE_TOOLTIP = "At least one model stays on";

/** The effort ladder as one muted line, lowest rung first. */
export const effortsText = (efforts: ModelOption["efforts"] | null | undefined): string => {
  const ladder = orderEfforts(efforts);
  return ladder.length === 0 ? "No effort levels" : ladder.join(" · ");
};

/**
 * A model row's muted line: the connector's tagline when it gives one, then
 * the id and family. The name is the row's label and never comes from here.
 */
export const modelDetail = (model: ModelOption): string =>
  [model.description, model.id, model.family].filter(Boolean).join(" · ");

/** A switch, wrapped in the refusal's tooltip when it is the last one on. */
function GuardedSwitch({
  last,
  children,
}: {
  readonly last: boolean;
  readonly children: React.ReactElement;
}) {
  // A disabled switch takes no pointer events, so the tooltip hangs on a span.
  return last ? (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{children}</TooltipTrigger>
      <TooltipContent>{LAST_VISIBLE_TOOLTIP}</TooltipContent>
    </Tooltip>
  ) : (
    children
  );
}

function ModelRow({
  model,
  on,
  harnessIsOn,
  last,
  onToggle,
}: {
  readonly model: ModelOption;
  readonly on: boolean;
  readonly harnessIsOn: boolean;
  readonly last: boolean;
  readonly onToggle: (on: boolean) => void;
}) {
  const muted = !harnessIsOn;
  const detail = modelDetail(model);
  return (
    <div
      data-slot="harness-model-row"
      className="flex min-h-7 items-center gap-3 px-2 py-0.5"
      aria-disabled={muted || undefined}
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span
          className={cn("max-w-2/3 shrink-0 truncate", muted && "text-muted-foreground")}
          title={model.label}
        >
          {model.label}
        </span>
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={detail}>
          {detail}
        </span>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">{effortsText(model.efforts)}</span>
      <GuardedSwitch last={last && on && harnessIsOn}>
        <Switch
          size="sm"
          aria-label={`Show ${model.label} in model pickers`}
          checked={on}
          disabled={muted || (last && on)}
          onCheckedChange={(next) => onToggle(next)}
        />
      </GuardedSwitch>
    </div>
  );
}

export function HarnessCard({
  group,
  catalog,
  monogram,
  prefs,
  onChange,
}: {
  readonly group: ConnectorModels;
  /** The whole catalog, to tell which switch is the last one on. */
  readonly catalog: ReadonlyArray<ConnectorModels>;
  readonly monogram: string;
  readonly prefs: ModelPickerSettings;
  readonly onChange: (next: ModelPickerSettings) => void;
}) {
  const { connector, models } = group;
  const instanceId = connector.connectorInstanceId;
  const on = harnessOn(prefs, instanceId);
  const lastHarness = on && isLastVisibleHarness(catalog, prefs, instanceId);

  return (
    <Card size="sm" data-slot="harness-card">
      <CardHeader>
        <CardTitle>
          <span className="flex min-w-0 items-center gap-2">
            <HarnessAvatar monogram={monogram} />
            <span className="truncate">{connector.displayName}</span>
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs font-normal text-muted-foreground">
              {connector.kind}
            </span>
          </span>
        </CardTitle>
        <CardDescription>
          Show in model pickers. Threads already on it keep working either way.
        </CardDescription>
        <CardAction>
          <GuardedSwitch last={lastHarness}>
            <Switch
              aria-label={`Show ${connector.displayName} in model pickers`}
              checked={on}
              disabled={lastHarness}
              onCheckedChange={(next) => onChange(setHarness(prefs, instanceId, next))}
            />
          </GuardedSwitch>
        </CardAction>
      </CardHeader>
      <CardContent>
        {models.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">This harness lists no models.</p>
        ) : (
          <div className="flex flex-col divide-y">
            {models.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                on={modelOn(prefs, instanceId, model)}
                harnessIsOn={on}
                last={isLastVisible(catalog, prefs, instanceId, model.id)}
                onToggle={(next) => onChange(setModel(prefs, instanceId, model.id, next))}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
