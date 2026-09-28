/**
 * The glue between the harness picker's DOM and its keyboard model
 * (`@/lib/harness-picker`): which `KeyboardEvent.key` becomes which step, and
 * which option id the search input's `aria-activedescendant` names. Kept out
 * of the component so the static-markup tests can reach it without a DOM.
 */

import {
  pickerKey,
  pickerReduce,
  searchModels,
  type HarnessRailEntry,
  type PickerOptions,
  type PickerState,
  type PickerStep,
} from "@/lib/harness-picker";

/** The step a key press takes, or `null` for a key the picker leaves to the input. */
export const keyStep = (
  key: string,
  state: PickerState,
  rail: ReadonlyArray<HarnessRailEntry>,
  options?: PickerOptions,
): PickerStep | null => {
  const event = pickerKey(key);
  return event === null ? null : pickerReduce(state, event, rail, options);
};

/** An avatar on the rail. */
export const harnessOptionId = (base: string, harness: number) => `${base}-harness-${harness}`;

/** A row of one harness's flyout; every flyout is in the DOM, so the harness is part of it. */
export const modelOptionId = (base: string, harness: number, model: number) =>
  `${base}-model-${harness}-${model}`;

/** A row of the flat search results. */
export const resultOptionId = (base: string, result: number) => `${base}-result-${result}`;

/** The option the state highlights, if it exists. */
export const activeOptionId = (
  base: string,
  state: PickerState,
  rail: ReadonlyArray<HarnessRailEntry>,
): string | undefined => {
  if (state.query.trim().length > 0) {
    return searchModels(rail, state.query)[state.result] === undefined
      ? undefined
      : resultOptionId(base, state.result);
  }
  if (rail[state.harness] === undefined) {
    return undefined;
  }
  if (state.zone === "rail") {
    return harnessOptionId(base, state.harness);
  }
  return rail[state.harness]?.items[state.model] === undefined
    ? undefined
    : modelOptionId(base, state.harness, state.model);
};
