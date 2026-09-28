/**
 * The Models page: `defaults` (model, effort, runtime mode) — what a new
 * thread starts with — rendered by `StructForm` off the schema's
 * `settingsForm` annotations. Model options come from every enabled
 * connector instance (`modelCatalogAtom`), each labelled with the instance it
 * is listed under; effort and runtime mode from their contract enums.
 *
 * With no default model saved, the picker shows the first listed model: that
 * is the one the server seeds a new thread with (`seedModel`), so the page
 * says what will actually happen instead of "Choose…".
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Effort, RuntimeMode } from "@poseidon/contracts/enums";
import { SettingsDefaults, type Settings as SettingsDoc } from "@poseidon/contracts/settings";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";
import { RUNTIME_MODE_LABELS } from "@/lib/runtime-modes";

import { HarnessModelsSection } from "./harness-models-section";
import { StructForm, type SelectOption } from "./schema-form";
import { SettingsPageHeader, SettingsSection } from "./settings-section";

const enumOptions = (literals: ReadonlyArray<string>): ReadonlyArray<SelectOption> =>
  literals.map((value) => ({ value, label: value }));

export function ModelsPanel() {
  const atoms = useAppAtoms();
  const settingsResult = useAtomValue(atoms.settingsAtom);
  const catalogResult = useAtomValue(atoms.modelCatalogAtom);
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "promiseExit" });

  const settings = AsyncResult.isSuccess(settingsResult) ? settingsResult.value : null;
  const catalog = AsyncResult.isSuccess(catalogResult) ? catalogResult.value : [];
  // The default is a bare model id, so an id two instances both list is one
  // option — under the first instance that lists it.
  const modelOptions: ReadonlyArray<SelectOption> = catalog
    .flatMap(({ connector, models }) =>
      models.map((model) => ({
        value: model.id,
        label: `${connector.displayName} · ${model.label}`,
      })),
    )
    .filter((option, index, all) => all.findIndex((o) => o.value === option.value) === index);

  if (settings === null) {
    return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  }

  const setDefault = async (key: string, value: unknown) => {
    const next = { ...settings.defaults } as Record<string, unknown>;
    if (value === undefined) {
      // `model` is null-or-string, not optional — clearing writes null.
      if (key === "model") {
        next.model = null;
      } else {
        delete next[key];
      }
    } else {
      next[key] = value;
    }
    const exit = await updateSettings({ defaults: next as SettingsDoc["defaults"] });
    if (!Exit.isSuccess(exit)) {
      toast.error(describeExitError(exit, "Could not save settings"));
    }
  };

  const shown = {
    ...settings.defaults,
    model: settings.defaults.model ?? modelOptions[0]?.value ?? null,
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader title="Models" description="What new threads start with." />

      <SettingsSection>
        <StructForm
          schema={SettingsDefaults}
          value={shown as unknown as Record<string, unknown>}
          onFieldChange={(key, value) => void setDefault(key, value)}
          optionsFor={(key) => {
            switch (key) {
              case "model":
                return modelOptions;
              case "effort":
                return enumOptions(Effort.literals);
              case "runtimeMode":
                return RuntimeMode.literals.map((value) => ({
                  value,
                  label: RUNTIME_MODE_LABELS[value],
                }));
              default:
                return [];
            }
          }}
        />
      </SettingsSection>

      <HarnessModelsSection />
    </div>
  );
}
