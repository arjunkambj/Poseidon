/**
 * One plugin on the Plugins page, on the stock `Card`: its name and source
 * badge, a one-line description, what it carries, and a switch. A plugin that
 * failed validation shows its error and cannot be turned on; one that loaded
 * with warnings names the first under its contents, the rest in a tooltip; a
 * harness's own
 * plugin shows its state with a switch that only that harness can change.
 */

import { Badge } from "@poseidon/ui/components/badge";
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

import type { PluginCardModel } from "./plugin-card-model";
import { AlertTriangle, Puzzle } from "@honeyicons/react";

export function PluginCard({
  plugin,
  pending = false,
  onToggle,
  readOnlyReason,
}: {
  readonly plugin: PluginCardModel;
  /** A toggle is in flight: the switch shows the target and waits. */
  readonly pending?: boolean;
  readonly onToggle?: (enabled: boolean) => void;
  /** The tooltip on a switch this page cannot change, "Managed by <harness>". */
  readonly readOnlyReason?: string;
}) {
  const invalid = plugin.error !== undefined;
  const readOnly = plugin.pluginId === null || onToggle === undefined;
  const toggle = (
    <Switch
      checked={plugin.enabled}
      disabled={invalid || readOnly || pending}
      onCheckedChange={(next) => onToggle?.(next)}
      aria-label={
        readOnly
          ? `${plugin.name} is ${plugin.enabled ? "on" : "off"}${readOnlyReason === undefined ? "" : `, ${readOnlyReason.toLowerCase()}`}`
          : `${plugin.enabled ? "Turn off" : "Turn on"} ${plugin.name}`
      }
    />
  );

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Puzzle variant="bold" className="size-4 shrink-0 text-foreground/85" />
            <span className="min-w-0 truncate">{plugin.name}</span>
            <Badge variant="secondary">{plugin.sourceLabel}</Badge>
            {invalid ? <Badge variant="destructive">Invalid</Badge> : null}
          </div>
        </CardTitle>
        <CardDescription className="min-w-0">
          <p className="truncate">
            {plugin.description === undefined || plugin.description === ""
              ? "No description"
              : plugin.description}
          </p>
        </CardDescription>
        <CardAction>
          {readOnly && readOnlyReason !== undefined ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>{toggle}</TooltipTrigger>
              <TooltipContent>{readOnlyReason}</TooltipContent>
            </Tooltip>
          ) : (
            toggle
          )}
        </CardAction>
      </CardHeader>
      {invalid ? (
        <CardContent>
          <p className="line-clamp-3 text-xs text-destructive">{plugin.error}</p>
        </CardContent>
      ) : plugin.contents === "" && plugin.warnings.length === 0 ? null : (
        <CardContent>
          <div className="flex flex-col gap-0.5">
            {plugin.contents === "" ? null : (
              <p className="truncate text-xs text-muted-foreground">{plugin.contents}</p>
            )}
            <PluginWarnings warnings={plugin.warnings} />
          </div>
        </CardContent>
      )}
    </Card>
  );
}

/** The first warning on one line; all of them in a tooltip when there are more. */
function PluginWarnings({ warnings }: { readonly warnings: ReadonlyArray<string> }) {
  const [first, ...rest] = warnings;
  if (first === undefined) return null;
  const line = (
    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <AlertTriangle variant="bold" className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{first}</span>
      {rest.length === 0 ? null : <span className="shrink-0">+{rest.length} more</span>}
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={<p className="flex min-w-0" />}>{line}</TooltipTrigger>
      <TooltipContent>
        <ul className="flex flex-col gap-0.5">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
