/**
 * The Sidebar section on the General page: how long a thread sits idle before
 * the sidebar moves it to its project's Done section. Off by default.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@poseidon/ui/components/select";

import { useAppAtoms } from "@/lib/app-runtime";

import { AUTO_DONE_OPTIONS, autoDoneDays, autoDoneValue } from "./auto-done";
import { selectedOptionLabel } from "./select-label";
import { SettingsRow, SettingsSection } from "./settings-section";

export function AutoDoneSelect() {
  const atoms = useAppAtoms();
  const result = useAtomValue(atoms.settingsAtom);
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "value" });
  const days = AsyncResult.isSuccess(result) ? result.value?.autoDoneAfterDays : undefined;

  return (
    <SettingsSection title="Sidebar">
      <SettingsRow
        title="Move idle threads to Done"
        description="Threads with no new activity for this long move to their project's Done section. Opening one brings it back."
      >
        <Select
          value={autoDoneValue(days)}
          onValueChange={(next) => {
            if (next !== null) {
              updateSettings({ autoDoneAfterDays: autoDoneDays(next) });
            }
          }}
        >
          <SelectTrigger className="w-36" aria-label="Move idle threads to Done">
            <SelectValue>{(value) => selectedOptionLabel(AUTO_DONE_OPTIONS, value)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {AUTO_DONE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
    </SettingsSection>
  );
}
