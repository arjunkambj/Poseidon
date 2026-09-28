/**
 * A closing dialog keeps what it showed: the value in use while it is set,
 * the one before once it is cleared.
 */

import { describe, expect, it } from "vitest";

import { lastPresent } from "./use-last-present";

describe("lastPresent", () => {
  it("answers the value while it is set", () => {
    expect(lastPresent(null, "merge")).toBe("merge");
    expect(lastPresent("close", "merge")).toBe("merge");
  });

  it("keeps the previous value once it is cleared", () => {
    expect(lastPresent("merge", null)).toBe("merge");
    expect(lastPresent(null, null)).toBeNull();
  });
});
