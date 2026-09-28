/**
 * The model picker's data: one section per enabled connector instance
 * (`modelCatalogAtom`), and a pick that names the instance as well as the
 * model. Two instances of one harness list the same model ids, so a model id
 * alone cannot say which instance a thread should run on.
 *
 * A thread that has run anything is bound to its instance (the server's
 * `threadLocksConnector` rule): the other sections stay on screen, disabled,
 * so the picker still says what exists and the tooltip can say how to get it.
 */

import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import type { ConnectorSummary, ModelOption } from "@poseidon/contracts/connectors";
import type { Effort } from "@poseidon/contracts/enums";
import type { ThreadSettingsPatch } from "@poseidon/contracts/orchestration";
import { isString } from "effect/Predicate";

/** A model under an instance. `null` only for a current value no instance lists. */
export interface ModelPick {
  readonly connectorInstanceId: ConnectorInstanceId | null;
  readonly model: string;
}

/**
 * A select item's value has to be one string that is unique across sections.
 * JSON keeps it a total round trip whatever either id contains.
 */
export const encodeModelPick = (pick: ModelPick): string =>
  JSON.stringify([pick.connectorInstanceId, pick.model]);

export const decodeModelPick = (value: string): ModelPick | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    return null;
  }
  const [instanceId, model] = parsed as [unknown, unknown];
  if ((instanceId !== null && !isString(instanceId)) || !isString(model) || model.length === 0) {
    return null;
  }
  return { connectorInstanceId: instanceId as ConnectorInstanceId | null, model };
};

export interface ModelPickerItem {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  /** The model's effort ladder as its connector lists it; absent for a verbatim current value. */
  readonly efforts?: ReadonlyArray<Effort>;
  readonly disabled: boolean;
}

export interface ModelPickerGroup {
  readonly connector: ConnectorSummary;
  /** Another instance than the thread's, on a thread that can no longer switch. */
  readonly locked: boolean;
  readonly items: ReadonlyArray<ModelPickerItem>;
}

export const modelPickerGroups = (
  catalog: ReadonlyArray<ConnectorModels>,
  current: { readonly instanceId: ConnectorInstanceId | null; readonly locked: boolean },
): ReadonlyArray<ModelPickerGroup> =>
  catalog.map(({ connector, models }) => {
    const locked = current.locked && connector.connectorInstanceId !== current.instanceId;
    return {
      connector,
      locked,
      items: models.map((model) => ({
        value: encodeModelPick({
          connectorInstanceId: connector.connectorInstanceId,
          model: model.id,
        }),
        label: model.label,
        description: model.family,
        efforts: model.efforts,
        disabled: locked,
      })),
    };
  });

/**
 * The settings patch a pick asks for. On a locked thread the only enabled
 * section is the thread's own, so the instance says nothing new — and the
 * thread may not have stored one at all — so it stays out of the patch and
 * the pick is a model change, as it always was.
 */
export const modelPickPatch = (pick: ModelPick, locked: boolean): ThreadSettingsPatch =>
  locked || pick.connectorInstanceId === null
    ? { model: pick.model }
    : { model: pick.model, connectorInstanceId: pick.connectorInstanceId };

/** The model a thread is on, looked up under its own instance first. */
export const findModel = (
  catalog: ReadonlyArray<ConnectorModels>,
  pick: ModelPick,
): ModelOption | undefined => {
  const own = catalog.find(
    (group) => group.connector.connectorInstanceId === pick.connectorInstanceId,
  );
  return (
    own?.models.find((model) => model.id === pick.model) ??
    catalog.flatMap((group) => group.models).find((model) => model.id === pick.model)
  );
};

/**
 * What a new thread shows before the user picks: the saved default model
 * under the first instance that lists it, else the first enabled instance's
 * first model. A saved default no instance lists (yet — the catalog may still
 * be loading) is shown verbatim with no instance, which leaves the choice to
 * the server's default rule, as it was before instances could be picked.
 */
export const defaultModelPick = (
  catalog: ReadonlyArray<ConnectorModels>,
  defaultModel: string | null | undefined,
): ModelPick | null => {
  if (defaultModel != null) {
    const listing = catalog.find((group) =>
      group.models.some((model) => model.id === defaultModel),
    );
    return {
      connectorInstanceId: listing?.connector.connectorInstanceId ?? null,
      model: defaultModel,
    };
  }
  for (const { connector, models } of catalog) {
    const [first] = models;
    if (first !== undefined) {
      return { connectorInstanceId: connector.connectorInstanceId, model: first.id };
    }
  }
  return null;
};
