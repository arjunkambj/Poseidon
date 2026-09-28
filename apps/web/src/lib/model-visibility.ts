/**
 * Which harnesses and models the model pickers offer, from the settings
 * document's `modelPicker` switches. Every harness is on and every model is on
 * unless its connector marks it `hidden`; a stored switch overrides either.
 *
 * This filters what a picker lists and nothing else. `modelCatalogAtom` stays
 * whole, so a lookup such as `findModel` (the effort ladder, the context
 * window) still sees a switched-off model, and a thread already on one keeps
 * it: `visibleCatalog` always keeps the pick it is given.
 */

import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ModelOption } from "@poseidon/contracts/connectors";
import type { ThreadSettingsPatch } from "@poseidon/contracts/orchestration";
import type { ModelPickerSettings } from "@poseidon/contracts/settings";
import { DEFAULT_MODEL_PICKER_SETTINGS } from "@poseidon/contracts/settings";

import { defaultModelPick, type ModelPick } from "@/lib/model-picks";

/** A stored switch, read as an own key so an id like `constructor` is not a hit. */
const stored = (
  record: Readonly<Record<string, boolean>> | undefined,
  key: string,
): boolean | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

export const harnessOn = (prefs: ModelPickerSettings, instanceId: string): boolean =>
  stored(prefs.harnesses, instanceId) ?? true;

export const modelOn = (
  prefs: ModelPickerSettings,
  instanceId: string,
  model: ModelOption,
): boolean => {
  const models = Object.hasOwn(prefs.models, instanceId) ? prefs.models[instanceId] : undefined;
  return stored(models, model.id) ?? model.hidden !== true;
};

/**
 * The catalog a picker lists: the harnesses and models that are on, in the
 * catalog's order. `keep` — the thread's current pick, a new task's, or the
 * picks a compare menu has ticked — is never dropped: its instance stays
 * listed even with its harness off (with its models that are on, so a thread
 * bound to it can still switch among them), and its model stays listed even
 * when switched off. An instance with no model left is dropped, unless one of
 * `keep` is under it.
 */
export const visibleCatalog = (
  catalog: ReadonlyArray<ConnectorModels>,
  prefs: ModelPickerSettings,
  keep: ModelPick | ReadonlyArray<ModelPick> | null,
): ReadonlyArray<ConnectorModels> => {
  const keeps: ReadonlyArray<ModelPick> = keep === null ? [] : "model" in keep ? [keep] : keep;
  return catalog.flatMap((group) => {
    const instanceId = group.connector.connectorInstanceId;
    const kept = keeps.filter((pick) => pick.connectorInstanceId === instanceId);
    if (kept.length === 0 && !harnessOn(prefs, instanceId)) {
      return [];
    }
    const models = group.models.filter(
      (model) => kept.some((pick) => pick.model === model.id) || modelOn(prefs, instanceId, model),
    );
    if (models.length === 0 && kept.length === 0) {
      return [];
    }
    return [models.length === group.models.length ? group : { ...group, models }];
  });
};

/**
 * What a new task shows before the user picks (`defaultModelPick`): a saved
 * default under the first instance the pickers offer it from, so a second
 * instance of a harness that is on wins over a first one switched off; failing
 * that, wherever the full catalog lists it, since the user chose it. With none
 * saved, the first model the pickers offer, so a harness or model switched off
 * is never the implicit seed.
 */
export const newTaskModelPick = (
  catalog: ReadonlyArray<ConnectorModels>,
  prefs: ModelPickerSettings,
  defaultModel: string | null | undefined,
): ModelPick | null => {
  const visible = visibleCatalog(catalog, prefs, null);
  const offered =
    defaultModel == null ||
    visible.some(({ models }) => models.some((model) => model.id === defaultModel));
  return defaultModelPick(offered ? visible : catalog, defaultModel);
};

/**
 * The model a thread created without one starts on — the sidebar's "+", the
 * palette, the new-thread key — as a `thread.create` settings patch: New
 * task's seed (`newTaskModelPick`), so every way of creating a thread honours
 * the switches. Nothing while no instance lists that model (the catalog is
 * still loading, or the saved default is not listed), which leaves the choice
 * to the server's seed rule as before.
 */
export const threadCreateSeed = (
  catalog: ReadonlyArray<ConnectorModels>,
  prefs: ModelPickerSettings,
  defaultModel: string | null | undefined,
): ThreadSettingsPatch | undefined => {
  const pick = newTaskModelPick(catalog, prefs, defaultModel);
  return pick?.connectorInstanceId == null
    ? undefined
    : { model: pick.model, connectorInstanceId: pick.connectorInstanceId };
};

/** The switches with one harness set. */
export const setHarness = (
  prefs: ModelPickerSettings,
  instanceId: string,
  on: boolean,
): ModelPickerSettings => ({
  ...prefs,
  harnesses: { ...prefs.harnesses, [instanceId]: on },
});

/** The switches with one model under one harness set. */
export const setModel = (
  prefs: ModelPickerSettings,
  instanceId: string,
  modelId: string,
  on: boolean,
): ModelPickerSettings => ({
  ...prefs,
  models: {
    ...prefs.models,
    [instanceId]: {
      ...(Object.hasOwn(prefs.models, instanceId) ? prefs.models[instanceId] : {}),
      [modelId]: on,
    },
  },
});

/**
 * Every harness and every model in the catalog switched on explicitly —
 * a model its connector hides included, which is the difference from a reset.
 */
export const enableAll = (catalog: ReadonlyArray<ConnectorModels>): ModelPickerSettings => ({
  harnesses: Object.fromEntries(
    catalog.map(({ connector }) => [connector.connectorInstanceId, true]),
  ),
  models: Object.fromEntries(
    catalog.map(({ connector, models }) => [
      connector.connectorInstanceId,
      Object.fromEntries(models.map((model) => [model.id, true])),
    ]),
  ),
});

/** No switch stored: every default applies again. */
export const resetVisibility = (): ModelPickerSettings => ({
  harnesses: { ...DEFAULT_MODEL_PICKER_SETTINGS.harnesses },
  models: { ...DEFAULT_MODEL_PICKER_SETTINGS.models },
});

const visibleModels = (
  catalog: ReadonlyArray<ConnectorModels>,
  prefs: ModelPickerSettings,
): ReadonlyArray<{ readonly instanceId: string; readonly modelId: string }> =>
  visibleCatalog(catalog, prefs, null).flatMap(({ connector, models }) =>
    models.map((model) => ({ instanceId: connector.connectorInstanceId, modelId: model.id })),
  );

/**
 * Whether this model is the only one any picker still offers, so switching it
 * off would leave the pickers empty. Settings refuses that switch.
 */
export const isLastVisible = (
  catalog: ReadonlyArray<ConnectorModels>,
  prefs: ModelPickerSettings,
  instanceId: string,
  modelId: string,
): boolean => {
  const visible = visibleModels(catalog, prefs);
  return (
    visible.length === 1 && visible[0]?.instanceId === instanceId && visible[0].modelId === modelId
  );
};

/**
 * Whether this harness holds every model the pickers still offer, so
 * switching it off would leave them empty.
 */
export const isLastVisibleHarness = (
  catalog: ReadonlyArray<ConnectorModels>,
  prefs: ModelPickerSettings,
  instanceId: string,
): boolean => {
  const visible = visibleModels(catalog, prefs);
  return visible.length > 0 && visible.every((entry) => entry.instanceId === instanceId);
};
