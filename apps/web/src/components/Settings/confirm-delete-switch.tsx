/**
 * The General page's Threads section: whether deleting a thread asks first
 * (`confirmThreadDelete`, on by default). Off, a delete runs at once with the
 * confirmation's defaults; uncommitted work in a worktree still asks.
 */

import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import { toast } from "sonner";

import { Switch } from "@poseidon/ui/components/switch";

import { useConfirmThreadDelete } from "@/components/sidebar/use-confirm-thread-delete";
import { describeExitError, useAppAtoms } from "@/lib/app-runtime";

import { SettingsRow, SettingsSection } from "./settings-section";

export function ConfirmDeleteSwitch() {
  const atoms = useAppAtoms();
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "promiseExit" });
  const confirm = useConfirmThreadDelete();

  const save = async (confirmThreadDelete: boolean) => {
    const exit = await updateSettings({ confirmThreadDelete });
    if (!Exit.isSuccess(exit)) {
      toast.error(describeExitError(exit, "Could not save settings"));
    }
  };

  return (
    <SettingsSection title="Threads">
      <SettingsRow
        title="Confirm before deleting a thread"
        htmlFor="confirm-thread-delete"
        description="Off, a delete runs at once and removes a worktree no other thread uses. Uncommitted work still asks."
      >
        <Switch
          id="confirm-thread-delete"
          aria-label="Confirm before deleting a thread"
          checked={confirm}
          onCheckedChange={(checked) => void save(checked)}
        />
      </SettingsRow>
    </SettingsSection>
  );
}
