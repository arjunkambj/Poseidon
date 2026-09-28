/**
 * The effort picker's rungs, lowest first.
 *
 * A connector reports each model's ladder in whatever order its harness prints
 * it; the picker always reads bottom to top in the contract's `EFFORT_ORDER`.
 * A model that states no ladder offers every rung.
 */

import { EFFORT_ORDER, type Effort } from "@poseidon/contracts/enums";

export const orderEfforts = (
  efforts: ReadonlyArray<Effort> | null | undefined,
): ReadonlyArray<Effort> =>
  efforts == null ? EFFORT_ORDER : EFFORT_ORDER.filter((effort) => efforts.includes(effort));

/** What a settings select calls each rung, in place of the raw value (`xhigh`). */
export const EFFORT_LABELS: Readonly<Record<Effort, string>> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/**
 * One rung up (`1`) or down (`-1`) the model's ladder from `current`, for the
 * effort keys. It stops at either end rather than wrapping — a key that jumped
 * from the top rung to the bottom would be a surprise mid-thread. A current
 * effort the model does not list moves to the nearest rung in that direction.
 */
export const stepEffort = (
  current: Effort,
  efforts: ReadonlyArray<Effort> | null | undefined,
  step: 1 | -1,
): Effort => {
  const rank = EFFORT_ORDER.indexOf(current);
  const ladder = orderEfforts(efforts);
  const next =
    step === 1
      ? ladder.find((effort) => EFFORT_ORDER.indexOf(effort) > rank)
      : ladder.findLast((effort) => EFFORT_ORDER.indexOf(effort) < rank);
  return next ?? current;
};
