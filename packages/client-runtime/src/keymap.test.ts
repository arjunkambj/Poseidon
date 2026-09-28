import { describe, expect, it } from "vitest";

import type { Keybinding } from "@poseidon/contracts/settings";

import { parseShortcut } from "./keybindings";
import {
  CONTEXT_AXIOMS,
  KEYBINDING_CONTEXT_KEYS,
  SYSTEM_RESERVED_CHORDS,
  findKeybindingConflicts,
  physicalChord,
  reservedChordReason,
  whenOverlaps,
} from "./keymap";

describe("KEYBINDING_CONTEXT_KEYS", () => {
  it("names every key the axioms mention, once", () => {
    const names = KEYBINDING_CONTEXT_KEYS.map((key) => key.name);
    expect(new Set(names).size).toBe(names.length);
    const mentioned = [
      ...CONTEXT_AXIOMS.implies.flat(),
      ...CONTEXT_AXIOMS.exclusive.flat(),
      CONTEXT_AXIOMS.platform,
    ];
    for (const name of mentioned) {
      expect(names).toContain(name);
    }
  });

  it("keeps threadRunning as an alias of turnRunning", () => {
    const turn = KEYBINDING_CONTEXT_KEYS.find((key) => key.name === "turnRunning");
    expect(turn?.aliases).toEqual(["threadRunning"]);
    expect(whenOverlaps("threadRunning", "!turnRunning", "meta")).toBe(false);
  });
});

describe("whenOverlaps", () => {
  it("overlaps anything with a missing or empty clause", () => {
    expect(whenOverlaps(undefined, "approvalPending", "meta")).toBe(true);
    expect(whenOverlaps("", "", "ctrl")).toBe(true);
  });

  it("separates contradictory clauses", () => {
    expect(whenOverlaps("threadOpen", "!threadOpen", "meta")).toBe(false);
    expect(whenOverlaps("a && b", "a || c", "meta")).toBe(true);
  });

  it("keeps the pending flags apart", () => {
    expect(whenOverlaps("approvalPending", "planPending", "meta")).toBe(false);
    expect(whenOverlaps("approvalPending", "questionPending || planPending", "ctrl")).toBe(false);
    expect(whenOverlaps("approvalPending", "turnRunning", "ctrl")).toBe(true);
  });

  it("knows which focus keys imply and exclude each other", () => {
    expect(whenOverlaps("composerFocus && !inputFocus", undefined, "meta")).toBe(false);
    expect(whenOverlaps("terminalFocus", "!inputFocus", "meta")).toBe(false);
    expect(whenOverlaps("composerFocus", "browserFocus", "meta")).toBe(false);
    expect(whenOverlaps("composerFocus", "inputFocus", "meta")).toBe(true);
    expect(whenOverlaps("!browserFocus", "browserFocus", "meta")).toBe(false);
    expect(whenOverlaps("filesFocus", "composerFocus", "meta")).toBe(false);
    expect(whenOverlaps("filesFocus", "inputFocus", "meta")).toBe(true);
  });

  it("fixes isMac per platform", () => {
    expect(whenOverlaps("isMac", undefined, "meta")).toBe(true);
    expect(whenOverlaps("isMac", undefined, "ctrl")).toBe(false);
    expect(whenOverlaps("!isMac", undefined, "ctrl")).toBe(true);
  });

  it("treats a comparison as an independent flag", () => {
    expect(whenOverlaps('mode == "plan"', 'mode != "plan"', "meta")).toBe(false);
    // Conservative: two different values are not known to exclude each other.
    expect(whenOverlaps('mode == "plan"', 'mode == "default"', "meta")).toBe(true);
  });

  it("never overlaps an unparseable clause", () => {
    expect(whenOverlaps("approvalPending &&", undefined, "meta")).toBe(false);
    expect(whenOverlaps(undefined, "(", "ctrl")).toBe(false);
  });
});

describe("physicalChord", () => {
  it("makes Mod the Control key off macOS", () => {
    const mod = parseShortcut("Mod+K")!;
    const ctrl = parseShortcut("Ctrl+K")!;
    expect(physicalChord(mod, "ctrl")).toEqual(physicalChord(ctrl, "ctrl"));
    expect(physicalChord(mod, "meta")).not.toEqual(physicalChord(ctrl, "meta"));
    expect(physicalChord(mod, "meta")).toEqual({
      key: "k",
      ctrl: false,
      meta: true,
      alt: false,
      shift: false,
    });
  });

  it("names a shifted character by its own key", () => {
    const chord = (shortcut: string) => physicalChord(parseShortcut(shortcut)!, "meta");
    expect(chord("Mod+Shift+{")).toEqual(chord("Mod+Shift+["));
    expect(chord("Shift+?")).toEqual(chord("Shift+/"));
    expect(chord("Mod+Shift+Plus")).toEqual(chord("Mod+Shift+="));
    // Without Shift the character is not typed by that key, so it stays apart.
    expect(chord("Mod+{")).not.toEqual(chord("Mod+["));
  });
});

