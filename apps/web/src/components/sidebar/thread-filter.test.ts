import { describe, expect, it } from "vitest";

import {
  isFiltering,
  matchesTitle,
  onFilterFocusRequest,
  requestFilterFocus,
  takeFilterFocus,
} from "./thread-filter";

describe("matchesTitle", () => {
  it("matches everything for an empty or blank query", () => {
    expect(matchesTitle("Anything", "")).toBe(true);
    expect(matchesTitle("", "   ")).toBe(true);
  });

  it("ignores case on both sides", () => {
    expect(matchesTitle("Fix the Login bug", "login")).toBe(true);
    expect(matchesTitle("fix the login bug", "LOGIN")).toBe(true);
  });

  it("trims the query but keeps inner spaces", () => {
    expect(matchesTitle("Release notes v2", "  notes v2 ")).toBe(true);
    expect(matchesTitle("Release notesv2", "notes v2")).toBe(false);
  });

  it("rejects a title without the query", () => {
    expect(matchesTitle("Refactor sidebar", "login")).toBe(false);
  });
});

describe("isFiltering", () => {
  it("is false only for a blank query", () => {
    expect(isFiltering("")).toBe(false);
    expect(isFiltering("  ")).toBe(false);
    expect(isFiltering(" a ")).toBe(true);
  });
});

describe("filter focus requests", () => {
  it("are taken once, and tell a mounted field at once", () => {
    let told = 0;
    const release = onFilterFocusRequest(() => {
      told += 1;
    });
    expect(takeFilterFocus()).toBe(false);
    requestFilterFocus();
    expect(told).toBe(1);
    expect(takeFilterFocus()).toBe(true);
    expect(takeFilterFocus()).toBe(false);
    release();
    requestFilterFocus();
    expect(told).toBe(1);
    expect(takeFilterFocus()).toBe(true);
  });
});
