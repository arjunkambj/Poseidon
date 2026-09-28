/**
 * The Add project form — a name plus a workspace root, dispatched as
 * `project.create` — shared by the sidebar's dialog
 * (`./add-project-dialog`) and first-run setup's project step.
 *
 * The root comes from the desktop's native directory picker where there is one
 * and from the renderer's own `fs.browse` picker everywhere else, and the name
 * defaults to the directory's own (`nameAfterPick`). The field stays typed
 * either way — and a path that cannot be a workspace root is said so here
 * rather than travelling to the server to come back as a rejection reason.
 *
 * `useAddProjectForm` holds the state and the submit; `AddProjectForm` draws
 * the fields around the caller's actions. The folder picker is the hook's
 * `picker` element, which the caller mounts beside its own dialog, never
 * inside it: two modal dialogs each own their own focus trap, and nesting one
 * inside the other's content makes the outer one fight the inner for it.
 */

import type { ProjectId } from "@poseidon/contracts/ids";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@poseidon/ui/components/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@poseidon/ui/components/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { makeCommandId, makeProjectId } from "@poseidon/contracts/ids";

import { FolderPickerDialog } from "@/components/folder-picker/folder-picker-dialog";
import { hasNativePicker, pickDirectory } from "@/lib/desktop";
import { isAccepted, rejectionMessage } from "@/lib/dispatch-outcome";
import { nameAfterPick, workspacePathProblem } from "@/lib/workspace-path";
import { useDispatchCommand } from "@/state/hooks";
import { Close, Folder, FolderAdd } from "@honeyicons/react";

export interface CreatedProject {
  readonly projectId: ProjectId;
  readonly name: string;
}

export interface AddProjectFormState {
  readonly name: string;
  readonly setName: (name: string) => void;
  readonly workspaceRoot: string;
  readonly setWorkspaceRoot: (root: string) => void;
  readonly pathProblem: string | null;
  readonly canSubmit: boolean;
  readonly choose: () => Promise<void>;
  readonly submit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  /** The server-side folder picker while it is open; mount it beside the dialog. */
  readonly picker: React.ReactNode;
}

/**
 * The form's state. An accepted `project.create` clears the fields and calls
 * `onCreated`; a rejection keeps them, so the path can be corrected.
 */
export function useAddProjectForm(onCreated: (project: CreatedProject) => void) {
  const dispatch = useDispatchCommand();
  const [name, setName] = React.useState("");
  const [workspaceRoot, setWorkspaceRoot] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [picking, setPicking] = React.useState(false);

  const pathProblem = workspacePathProblem(workspaceRoot);
  const canSubmit =
    name.trim().length > 0 && workspaceRoot.trim().length > 0 && pathProblem === null && !pending;

  /** A chosen root, from whichever picker chose it. */
  const accept = (picked: string) => {
    setWorkspaceRoot(picked);
    setName((current) => nameAfterPick(current, workspaceRoot, picked));
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
    const projectId = makeProjectId();
    const created = name.trim();
    const exit = await dispatch({
      commandId: makeCommandId(),
      createdAt: new Date().toISOString(),
      type: "project.create",
      projectId,
      name: created,
      workspaceRoot: workspaceRoot.trim(),
    });
    setPending(false);
    if (isAccepted(exit)) {
      setName("");
      setWorkspaceRoot("");
      onCreated({ projectId, name: created });
      return;
    }
    toast.error(rejectionMessage(exit, "Project was rejected"));
  };

  // Mounted only while it is open, so it seeds itself from the field as it
  // stands now and browses nothing until someone asks it to.
  const picker = picking ? (
    <FolderPickerDialog
      open
      onOpenChange={setPicking}
      initialPath={workspaceRoot}
      onPick={accept}
    />
  ) : null;

  const state: AddProjectFormState = {
    name,
    setName,
    workspaceRoot,
    setWorkspaceRoot,
    pathProblem,
    canSubmit,
    choose,
    submit,
    picker,
  };
  return state;
}

/** The name field and the source folder, with the caller's actions below. */
export function AddProjectForm({
  form,
  autoFocus = false,
  children,
}: {
  readonly form: AddProjectFormState;
  readonly autoFocus?: boolean;
  /** The actions — a submit button among them. */
  readonly children: React.ReactNode;
}) {
  const { name, workspaceRoot, pathProblem } = form;
  return (
    <form onSubmit={(event) => void form.submit(event)} className="flex flex-col gap-5">
      <InputGroup>
        <InputGroupAddon>
          <Folder variant="bold" />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Project name"
          value={name}
          onChange={(event) => form.setName(event.target.value)}
          placeholder="Project name"
          autoFocus={autoFocus}
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
                onClick={() => void form.choose()}
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
                onChange={(event) => form.setWorkspaceRoot(event.target.value)}
                spellCheck={false}
                aria-invalid={pathProblem !== null}
                aria-describedby={pathProblem === null ? undefined : "project-root-problem"}
              />
              <Button type="button" variant="ghost" size="sm" onClick={() => void form.choose()}>
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
                      onClick={() => form.setWorkspaceRoot("")}
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

      {children}
    </form>
  );
}
