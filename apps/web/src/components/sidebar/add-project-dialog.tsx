/**
 * "Add project" — a name plus a workspace root, dispatched as
 * `project.create`. Kept deliberately small; richer project management is not
 * part of the renderer shell.
 *
 * The root comes from the desktop's native directory picker where there is one
 * and from the renderer's own `fs.browse` picker everywhere else, and the name
 * defaults to the directory's own. The field stays typed either way — and a
 * path that cannot be a workspace root is said so here rather than travelling
 * to the server to come back as a rejection reason.
 */

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@poseidon/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@poseidon/ui/components/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@poseidon/ui/components/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { makeCommandId, makeProjectId } from "@poseidon/contracts/ids";

import { DialogActions } from "@/components/dialog-actions";
import { FolderPickerDialog } from "@/components/folder-picker/folder-picker-dialog";
import { hasNativePicker, pickDirectory } from "@/lib/desktop";
import { isAccepted, rejectionMessage } from "@/lib/dispatch-outcome";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { projectNameFromPath, workspacePathProblem } from "@/lib/workspace-path";
import { useDispatchCommand } from "@/state/hooks";
import { Close, Folder, FolderAdd } from "@honeyicons/react";

/** Opens the dialog when `command` fires — mounted only while it may. */
function OpenOnCommand({ command, onFire }: { command: string; onFire: () => void }) {
  useKeybindingCommand(command, onFire);
  return null;
}

/**
 * `icon` is the sidebar's ghost button; `button` is the labelled one the empty
 * start screen offers. `command` lets a keybinding or the palette open it too:
 * only the sidebar's instance claims one, and only while it is enabled, so the
 * palette offers "Add project" exactly where a click on the button would work.
 */
export function AddProjectDialog({
  disabled,
  trigger = "icon",
  command,
}: {
  disabled?: boolean;
  trigger?: "icon" | "button";
  command?: string;
}) {
  const dispatch = useDispatchCommand();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [workspaceRoot, setWorkspaceRoot] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [picking, setPicking] = React.useState(false);

  const pathProblem = workspacePathProblem(workspaceRoot);
  const canSubmit =
    name.trim().length > 0 && workspaceRoot.trim().length > 0 && pathProblem === null && !pending;

  /** A chosen root, from whichever picker chose it: it fills the field and
   * names the project after the directory unless the user already typed a name
   * of their own. */
  const accept = (picked: string) => {
    setWorkspaceRoot(picked);
    setName((current) =>
      current.trim() === "" || current === projectNameFromPath(workspaceRoot)
        ? projectNameFromPath(picked)
        : current,
    );
  };

  /** The desktop's own dialog where there is one, ours everywhere else. The
   * main process can fail to open the native one; say so rather than leaving a
   * button that looks dead, since the field below is still typeable. */
  const choose = async () => {
    if (!hasNativePicker()) {
      setPicking(true);
      return;
    }
    let picked: string | null;
    try {
      picked = await pickDirectory();
    } catch {
      toast.error("Could not open the directory picker");
      return;
    }
    if (picked === null) {
      return;
    }
    accept(picked);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setPending(true);
    const exit = await dispatch({
      commandId: makeCommandId(),
      createdAt: new Date().toISOString(),
      type: "project.create",
      projectId: makeProjectId(),
      name: name.trim(),
      workspaceRoot: workspaceRoot.trim(),
    });
    setPending(false);
    if (isAccepted(exit)) {
      setOpen(false);
      setName("");
      setWorkspaceRoot("");
      return;
    }
    toast.error(rejectionMessage(exit, "Project was rejected"));
  };

  return (
    <>
      {command === undefined || disabled ? null : (
        <OpenOnCommand command={command} onFire={() => setOpen(true)} />
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        {trigger === "button" ? (
          <DialogTrigger render={<Button type="button" disabled={disabled} />}>
            <FolderAdd variant="bold" />
            Add a project
          </DialogTrigger>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <DialogTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Add project"
                      disabled={disabled}
                    />
                  }
                />
              }
            >
              <FolderAdd variant="bold" className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Add project</TooltipContent>
          </Tooltip>
        )}
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create project</DialogTitle>
            <DialogDescription className="sr-only">
              A project groups threads around one workspace root on this machine.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
            <InputGroup>
              <InputGroupAddon>
                <Folder variant="bold" />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Project name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Project name"
                autoFocus
              />
            </InputGroup>

            <div className="flex flex-col gap-2">
              <span id="project-root-label" className="text-sm font-medium">
                Source folder
              </span>
              <div className="rounded-xl border border-border">
                {workspaceRoot === "" ? (
                  <div className="flex flex-col items-center gap-3 px-4 py-8">
                    <p className="text-sm text-muted-foreground">
                      Add a folder on <span className="text-foreground">this computer</span>
                    </p>
                    <Button
                      type="button"
                      variant="secondary"
                      shape="pill"
                      onClick={() => void choose()}
                    >
                      <FolderAdd variant="bold" />
                      Add
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 py-1.5 pr-2 pl-3.5">
                    <Folder variant="bold" className="size-4 shrink-0 text-foreground/85" />
                    {/* Still typeable: the pickers fill it, a person can fix it. */}
                    <input
                      aria-labelledby="project-root-label"
                      className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
                      value={workspaceRoot}
                      onChange={(event) => setWorkspaceRoot(event.target.value)}
                      spellCheck={false}
                      aria-invalid={pathProblem !== null}
                      aria-describedby={pathProblem === null ? undefined : "project-root-problem"}
                    />
                    <Button type="button" variant="ghost" size="sm" onClick={() => void choose()}>
                      Change
                    </Button>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Remove folder"
                            onClick={() => setWorkspaceRoot("")}
                          />
                        }
                      >
                        <Close variant="bold" />
                      </TooltipTrigger>
                      <TooltipContent>Remove folder</TooltipContent>
                    </Tooltip>
                  </div>
                )}
              </div>
              {pathProblem === null ? null : (
                <p id="project-root-problem" className="type-micro text-destructive" role="alert">
                  {pathProblem}
                </p>
              )}
            </div>

            <DialogActions>
              <DialogClose render={<Button type="button" variant="ghost" tone="muted" />}>
                Cancel
              </DialogClose>
              <Button type="submit" disabled={!canSubmit}>
                Create project
              </Button>
            </DialogActions>
          </form>
        </DialogContent>
      </Dialog>

      {/* A sibling, not a child: two modal dialogs each own their own focus
          trap, and nesting one inside the other's content makes the outer one
          fight the inner for it. Mounted only while it is open, so it seeds
          itself from the field as it stands now and browses nothing until
          someone asks it to — this one lives in the sidebar, on every route. */}
      {picking ? (
        <FolderPickerDialog
          open
          onOpenChange={setPicking}
          initialPath={workspaceRoot}
          onPick={accept}
        />
      ) : null}
    </>
  );
}
