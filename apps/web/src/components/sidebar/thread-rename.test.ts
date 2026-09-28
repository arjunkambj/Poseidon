import { describe, expect, it } from "vitest";

import { endRename, renameTarget } from "./thread-rename";

describe("renameTarget", () => {
  it("sends a changed title, trimmed", () => {
    expect(renameTarget("Old", "New")).toBe("New");
    expect(renameTarget("Old", "  New title \n")).toBe("New title");
  });

  it("sends nothing for an empty or blank draft", () => {
    expect(renameTarget("Old", "")).toBeNull();
    expect(renameTarget("Old", "   ")).toBeNull();
  });

  it("sends nothing when the title is unchanged, whitespace aside", () => {
    expect(renameTarget("Old", "Old")).toBeNull();
    expect(renameTarget("Old", "  Old  ")).toBeNull();
  });
});

describe("endRename", () => {
  it("ends the rename of the thread it names", () => {
    expect(endRename("t1", "t1")).toBeNull();
  });

  it("leaves another row's rename, or none, alone", () => {
    expect(endRename("t2", "t1")).toBe("t2");
    expect(endRename(null, "t1")).toBeNull();
  });
});
