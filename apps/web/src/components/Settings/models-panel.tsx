/**
 * The Models page: `defaults` (model, effort, runtime mode, workspace) — what
 * a new thread starts with — rendered by `StructForm` off the schema's
 * `settingsForm` annotations; effort and runtime mode take their options from
 * their contract enums, each shown by its readable label.
 *
 * The default model is not a plain select but the composer's harness picker
 * (`DefaultModelRow`): it lists only what the harness and model switches leave
 * on, plus the saved default, and with none saved it shows the model New task
 * seeds a new thread with. Under the defaults, `GeneratedTextSection` picks
 * who writes commit, pull request and title text; the switches themselves are
 * `HarnessModelsSection`, below.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Effort, RuntimeMode } from "@poseidon/contracts/enums";
import { SettingsDefaults, type Settings as SettingsDoc } from "@poseidon/contracts/settings";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";
import { EFFORT_LABELS } from "@/lib/efforts";
import { RUNTIME_MODE_LABELS } from "@/lib/runtime-modes";

import { DefaultModelRow } from "./default-model-row";
import { GeneratedTextSection } from "./generated-text-section";
import { HarnessModelsSection } from "./harness-models-section";
import { StructForm } from "./schema-form";
import { SettingsPageHeader, SettingsSection } from "./settings-section";

export function ModelsPanel() {
  const atoms = useAppAtoms();
  const settingsResult = useAtomValue(atoms.settingsAtom);
  const catalogResult = useAtomValue(atoms.modelCatalogAtom);
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "promiseExit" });

  const settings = AsyncResult.isSuccess(settingsResult) ? settingsResult.value : null;
  const catalog = AsyncResult.isSuccess(catalogResult) ? catalogResult.value : [];

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

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader title="Models" description="What new threads start with." />

      <SettingsSection>
        <DefaultModelRow
          catalog={catalog}
          defaultModel={settings.defaults.model}
          onPick={(model) => void setDefault("model", model)}
        />
        <StructForm
          schema={SettingsDefaults}
          skip={["model"]}
          // An absent workspace is Local, and the select says so.
          value={{ ...settings.defaults, workspace: settings.defaults.workspace ?? "local" }}
          onFieldChange={(key, value) => void setDefault(key, value)}
          optionsFor={(key) => {
            switch (key) {
              case "effort":
                return Effort.literals.map((value) => ({ value, label: EFFORT_LABELS[value] }));
              case "runtimeMode":
                return RuntimeMode.literals.map((value) => ({
                  value,
                  label: RUNTIME_MODE_LABELS[value],
                }));
              case "workspace":
                return [
                  { value: "local", label: "Local" },
                  { value: "worktree", label: "New worktree" },
                ];
              default:
                return [];
            }
          }}
        />
      </SettingsSection>

      <GeneratedTextSection generation={settings.generation} catalog={catalog} />

      <HarnessModelsSection />
    </div>
  );
}
