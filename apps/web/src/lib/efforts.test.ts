import { EFFORT_ORDER } from "@poseidon/contracts/enums";
import { describe, expect, it } from "vitest";

import { EFFORT_LABELS, orderEfforts, stepEffort } from "./efforts";

describe("orderEfforts", () => {
  it("offers the whole ladder when the model states none", () => {
    expect(orderEfforts(undefined)).toEqual(EFFORT_ORDER);
    expect(orderEfforts(null)).toEqual(EFFORT_ORDER);
  });

  it("orders a model's rungs by the canonical ladder", () => {
    expect(orderEfforts(["max", "low", "high"])).toEqual(["low", "high", "max"]);
  });

  it("drops duplicates rather than listing a rung twice", () => {
    expect(orderEfforts(["medium", "medium", "minimal"])).toEqual(["minimal", "medium"]);
  });
});

describe("stepEffort", () => {
  it("steps one rung up and down the model's ladder", () => {
    expect(stepEffort("medium", ["low", "medium", "high"], 1)).toBe("high");
    expect(stepEffort("medium", ["low", "medium", "high"], -1)).toBe("low");
  });

  it("reads the ladder in canonical order whatever order the model gave", () => {
    expect(stepEffort("low", ["max", "high", "low"], 1)).toBe("high");
  });

  it("stops at either end instead of wrapping", () => {
    expect(stepEffort("high", ["low", "medium", "high"], 1)).toBe("high");
    expect(stepEffort("low", ["low", "medium", "high"], -1)).toBe("low");
  });

  it("uses the whole ladder when the model states none", () => {
    expect(stepEffort("medium", undefined, 1)).toBe("high");
    expect(stepEffort("minimal", null, -1)).toBe("minimal");
  });

  it("moves an unlisted effort to the nearest rung in that direction", () => {
    expect(stepEffort("medium", ["low", "high"], 1)).toBe("high");
    expect(stepEffort("medium", ["low", "high"], -1)).toBe("low");
  });

  it("does nothing with a single rung", () => {
    expect(stepEffort("high", ["high"], 1)).toBe("high");
    expect(stepEffort("high", ["high"], -1)).toBe("high");
  });
});

describe("EFFORT_LABELS", () => {
  it("names every rung in words, lowest first", () => {
    expect(EFFORT_ORDER.map((effort) => EFFORT_LABELS[effort])).toEqual([
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Max",
    ]);
  });
});
