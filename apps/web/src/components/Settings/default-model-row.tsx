/**
 * Settings → Models' "Default model" row: the composer's harness picker
 * (`ModelPicker`, settings variant) in place of a plain select. The saved
 * default is a bare model id with no instance, so it is marked where New task
 * would seed it (`newTaskModelPick`): under the first instance the pickers
 * offer it from, and only under a switched-off one when no other lists it. A
 * pick saves only its model. With nothing saved the row shows the first model
 * the pickers offer.
 */

import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import { SettingsDefaults, settingsFormFields } from "@poseidon/contracts/settings";
import * as React from "react";

import { ModelPicker } from "@/components/model-picker";
import { useNewTaskModelPick } from "@/lib/use-model-picker-prefs";

import { SettingsRow } from "./schema-form";

const MODEL_FIELD = settingsFormFields(SettingsDefaults).find((field) => field.key === "model");

export function DefaultModelRow({
  catalog,
  defaultModel,
  onPick,
}: {
  /** Every enabled instance's models, unfiltered: the picker filters them itself. */
  readonly catalog: ReadonlyArray<ConnectorModels>;
  readonly defaultModel: string | null;
  readonly onPick: (model: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const pick = useNewTaskModelPick(catalog, defaultModel);
  if (MODEL_FIELD === undefined) {
    return null;
  }
  return (
    <SettingsRow field={MODEL_FIELD}>
      <ModelPicker
        variant="settings"
        catalog={catalog}
        instanceId={pick?.connectorInstanceId ?? null}
        model={pick?.model ?? ""}
        locked={false}
        title={MODEL_FIELD.label}
        open={open}
        onOpenChange={setOpen}
        onPick={(next) => onPick(next.model)}
      />
    </SettingsRow>
  );
}
