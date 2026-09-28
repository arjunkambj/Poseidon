/**
 * The choices for the `autoDoneAfterDays` setting, which moves a thread to
 * the sidebar's Done section once it has been idle that many days (see
 * `@/components/sidebar/thread-done`). A `<Select>` cannot hold `null`, so
 * "Off" is the `"off"` stand-in; a patch turns the setting off with `null`,
 * since it leaves an absent field alone.
 */

import type { LabelledOption } from "./select-label";

const OFF = "off";

export const AUTO_DONE_OPTIONS: ReadonlyArray<LabelledOption> = [
  { value: OFF, label: "Off" },
  ...[1, 3, 7, 14, 30].map((days) => ({
    value: String(days),
    label: days === 1 ? "After 1 day" : `After ${days} days`,
  })),
];

/** The select's value for a stored setting: absent and `null` are both off. */
export const autoDoneValue = (days: number | null | undefined): string =>
  days === undefined || days === null ? OFF : String(days);

/** The settings patch value for a picked option. */
export const autoDoneDays = (value: string): number | null => {
  const days = Number(value);
  return value === OFF || !Number.isInteger(days) || days <= 0 ? null : days;
};
