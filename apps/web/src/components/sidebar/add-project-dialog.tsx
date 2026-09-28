/**
 * "Add project" — the sidebar's dialog, and the labelled button the empty
 * start screen offers, around the shared form (`./add-project-form`). Kept
 * deliberately small; richer project management is not part of the renderer
 * shell.
 */

import * as React from "react";

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
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { DialogActions } from "@/components/dialog-actions";
import { AddProjectForm, useAddProjectForm } from "@/components/sidebar/add-project-form";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { FolderAdd } from "@honeyicons/react";

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
  const [open, setOpen] = React.useState(false);
  const form = useAddProjectForm(() => setOpen(false));

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
          <AddProjectForm form={form} autoFocus>
            <DialogActions>
              <DialogClose render={<Button type="button" variant="ghost" tone="muted" />}>
                Cancel
              </DialogClose>
              <Button type="submit" disabled={!form.canSubmit}>
                Create project
              </Button>
            </DialogActions>
          </AddProjectForm>
        </DialogContent>
      </Dialog>

      {/* A sibling, not a child — see `./add-project-form`. This one lives
          in the sidebar, on every route, and browses nothing until asked. */}
      {form.picker}
    </>
  );
}
