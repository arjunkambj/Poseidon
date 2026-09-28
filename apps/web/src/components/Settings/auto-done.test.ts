import { describe, expect, it } from "vitest";

import { AUTO_DONE_OPTIONS, autoDoneDays, autoDoneValue } from "./auto-done";
import { selectedOptionLabel } from "./select-label";

describe("the auto-done choices", () => {
  it("reads an absent or null setting as Off", () => {
    expect(autoDoneValue(undefined)).toBe("off");
    expect(autoDoneValue(null)).toBe("off");
    expect(selectedOptionLabel(AUTO_DONE_OPTIONS, autoDoneValue(undefined))).toBe("Off");
  });

  it("round-trips every offered number of days", () => {
    for (const option of AUTO_DONE_OPTIONS.slice(1)) {
      const days = autoDoneDays(option.value);
      expect(days).not.toBeNull();
      expect(autoDoneValue(days)).toBe(option.value);
    }
    expect(selectedOptionLabel(AUTO_DONE_OPTIONS, autoDoneValue(7))).toBe("After 7 days");
  });

  it("turns the setting off with null", () => {
    expect(autoDoneDays("off")).toBeNull();
  });
});