describe("findKeybindingConflicts", () => {
  it("reports Mod+K against Ctrl+K off macOS only", () => {
    const table: ReadonlyArray<Keybinding> = [
      { command: "a", shortcut: "Mod+K" },
      { command: "b", shortcut: "Ctrl+K" },
    ];
    expect(findKeybindingConflicts(table, "meta")).toEqual([]);
    expect(findKeybindingConflicts(table, "ctrl")).toEqual([
      { first: table[0], second: table[1], platforms: ["ctrl"] },
    ]);
    expect(findKeybindingConflicts(table)).toEqual([
      { first: table[0], second: table[1], platforms: ["ctrl"] },
    ]);
  });

  it("reports a chord shared in overlapping contexts on both platforms", () => {
    const table: ReadonlyArray<Keybinding> = [
      { command: "a", shortcut: "Cmd+K" },
      { command: "b", shortcut: "mod+k" },
      { command: "c", shortcut: "Mod+K", when: "menuOpen" },
      { command: "d", shortcut: "Escape" },
    ];
    const conflicts = findKeybindingConflicts(table);
    expect(conflicts.map((c) => [c.first.command, c.second.command])).toEqual([
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
    expect(conflicts.every((c) => c.platforms.length === 2)).toBe(true);
  });

  it("splits a chord by context", () => {
    const table: ReadonlyArray<Keybinding> = [
      { command: "approval.allowOnce", shortcut: "1", when: "approvalPending" },
      { command: "plan.accept", shortcut: "1", when: "planPending" },
      { command: "nav.back", shortcut: "Mod+[", when: "!browserFocus" },
      { command: "browser.back", shortcut: "Mod+[", when: "browserFocus" },
    ];
    expect(findKeybindingConflicts(table)).toEqual([]);
  });

  it("applies the text-field rule to plain chords", () => {
    // `1` stays out of text fields, so it never meets a composer-only `1`.
    const table: ReadonlyArray<Keybinding> = [
      { command: "approval.allowOnce", shortcut: "1", when: "approvalPending" },
      { command: "composer.one", shortcut: "1", when: "composerFocus" },
    ];
    expect(findKeybindingConflicts(table)).toEqual([]);
    const both: ReadonlyArray<Keybinding> = [
      { command: "approval.allowOnce", shortcut: "1", when: "approvalPending" },
      { command: "anywhere.one", shortcut: "1" },
    ];
    expect(findKeybindingConflicts(both)).toHaveLength(1);
  });

  it("sees a shifted-character spelling as the same chord", () => {
    const table: ReadonlyArray<Keybinding> = [
      { command: "thread.previous", shortcut: "Mod+Shift+[" },
      { command: "legacy", shortcut: "Cmd+Shift+{" },
      { command: "a", shortcut: "Shift+/", when: "!inputFocus" },
      { command: "b", shortcut: "Shift+?", when: "!inputFocus" },
    ];
    expect(findKeybindingConflicts(table).map((c) => [c.first.command, c.second.command])).toEqual([
      ["thread.previous", "legacy"],
      ["a", "b"],
    ]);
  });

  it("ignores a command bound twice, and rows that do not parse", () => {
    const table: ReadonlyArray<Keybinding> = [
      { command: "a", shortcut: "Mod+K" },
      { command: "a", shortcut: "Mod+K", when: "threadOpen" },
      { command: "b", shortcut: "Mod+" },
      { command: "c", shortcut: "Mod+K", when: "threadOpen &&" },
    ];
    expect(findKeybindingConflicts(table)).toEqual([]);
  });
});

describe("reserved chords", () => {
  it("explains a chord the system owns", () => {
    expect(reservedChordReason("Mod+Q", "meta")).toMatch(/quits/i);
    expect(reservedChordReason("Cmd+R", "ctrl")).toMatch(/reload/i);
    expect(reservedChordReason("Ctrl+A", "meta")).toMatch(/text editing/i);
    expect(reservedChordReason("Alt+F4", "ctrl")).toMatch(/closes/i);
  });

  it("is platform-aware", () => {
    expect(reservedChordReason("Ctrl+E", "ctrl")).toBeNull();
    expect(reservedChordReason("Alt+F4", "meta")).toBeNull();
    // Off macOS Ctrl+Space and Mod+Space are the same keys.
    expect(reservedChordReason("Ctrl+Space", "ctrl")).not.toBeNull();
  });

  it("finds a reserved chord under its shifted spelling", () => {
    expect(reservedChordReason("Mod+Shift+?", "meta")).toMatch(/help/i);
    expect(reservedChordReason("Mod+Shift+Plus", "ctrl")).toMatch(/zoom/i);
  });

  it("returns null for a free or unparseable chord", () => {
    expect(reservedChordReason("Mod+K", "meta")).toBeNull();
    expect(reservedChordReason("Mod+R", "meta", "browserFocus")).toBeNull();
    expect(reservedChordReason("Mod+R", "meta", "threadOpen")).toMatch(/reload/i);
    // The Changes pane's file keys, only under the clause that keeps them out
    // of text fields; anywhere else the chord still moves the caret.
    const changes = "changesOpen && !inputFocus && !dialogOpen";
    expect(reservedChordReason("Alt+ArrowDown", "meta", changes)).toBeNull();
    expect(reservedChordReason("Alt+ArrowUp", "ctrl", changes)).toBeNull();
    expect(reservedChordReason("Alt+ArrowDown", "meta", "changesOpen")).toMatch(/word/i);
    expect(reservedChordReason("Mod+", "meta")).toBeNull();
  });

  it("lists only chords that parse", () => {
    for (const platform of ["meta", "ctrl"] as const) {
      for (const entry of SYSTEM_RESERVED_CHORDS[platform]) {
        expect(parseShortcut(entry.shortcut), entry.shortcut).not.toBeNull();
      }
    }
  });
});
