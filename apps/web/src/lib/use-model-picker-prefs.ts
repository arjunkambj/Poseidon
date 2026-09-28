/**
 * The harness and model switches the pickers filter by (`modelPicker` in the
 * settings document). Until the document loads every default applies, which
 * is what a fresh install and an older row decode to anyway.
 */

import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_MODEL_PICKER_SETTINGS,
  type ModelPickerSettings,
} from "@poseidon/contracts/settings";
import { AsyncResult } from "effect/unstable/reactivity";

import { useAppAtoms } from "@/lib/app-runtime";

export function useModelPickerPrefs(): ModelPickerSettings {
  const atoms = useAppAtoms();
  const result = useAtomValue(atoms.settingsAtom);
  return (
    (AsyncResult.isSuccess(result) ? result.value?.modelPicker : undefined) ??
    DEFAULT_MODEL_PICKER_SETTINGS
  );
}
