import { describe, expect, it } from "vitest";

import { keepAwakeNote } from "./keep-awake-state";

describe("keepAwakeNote", () => {
  it("says the setting is desktop-only in a plain browser", () => {
    expect(keepAwakeNote(false, null)).toBe("Only in the desktop app");
    expect(keepAwakeNote(false, true)).toBe("Only in the desktop app");
  });

  it("says whether the desktop app is holding the machine awake", () => {
    expect(keepAwakeNote(true, true)).toBe("Holding: an agent is running");
    expect(keepAwakeNote(true, false)).toBe("Not holding: nothing is running");
  });

  it("reads not holding before the coordinator has asked the shell", () => {
    expect(keepAwakeNote(true, null)).toBe("Not holding: nothing is running");
  });
});
