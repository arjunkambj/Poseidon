/**
 * One harness in first-run setup: its logo or monogram, its name, and what
 * its probe found — a spinner while it is probed or re-checked, then the
 * status badge, whether it is installed, its version and whether it is signed
 * in. A harness that is missing or signed out shows the command its
 * connector named (`connectorHealth`) with a button that runs it in setup's
 * terminal. Nothing here names a harness.
 */

import type { ConnectorSummary } from "@poseidon/contracts/connectors";
import { Badge } from "@poseidon/ui/components/badge";
import { Button } from "@poseidon/ui/components/button";

import { CopyCommand } from "@/components/copy-command";
import { HarnessAvatar } from "@/components/harness-avatar";
import { ConnectorStatusBadge } from "@/components/Settings/connector-status";
import { connectorHealth } from "@/lib/connector-health";
import { harnessFacts } from "@/lib/onboarding";
import { Spinner, Terminal } from "@honeyicons/react";

export function HarnessRow({
  summary,
  monogram,
  iconKey,
  checking,
  onRun,
}: {
  readonly summary: ConnectorSummary;
  readonly monogram: string;
  readonly iconKey?: string | undefined;
  /** A Re-check is in flight: the probe on screen is about to be replaced. */
  readonly checking: boolean;
  /** Runs the fixing command in setup's terminal. */
  readonly onRun: (command: string) => void;
}) {
  const health = connectorHealth(summary);
  const probing = checking || health.state === "probing";
  const facts = probing ? [] : harnessFacts(summary);
  const message = !probing && health.state === "error" ? (summary.probe.message ?? null) : null;
  const command = probing ? null : health.command;

  return (
    <div className="flex items-start gap-3 py-2.5" data-slot="harness-row">
      <HarnessAvatar monogram={monogram} iconKey={iconKey} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{summary.displayName}</span>
          {probing ? (
            <Badge variant="outline">
              <Spinner variant="bold" />
              Checking…
            </Badge>
          ) : (
            <ConnectorStatusBadge summary={summary} />
          )}
        </div>
        {facts.length === 0 ? null : (
          <span className="text-xs text-muted-foreground">{facts.join(" · ")}</span>
        )}
        {message === null || message === "" ? null : (
          <span className="text-xs text-destructive">{message}</span>
        )}
        {command === null ? null : (
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {health.state === "not-installed" ? "Install with" : "Sign in with"}
            <CopyCommand command={command} />
          </div>
        )}
      </div>
      {command === null ? null : (
        <Button type="button" variant="outline" size="sm" onClick={() => onRun(command)}>
          <Terminal variant="bold" />
          Run in terminal
        </Button>
      )}
    </div>
  );
}
