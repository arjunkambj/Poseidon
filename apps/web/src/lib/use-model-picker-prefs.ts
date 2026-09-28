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

import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";

import { useAppAtoms } from "@/lib/app-runtime";
import type { ModelPick } from "@/lib/model-picks";
import { newTaskModelPick } from "@/lib/model-visibility";

export function useModelPickerPrefs(): ModelPickerSettings {
  const atoms = useAppAtoms();
  const result = useAtomValue(atoms.settingsAtom);
  return (
    (AsyncResult.isSuccess(result) ? result.value?.modelPicker : undefined) ??
    DEFAULT_MODEL_PICKER_SETTINGS
  );
}

/** A new task's model before the user picks one: `newTaskModelPick`. */
export function useNewTaskModelPick(
  catalog: ReadonlyArray<ConnectorModels>,
  defaultModel: string | null | undefined,
): ModelPick | null {
  return newTaskModelPick(catalog, useModelPickerPrefs(), defaultModel);
}
