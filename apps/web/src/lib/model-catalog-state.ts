/**
 * Whether `modelCatalogAtom` has answered, so a picker or Settings → Models
 * can tell "still asking the harnesses" and "could not ask" from "nothing to
 * list". The atom starts as an empty success that is still waiting (its
 * `initialValue`), so an empty list on its own says nothing.
 *
 * `emptyPickerText` is what a harness picker with nothing on its rail says,
 * with the reason it is empty: loading, a failure, no harness enabled on the
 * Connectors page, no harness listing a model, or every harness switched off
 * in Settings → Models.
 */

import { useAtomValue } from "@effect/atom-react";
import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";

export type ModelCatalogState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready" };

const FAILED = "Could not list the harnesses";

export const modelCatalogState = (
  result: AsyncResult.AsyncResult<ReadonlyArray<ConnectorModels>, unknown>,
): ModelCatalogState => {
  if (AsyncResult.isFailure(result)) {
    return { status: "failed", message: describeExitError(Exit.failCause(result.cause), FAILED) };
  }
  if (AsyncResult.isInitial(result) || (result.waiting && result.value.length === 0)) {
    return { status: "loading" };
  }
  return { status: "ready" };
};

export function useModelCatalogState(): ModelCatalogState {
  const atoms = useAppAtoms();
  return modelCatalogState(useAtomValue(atoms.modelCatalogAtom));
}

export interface EmptyText {
  readonly title: string;
  readonly description: string;
}

/** Why a picker has no harness to show, given the whole, unfiltered catalog. */
export const emptyPickerText = (
  state: ModelCatalogState,
  catalog: ReadonlyArray<ConnectorModels>,
): EmptyText => {
  if (state.status === "loading") {
    return { title: "Loading models", description: "Asking each harness for its models." };
  }
  if (state.status === "failed") {
    return { title: FAILED, description: state.message };
  }
  if (catalog.length === 0) {
    return {
      title: "No harness enabled",
      description: "Enable a connector on the Connectors page.",
    };
  }
  if (catalog.every(({ models }) => models.length === 0)) {
    return {
      title: "No models",
      description: "No harness listed any models. Check them on the Connectors page.",
    };
  }
  return { title: "No models", description: "Switch a harness on in Settings → Models." };
};
