import { EFFORT_ORDER } from "@poseidon/contracts/enums";
import { describe, expect, it } from "vitest";

import { EFFORT_LABELS, EFFORT_NOTES, orderEfforts, stepEffort, withNote } from "./efforts";

describe("orderEfforts", () => {
  it("offers the whole ladder but ultra when the model states none", () => {
    const everyday = EFFORT_ORDER.filter((effort) => effort !== "ultra");
    expect(orderEfforts(undefined)).toEqual(everyday);
    expect(orderEfforts(null)).toEqual(everyday);
  });

  it("offers ultra only where the model lists it", () => {
    expect(orderEfforts(["ultra", "high", "max"])).toEqual(["high", "max", "ultra"]);
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

  it("never steps onto ultra, but steps down from it", () => {
    expect(stepEffort("max", ["high", "max", "ultra"], 1)).toBe("max");
    expect(stepEffort("ultra", ["high", "max", "ultra"], 1)).toBe("ultra");
    expect(stepEffort("ultra", ["high", "max", "ultra"], -1)).toBe("max");
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
      "Ultra",
    ]);
  });
});

describe("withNote", () => {
  it("gives ultra its cost note and leaves every other rung as it is", () => {
    expect(withNote({ value: "ultra" }, "ultra")).toEqual({
      value: "ultra",
      description: EFFORT_NOTES.ultra,
    });
    expect(EFFORT_NOTES.ultra).toContain("uses many more tokens");
    for (const effort of EFFORT_ORDER.filter((rung) => rung !== "ultra")) {
      expect(withNote({ value: effort }, effort)).toEqual({ value: effort });
    }
  });
});
