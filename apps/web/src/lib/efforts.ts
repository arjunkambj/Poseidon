/**
 * The effort picker's rungs, lowest first.
 *
 * A connector reports each model's ladder in whatever order its harness prints
 * it; the picker always reads bottom to top in the contract's `EFFORT_ORDER`.
 * A model that states no ladder offers every rung but `ultra`: that rung spends
 * many more tokens, so it is offered only where a model lists it.
 */

import { EFFORT_ORDER, type Effort } from "@poseidon/contracts/enums";

export const orderEfforts = (
  efforts: ReadonlyArray<Effort> | null | undefined,
): ReadonlyArray<Effort> =>
  efforts == null
    ? EFFORT_ORDER.filter((effort) => effort !== "ultra")
    : EFFORT_ORDER.filter((effort) => efforts.includes(effort));

/** What a settings select calls each rung, in place of the raw value (`xhigh`). */
export const EFFORT_LABELS: Readonly<Record<Effort, string>> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

/**
 * The one-line note a picker shows under a rung that needs one: `ultra`
 * delegates to subagents, and its cost is the reason to pick it on purpose.
 */
export const EFFORT_NOTES: Readonly<Partial<Record<Effort, string>>> = {
  ultra: "Delegates to subagents · uses many more tokens",
};

/** `item` with the rung's note as its description, when the rung has one. */
export const withNote = <T extends object>(
  item: T,
  effort: Effort,
): T | (T & { description: string }) => {
  const note = EFFORT_NOTES[effort];
  return note === undefined ? item : { ...item, description: note };
};

/**
 * One rung up (`1`) or down (`-1`) the model's ladder from `current`, for the
 * effort keys. It stops at either end rather than wrapping — a key that jumped
 * from the top rung to the bottom would be a surprise mid-thread. A current
 * effort the model does not list moves to the nearest rung in that direction.
 * The keys never step onto `ultra`, the costly multi-agent rung: it is picked
 * on purpose or not at all, though stepping down from it works.
 */
export const stepEffort = (
  current: Effort,
  efforts: ReadonlyArray<Effort> | null | undefined,
  step: 1 | -1,
): Effort => {
  const rank = EFFORT_ORDER.indexOf(current);
  const ladder = orderEfforts(efforts).filter((effort) => effort !== "ultra");
  const next =
    step === 1
      ? ladder.find((effort) => EFFORT_ORDER.indexOf(effort) > rank)
      : ladder.findLast((effort) => EFFORT_ORDER.indexOf(effort) < rank);
  return next ?? current;
};
