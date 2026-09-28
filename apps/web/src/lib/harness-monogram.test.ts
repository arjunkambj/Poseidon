import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import { describe, expect, it } from "vitest";

import { catalogMonograms, harnessMonograms } from "./harness-monogram";

// Two two-word names with the same initials, and a one-word name that spells
// the first one's fallback: the shape of the shipped harnesses' names.
const PAIR = ["Comet Cloud", "Cedar Cove"];
const TRIO = [...PAIR, "Corvid"];

describe("harnessMonograms", () => {
  it("uses the initials of the first two words, or a one-word name's first two letters", () => {
    expect(harnessMonograms(["Cedar Cove"])).toEqual(["CC"]);
    expect(harnessMonograms(["Corvid"])).toEqual(["Co"]);
    expect(harnessMonograms(["open code agent"])).toEqual(["OC"]);
    expect(harnessMonograms(["x"])).toEqual(["X"]);
  });

  it("falls back to the first word's first two letters when initials collide", () => {
    expect(harnessMonograms(PAIR)).toEqual(["Co", "Ce"]);
  });

  it("steps every name in a tie down, so order does not matter", () => {
    expect(harnessMonograms(TRIO)).toEqual(["Ct", "Ce", "Cd"]);
    expect(harnessMonograms([...TRIO].reverse())).toEqual(["Cd", "Ce", "Ct"]);
  });

  it("numbers names that run out of letters to tell apart", () => {
    expect(harnessMonograms(["Corvid", "Corvid"])).toEqual(["C1", "C2"]);
    expect(harnessMonograms(["", "Corvid"])).toEqual(["?1", "Co"]);
  });

  it("gives no two names the same monogram", () => {
    const names = [...TRIO, "Corvid (work)", "Cypress"];
    expect(new Set(harnessMonograms(names)).size).toBe(names.length);
  });
});

describe("catalogMonograms", () => {
  it("keys each instance's monogram by its id, settled over the whole catalog", () => {
    const catalog = TRIO.map(
      (displayName, index) =>
        ({
          connector: { connectorInstanceId: `i${index}`, displayName },
          models: [],
        }) as unknown as ConnectorModels,
    );
    expect([...catalogMonograms(catalog)]).toEqual([
      ["i0", "Ct"],
      ["i1", "Ce"],
      ["i2", "Cd"],
    ]);
  });
});
