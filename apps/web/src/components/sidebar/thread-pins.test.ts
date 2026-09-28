import { describe, expect, it } from "vitest";

import { parsePins, withPin, type Pins } from "./thread-pins";

describe("parsePins", () => {
  it("survives every shape localStorage can hand back", () => {
    expect(parsePins(null)).toEqual([]);
    expect(parsePins(undefined)).toEqual([]);
    expect(parsePins("not json")).toEqual([]);
    expect(parsePins('{"a":"b"}')).toEqual([]);
    expect(parsePins('["a",1,null,"b"]')).toEqual(["a", "b"]);
  });

  it("drops duplicates, keeping the first place", () => {
    expect(parsePins('["a","b","a"]')).toEqual(["a", "b"]);
  });
});

describe("withPin", () => {
  it("puts the newest pin first", () => {
    let pins: Pins = [];
    pins = withPin(pins, "a", true);
    pins = withPin(pins, "b", true);
    expect(pins).toEqual(["b", "a"]);
  });

  it("unpins in place, keeping the rest in order", () => {
    expect(withPin(["c", "b", "a"], "b", false)).toEqual(["c", "a"]);
  });

  it("returns the very same list when nothing changed", () => {
    const pins: Pins = ["a", "b"];
    // Pinning again does not move a pin to the front either.
    expect(withPin(pins, "b", true)).toBe(pins);
    expect(withPin(pins, "z", false)).toBe(pins);
  });
});
