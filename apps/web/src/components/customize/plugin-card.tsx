/**
 * One plugin on the Plugins page, on the stock `Card`: its name and source
 * badge, a one-line description, what it carries, and a switch. A plugin that
 * failed validation shows its error and cannot be turned on; a harness's own
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
import { Puzzle } from "@honeyicons/react";

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
        <CardTitle>
          <div className="flex min-w-0 items-center gap-2">
            <Puzzle variant="bold" className="size-4 shrink-0 text-foreground/85" />
            <span className="min-w-0 truncate">{plugin.name}</span>
            <Badge variant="secondary">{plugin.sourceLabel}</Badge>
            {invalid ? <Badge variant="destructive">Invalid</Badge> : null}
          </div>
        </CardTitle>
        <CardDescription>
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
      ) : plugin.contents === "" ? null : (
        <CardContent>
          <p className="truncate text-xs text-muted-foreground">{plugin.contents}</p>
        </CardContent>
      )}
    </Card>
  );
}
