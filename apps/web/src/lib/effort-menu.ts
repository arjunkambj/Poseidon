/**
 * The effort (reasoning) menu's entries, shared by the composer's effort
 * picker (`@/components/header-controls`) and the `/effort` slash level
 * (`@/components/composer/slash-menu`).
 *
 * The menu reads the model's ladder lowest first (`orderEfforts`), and the
 * costly multi-agent modes sit at its top, named and noted alike: `ultra`,
 * which is an effort rung, and ultracode, which is a session flag at `xhigh`
 * (`@/lib/ultracode`). Ultracode is listed where it is
 * offered, and while it is on even where it is not, so the menu never hides
 * the setting it is in and another pick can turn it off. While it is on, the
 * menu's value is the Ultracode entry rather than `xhigh`.
 */

import type { Effort } from "@poseidon/contracts/enums";
import type { ThreadSettingsPatch } from "@poseidon/contracts/orchestration";

import { orderEfforts, stepEffort, withNote } from "./efforts";
import { ultracodePatch } from "./ultracode";

/** The Ultracode entry's value; no effort rung is called that. */
export const ULTRACODE_ENTRY = "ultracode";

/** The Ultracode entry's note, worded like the `ultra` rung's. */
export const ULTRACODE_NOTE = "xhigh effort with multi-agent workflows · uses many more tokens";

export type EffortMenuValue = Effort | typeof ULTRACODE_ENTRY;

export interface EffortMenuEntry {
  readonly value: EffortMenuValue;
  readonly label: string;
  readonly description?: string;
}

/**
 * The menu's entries, lowest first: each rung under its raw value, `ultra`
 * as "Ultra", then "Ultracode" where it is `offered` or `on`.
 */
export const effortMenuEntries = (
  efforts: ReadonlyArray<Effort> | null | undefined,
  ultracode: { readonly offered: boolean; readonly on: boolean },
): ReadonlyArray<EffortMenuEntry> => [
  ...orderEfforts(efforts).map((effort) =>
    withNote({ value: effort, label: effort === "ultra" ? "Ultra" : effort }, effort),
  ),
  ...(ultracode.offered || ultracode.on
    ? [{ value: ULTRACODE_ENTRY, label: "Ultracode", description: ULTRACODE_NOTE } as const]
    : []),
];

/** The entry the menu shows as current: Ultracode while it is on. */
export const effortMenuValue = (effort: Effort, ultracode: boolean): EffortMenuValue =>
  ultracode ? ULTRACODE_ENTRY : effort;

/**
 * What a pick sends: Ultracode switches it on at `xhigh`, a rung sends its
 * effort. A rung picked while ultracode is on turns it off — the header's
 * `settleUltracode` adds that, and the server's rule does the same for a
 * patch that reaches it without.
 */
export const effortMenuPatch = (value: EffortMenuValue): ThreadSettingsPatch =>
  value === ULTRACODE_ENTRY ? ultracodePatch(true) : { effort: value };

/**
 * What an effort key sends, or `null` when it stays put. A step moves along
 * the model's ladder and never onto Ultra or Ultracode (`stepEffort`).
 * Ultracode is the top of the menu, so a step up from it stays put; a step
 * down turns it off and keeps `xhigh`, the effort it ran at, as a step down
 * from `ultra` drops the delegation for the rung below.
 */
export const effortStepPatch = (
  effort: Effort,
  efforts: ReadonlyArray<Effort> | null | undefined,
  ultracode: boolean,
  step: 1 | -1,
): ThreadSettingsPatch | null => {
  if (ultracode) {
    return step === -1 ? ultracodePatch(false) : null;
  }
  const next = stepEffort(effort, efforts, step);
  return next === effort ? null : { effort: next };
};
