/**
 * The header's "Run" split button — the thread's, and the New task page's
 * once a project is picked. The main half runs the project's primary saved
 * script (`primaryScript`) in a new tab of the owner's terminal drawer, and
 * becomes Stop while that script runs. The chevron lists the saved scripts,
 * the package.json scripts detected in the workspace (`./run-menu`, read only
 * while the menu is open) and "Edit scripts…", which opens
 * `./edit-scripts-dialog`. With no saved script there is no main half: the
 * whole control is the menu's trigger.
 *
 * The saved scripts are `projectSettings[projectId].scripts` in the settings
 * document. Whether a script runs comes from the drawer's tabs
 * (`./use-run-script`); only the tab in front has an xterm to see its exit,
 * so the control reads the owner's `terminal.list` too, again each time the
 * menu opens, and folds it into the tabs while the drawer is closed. Below
 * `@lg` the header (a container, `header`) has the main half drop its label
 * for its icon and tooltip, like Commit.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { ProjectScript } from "@poseidon/contracts/scripts";
import { Button } from "@poseidon/ui/components/button";
import { ButtonGroup } from "@poseidon/ui/components/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@poseidon/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";
import { toast } from "sonner";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";
import { useConnectionState } from "@/state/hooks";
import { ChevronDown, Play, Stop } from "@honeyicons/react";

import { EditScriptsDialog } from "./edit-scripts-dialog";
import { primaryScript, runnableFromSaved, withScripts } from "./project-scripts";
import { DetectingRunMenu } from "./run-menu";
import { useRunScript } from "./use-run-script";

/**
 * The split button itself, given what to show; `menu` is the popup's
 * content. Kept apart from the atoms so it renders from plain props.
 */
export function RunSplitButton({
  primary,
  primaryRunning,
  onRun,
  onStop,
  onMenuOpen,
  menu,
}: {
  /** The script the main half runs, or null for no main half. */
  primary: ProjectScript | null;
  primaryRunning: boolean;
  onRun: () => void;
  onStop: () => void;
  onMenuOpen: () => void;
  menu: React.ReactNode;
}) {
  const action = primaryRunning ? "Stop" : "Run";
  return (
    <ButtonGroup className="shrink-0">
      {primary === null ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={primaryRunning ? onStop : onRun}
                aria-label={`${action} ${primary.name}`}
              />
            }
          >
            {primaryRunning ? <Stop variant="bold" /> : <Play variant="bold" />}
            <span className="hidden @lg/header:inline">
              {primaryRunning ? "Stop" : primary.name}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {action} {primary.name}
          </TooltipContent>
        </Tooltip>
      )}
      <DropdownMenu onOpenChange={(open) => open && onMenuOpen()}>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  primary === null ? (
                    <Button type="button" variant="ghost" size="sm" aria-label="Run a script" />
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Run a script…"
                    />
                  )
                }
              />
            }
          >
            {primary === null ? (
              <>
                <Play variant="bold" />
                <span className="hidden @lg/header:inline">Run</span>
              </>
            ) : (
              <ChevronDown variant="bold" />
            )}
          </TooltipTrigger>
          <TooltipContent>Run a script…</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-72">
          {menu}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

const noScripts: ReadonlyArray<ProjectScript> = [];

export function RunControl({
  projectId,
  threadId,
  ownerKey,
}: {
  projectId: ProjectId;
  /** The thread whose workspace detection reads; the project's folder without one. */
  threadId?: ThreadId;
  /** Whose terminal drawer runs the scripts, by `terminalOwnerKey`. */
  ownerKey: string;
}) {
  const atoms = useAppAtoms();
  const settingsResult = useAtomValue(atoms.settingsAtom);
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "promiseExit" });
  const connected = useConnectionState().status === "connected";
  const { run, stop, runningOf, relist } = useRunScript(ownerKey);
  const [editKey, setEditKey] = React.useState<number | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);

  const settings = AsyncResult.isSuccess(settingsResult) ? settingsResult.value : null;
  const saved = settings?.projectSettings[projectId]?.scripts ?? noScripts;
  const settingsRef = React.useRef(settings);
  settingsRef.current = settings;

  if (!connected || settings === null) return null;

  const primary = primaryScript(saved);
  const primaryRunning = primary === null ? null : runningOf(primary.id);

  const save = async (scripts: ReadonlyArray<ProjectScript>): Promise<boolean> => {
    // Built from the latest document at the click, keeping the setup script
    // and every other project's settings.
    const latest = settingsRef.current?.projectSettings ?? {};
    const projectSettings = withScripts(latest, projectId, scripts);
    if (projectSettings === null) return true;
    const exit = await updateSettings({ projectSettings });
    if (Exit.isSuccess(exit)) return true;
    toast.error(describeExitError(exit, "Could not save the scripts"));
    return false;
  };

  return (
    <>
      <RunSplitButton
        primary={primary}
        primaryRunning={primaryRunning !== null}
        onRun={() => primary !== null && void run(runnableFromSaved(primary))}
        onStop={() => primaryRunning !== null && stop(primaryRunning)}
        onMenuOpen={relist}
        menu={
          <DetectingRunMenu
            scope={{ projectId, ...(threadId === undefined ? {} : { threadId }) }}
            saved={saved}
            runningOf={runningOf}
            onRun={(script) => void run(script)}
            onStop={stop}
            onEdit={() => {
              setEditKey((key) => (key ?? 0) + 1);
              setEditOpen(true);
            }}
          />
        }
      />
      {editKey === null ? null : (
        <EditScriptsDialog
          key={editKey}
          open={editOpen}
          onOpenChange={setEditOpen}
          saved={saved}
          onSave={save}
        />
      )}
    </>
  );
}
