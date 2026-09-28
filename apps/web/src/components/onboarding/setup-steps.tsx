/**
 * Setup's project and import steps. The project step is the Add project form
 * (`@/components/sidebar/add-project-form`), whose state the dialog holds so
 * the folder picker can mount beside it; each project it adds is named above
 * the form, which clears for another. The import step is Settings → Import's
 * panel in a short scrolling box.
 */

import { Button } from "@poseidon/ui/components/button";

import { SessionImportPanel } from "@/components/import/session-import-panel";
import { AddProjectForm, type AddProjectFormState } from "@/components/sidebar/add-project-form";

export function ProjectStep({
  form,
  added,
}: {
  readonly form: AddProjectFormState;
  /** The names of the projects this step added, oldest first. */
  readonly added: ReadonlyArray<string>;
}) {
  return (
    <div className="flex flex-col gap-3">
      {added.length === 0 ? null : (
        <p className="text-xs text-muted-foreground" role="status">
          Added {added.join(", ")}. Add another, or go on.
        </p>
      )}
      <AddProjectForm form={form}>
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!form.canSubmit}>
            Create project
          </Button>
        </div>
      </AddProjectForm>
    </div>
  );
}

export function ImportStep() {
  return (
    <div className="-mx-4 max-h-80 overflow-y-auto px-4">
      <SessionImportPanel />
    </div>
  );
}
