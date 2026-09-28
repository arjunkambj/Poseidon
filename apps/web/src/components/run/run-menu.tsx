/**
 * The Run control's menu: the project's saved scripts, the package.json
 * scripts detected in the workspace, then "Edit scripts…".
 *
 * `RunMenuItems` renders from plain props, so it can be tested without a
 * server. `DetectingRunMenu` is what the control mounts: it lives inside the
 * menu's popup, which is only mounted while the menu is open, so
 * `scripts.detect` runs when the menu opens and never before.
 */

import type { ScriptScope } from "@poseidon/client-runtime/scriptAtoms";
import type { TerminalId } from "@poseidon/contracts/ids";
import type { DetectedScript, ProjectScript } from "@poseidon/contracts/scripts";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@poseidon/ui/components/dropdown-menu";
import type * as React from "react";

import { useConnectionState } from "@/state/hooks";
import { Edit, Play, Spinner, Stop } from "@honeyicons/react";

import { runnableFromDetected, runnableFromSaved, type RunnableScript } from "./project-scripts";
import { useDetectedScripts } from "./script-atoms";

/** One script: run it (or bring its running tab to the front), and Stop while it runs. */
function ScriptItems({
  script,
  running,
  onRun,
  onStop,
}: {
  script: RunnableScript;
  running: TerminalId | null;
  onRun: (script: RunnableScript) => void;
  onStop: (terminalId: TerminalId) => void;
}) {
  return (
    <>
      <DropdownMenuItem onClick={() => onRun(script)}>
        <Play variant="bold" />
        <span className="shrink-0">{script.name}</span>
        {running === null ? (
          <span className="ml-auto min-w-0 truncate font-mono text-xs text-muted-foreground">
            {script.command}
          </span>
        ) : (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">running</span>
        )}
      </DropdownMenuItem>
      {running === null ? null : (
        <DropdownMenuItem onClick={() => onStop(running)}>
          <Stop variant="bold" />
          Stop {script.name}
        </DropdownMenuItem>
      )}
    </>
  );
}

export function RunMenuItems({
  saved,
  detected,
  runningOf,
  onRun,
  onStop,
  onEdit,
}: {
  saved: ReadonlyArray<ProjectScript>;
  /** The package.json scripts; `"loading"` while the server looks for them. */
  detected: ReadonlyArray<DetectedScript> | "loading";
  runningOf: (scriptId: string) => TerminalId | null;
  onRun: (script: RunnableScript) => void;
  onStop: (terminalId: TerminalId) => void;
  onEdit: () => void;
}) {
  const scriptItems = (script: RunnableScript) => (
    <ScriptItems
      key={script.id}
      script={script}
      running={runningOf(script.id)}
      onRun={onRun}
      onStop={onStop}
    />
  );
  return (
    <>
      {saved.length === 0 ? null : (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Project scripts</DropdownMenuLabel>
          {saved.map((script) => scriptItems(runnableFromSaved(script)))}
        </DropdownMenuGroup>
      )}
      {detected === "loading" ? (
        <DropdownMenuGroup>
          <DropdownMenuLabel>package.json</DropdownMenuLabel>
          <DropdownMenuItem disabled>
            <Spinner variant="bold" />
            Looking for scripts…
          </DropdownMenuItem>
        </DropdownMenuGroup>
      ) : detected.length === 0 ? null : (
        <DropdownMenuGroup>
          <DropdownMenuLabel>package.json</DropdownMenuLabel>
          {detected.map((script) => scriptItems(runnableFromDetected(script)))}
        </DropdownMenuGroup>
      )}
      {saved.length === 0 && detected !== "loading" && detected.length === 0 ? null : (
        <DropdownMenuSeparator />
      )}
      <DropdownMenuItem onClick={onEdit}>
        <Edit variant="bold" />
        Edit scripts…
      </DropdownMenuItem>
    </>
  );
}

const none: ReadonlyArray<DetectedScript> = [];

/** The menu, with the workspace's package.json scripts read as it opens. */
export function DetectingRunMenu({
  scope,
  ...props
}: Omit<React.ComponentProps<typeof RunMenuItems>, "detected"> & { scope: ScriptScope }) {
  const connected = useConnectionState().status === "connected";
  const detected = useDetectedScripts(scope);
  return <RunMenuItems {...props} detected={connected ? (detected ?? "loading") : none} />;
}
