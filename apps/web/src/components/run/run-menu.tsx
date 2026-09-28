/**
 * The Run control's menu: the project's saved scripts, the package.json
 * scripts detected in the workspace, then "Edit scripts…". Under a running
 * script, each dev server it printed (`@/components/terminal/dev-servers`)
 * has an "Open … in browser" item.
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

import { devServerLabel } from "@/components/terminal/dev-server-urls";
import { useConnectionState } from "@/state/hooks";
import { Edit, Globe, Play, Spinner, Stop } from "@honeyicons/react";

import { runnableFromDetected, runnableFromSaved, type RunnableScript } from "./project-scripts";
import { useDetectedScripts } from "./script-atoms";

/**
 * One script: run it (or bring its running tab to the front), and while it
 * runs, Stop and open each dev server it printed.
 */
function ScriptItems({
  script,
  running,
  urls,
  onRun,
  onStop,
  onOpenUrl,
}: {
  script: RunnableScript;
  running: TerminalId | null;
  /** The dev servers the running script printed. */
  urls: ReadonlyArray<string>;
  onRun: (script: RunnableScript) => void;
  onStop: (terminalId: TerminalId) => void;
  onOpenUrl: (url: string) => void;
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
      {running === null
        ? null
        : urls.map((url) => (
            <DropdownMenuItem key={url} onClick={() => onOpenUrl(url)}>
              <Globe variant="bold" />
              Open {devServerLabel(url)} in browser
            </DropdownMenuItem>
          ))}
    </>
  );
}

export function RunMenuItems({
  saved,
  detected,
  runningOf,
  urlsOf,
  onRun,
  onStop,
  onOpenUrl,
  onEdit,
}: {
  saved: ReadonlyArray<ProjectScript>;
  /** The package.json scripts; `"loading"` while the server looks for them. */
  detected: ReadonlyArray<DetectedScript> | "loading";
  runningOf: (scriptId: string) => TerminalId | null;
  /** The dev servers a running script's terminal printed. */
  urlsOf: (terminalId: TerminalId) => ReadonlyArray<string>;
  onRun: (script: RunnableScript) => void;
  onStop: (terminalId: TerminalId) => void;
  onOpenUrl: (url: string) => void;
  onEdit: () => void;
}) {
  const scriptItems = (script: RunnableScript) => {
    const running = runningOf(script.id);
    return (
      <ScriptItems
        key={script.id}
        script={script}
        running={running}
        urls={running === null ? [] : urlsOf(running)}
        onRun={onRun}
        onStop={onStop}
        onOpenUrl={onOpenUrl}
      />
    );
  };
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
