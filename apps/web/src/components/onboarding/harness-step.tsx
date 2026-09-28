/**
 * Setup's first step: every enabled harness instance, in the order the server
 * lists them (the registry's), each with what its probe found. Re-check
 * re-probes them all, as Settings → Connectors does. A harness's install or
 * sign-in command runs as a script in home's terminal (`HomeTerminal`), whose
 * drawer opens under the list — no project exists yet to own it. The drawer
 * is mounted once something has run in this step, so an untouched step has
 * no terminal strip: home's drawer remembers being open, like a thread's,
 * and mounting it open would start a shell nobody asked for.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ConnectorSummary } from "@poseidon/contracts/connectors";
import { terminalOwnerKey } from "@poseidon/contracts/terminal";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { Button } from "@poseidon/ui/components/button";

import { useRunScript } from "@/components/run/use-run-script";
import { HomeTerminal } from "@/components/terminal/owned-terminal";
import { useConnectorIconKeys } from "@/components/ui/icons/use-connector-icon-keys";
import { useAppAtoms } from "@/lib/app-runtime";
import { catalogMonograms } from "@/lib/harness-monogram";
import { setupScript } from "@/lib/onboarding";
import { cn } from "@/lib/utils";
import { Refresh, Spinner } from "@honeyicons/react";

import { HarnessRow } from "./harness-row";

const HOME_KEY = terminalOwnerKey({ home: true });

export function HarnessStep() {
  const atoms = useAppAtoms();
  const connectorsResult = useAtomValue(atoms.connectorsAtom);
  const probeAll = useAtomSet(atoms.probeConnectorsAtom, { mode: "promise" });
  const iconKeys = useConnectorIconKeys();
  const { run } = useRunScript(HOME_KEY);
  const [ran, setRan] = React.useState(false);
  const [checking, setChecking] = React.useState(false);

  const summaries = React.useMemo(
    () =>
      (AsyncResult.isSuccess(connectorsResult) ? connectorsResult.value : []).filter(
        (summary) => summary.enabled,
      ),
    [connectorsResult],
  );
  const monograms = React.useMemo(
    () => catalogMonograms(summaries.map((connector) => ({ connector, models: [] }))),
    [summaries],
  );

  const recheck = async () => {
    setChecking(true);
    try {
      await probeAll();
    } catch {
      // The rows keep the last probe; the button can be pressed again.
    } finally {
      setChecking(false);
    }
  };

  const runCommand = (summary: ConnectorSummary, command: string) => {
    setRan(true);
    void run(setupScript(summary, command));
  };

  const loading = summaries.length === 0 && connectorsResult.waiting;

  return (
    // With the drawer the step is a fixed-height column, like a thread's: the
    // list takes what the drawer leaves.
    <div className={cn("flex flex-col", ran && "h-96")}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {loading ? (
          <p className="flex items-center gap-2 py-2.5 text-sm text-muted-foreground">
            <Spinner variant="bold" />
            Looking for harnesses…
          </p>
        ) : summaries.length === 0 ? (
          <p className="py-2.5 text-sm text-muted-foreground">
            No harness is enabled. Settings → Connectors adds one.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {summaries.map((summary) => (
              <HarnessRow
                key={summary.connectorInstanceId}
                summary={summary}
                monogram={monograms.get(summary.connectorInstanceId) ?? ""}
                iconKey={iconKeys.get(summary.kind)}
                checking={checking}
                onRun={(command) => runCommand(summary, command)}
              />
            ))}
          </div>
        )}
        <div className="flex items-center gap-3 py-2.5">
          <span className="flex-1 text-xs text-muted-foreground">
            Installed or signed in from a terminal? Check again.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={checking}
            onClick={() => void recheck()}
          >
            {checking ? <Spinner variant="bold" /> : <Refresh variant="bold" />}
            Re-check
          </Button>
        </div>
      </div>
      {ran ? <HomeTerminal /> : null}
    </div>
  );
}
