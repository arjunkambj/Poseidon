/**
 * The pure half of Settings → Models' "Writing model" select: which harnesses
 * and models it offers, and what its closed trigger reads.
 *
 * Only a harness that declares `textGeneration` can write, so every other is
 * left out. Within those, the model pickers' own switches apply
 * (`visibleCatalog`): a harness or model switched off is not offered. The
 * saved pick is always kept, like the pickers keep a thread's, so the select
 * never reads a value it cannot show; the server passes over a pick that is
 * switched off and says so when it writes.
 *
 * The row's description says why the list is short while the catalog is still
 * loading or failed to load, and only says nothing can write once it answered.
 *
 * A select item holds one string, so a pick is encoded with `encodeModelPick`
 * and "Same as the thread" (stored as null) with a sentinel.
 */

import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { WritingModel } from "@poseidon/contracts/generation";
import type { ModelPickerSettings } from "@poseidon/contracts/settings";

import type { ModelCatalogState } from "@/lib/model-catalog-state";
import { decodeModelPick, encodeModelPick } from "@/lib/model-picks";
import { visibleCatalog } from "@/lib/model-visibility";

/** The select value that stands for `writingModel: null`. */
export const SAME_AS_THREAD = "__same-as-thread__";
export const SAME_AS_THREAD_LABEL = "Same as the thread";

export interface WritingModelItem {
  readonly value: string;
  readonly label: string;
}

export interface WritingModelGroup {
  readonly connectorInstanceId: string;
  readonly displayName: string;
  readonly items: ReadonlyArray<WritingModelItem>;
}

/** The select's groups, one per harness that can write and is offered, in catalog order. */
export const writingModelGroups = (
  catalog: ReadonlyArray<ConnectorModels>,
  prefs: ModelPickerSettings,
  current: WritingModel | null,
): ReadonlyArray<WritingModelGroup> => {
  const writers = catalog.filter(
    ({ connector }) =>
      connector.capabilities?.textGeneration === true ||
      connector.connectorInstanceId === current?.connectorInstanceId,
  );
  return visibleCatalog(writers, prefs, current).map(({ connector, models }) => ({
    connectorInstanceId: connector.connectorInstanceId,
    displayName: connector.displayName,
    items: models.map((model) => ({
      value: encodeModelPick({
        connectorInstanceId: connector.connectorInstanceId,
        model: model.id,
      }),
      label: model.label,
    })),
  }));
};

/** The Writing model row's description, from the catalog's state and what it offers. */
export const writingModelDescription = (
  state: ModelCatalogState,
  groups: ReadonlyArray<WritingModelGroup>,
): string => {
  if (state.status === "loading") {
    return "Loading models… Same as the thread uses the thread's own harness and model.";
  }
  if (state.status === "failed") {
    return `Could not list the harnesses: ${state.message}`;
  }
  return groups.length === 0
    ? "No harness that is on can write text yet, so the thread's own model is used."
    : "Same as the thread uses the thread's own harness and model.";
};

/** The select's value for the stored pick. */
export const writingModelValue = (current: WritingModel | null): string =>
  current === null ? SAME_AS_THREAD : encodeModelPick(current);

/** The stored pick for a select value, or undefined for one that is not a pick. */
export const writingModelOf = (value: string): WritingModel | null | undefined => {
  if (value === SAME_AS_THREAD) {
    return null;
  }
  const pick = decodeModelPick(value);
  return pick?.connectorInstanceId == null
    ? undefined
    : { connectorInstanceId: pick.connectorInstanceId, model: pick.model };
};

/**
 * What the closed trigger reads: the model's label, or its id while the
 * catalog does not list it (still loading, or its harness is gone).
 */
export const writingModelLabel = (
  groups: ReadonlyArray<WritingModelGroup>,
  value: unknown,
): string => {
  if (typeof value !== "string" || value === SAME_AS_THREAD) {
    return SAME_AS_THREAD_LABEL;
  }
  const item = groups.flatMap((group) => group.items).find((entry) => entry.value === value);
  return item?.label ?? decodeModelPick(value)?.model ?? SAME_AS_THREAD_LABEL;
};
