import { describe, expect, it } from "vitest";

import { DEFAULT_KEYBINDINGS } from "@poseidon/contracts/keybindings";

import { cheatsheetSections, type CheatsheetRow } from "./cheatsheet";
import { COMMAND_AREAS, COMMAND_CATALOG, FIXED_KEYS } from "./command-catalog";
import { effectiveKeybindings } from "./keybindings";

const rowsOf = (sections: ReturnType<typeof cheatsheetSections>): ReadonlyArray<CheatsheetRow> =>
  sections.flatMap((section) => section.rows);

const row = (sections: ReturnType<typeof cheatsheetSections>, id: string) =>
  rowsOf(sections).find((entry) => entry.id === id);

describe("cheatsheetSections", () => {
  const defaults = effectiveKeybindings([]);

  it("lists every catalog command once, grouped by area in area order", () => {
    const sections = cheatsheetSections(COMMAND_CATALOG, defaults, "", "meta");
    expect(sections.map((section) => section.area)).toEqual([...COMMAND_AREAS]);
    for (const section of sections) {
      for (const entry of section.rows.filter((r) => !r.fixed)) {
        expect(COMMAND_CATALOG.find((c) => c.id === entry.id)?.area).toBe(section.area);
      }
    }
    const ids = rowsOf(sections)
      .filter((r) => !r.fixed)
      .map((r) => r.id);
    expect(ids).toEqual(
      COMMAND_AREAS.flatMap((area) =>
        COMMAND_CATALOG.filter((c) => c.area === area).map((c) => c.id),
      ),
    );
  });

  it("puts the fixed composer keys after the Composer commands", () => {
    const composer = cheatsheetSections(COMMAND_CATALOG, defaults, "", "meta").find(
      (section) => section.area === "Composer",
    );
    const fixed = composer?.rows.filter((r) => r.fixed) ?? [];
    expect(fixed.map((r) => r.title)).toEqual(FIXED_KEYS.map((key) => key.title));
    expect(composer?.rows.at(-1)?.fixed).toBe(true);
  });

  it("draws the platform's keycaps and carries the when clauses", () => {
    const mac = cheatsheetSections(COMMAND_CATALOG, defaults, "", "meta");
    expect(row(mac, "commandPalette.toggle")?.chords.map((c) => c.caps)).toEqual([["⌘", "K"]]);
    const other = cheatsheetSections(COMMAND_CATALOG, defaults, "", "ctrl");
    expect(row(other, "commandPalette.toggle")?.chords.map((c) => c.caps)).toEqual([["Ctrl", "K"]]);
    const deny = row(mac, "approval.deny");
    expect(deny?.chords.map((c) => c.shortcut)).toEqual(["D", "Escape"]);
    expect(deny?.when).toEqual(["approvalPending && !inputFocus && !dialogOpen"]);
    expect(row(mac, "commandPalette.toggle")?.when).toEqual([]);
  });

  it("applies the user's overrides", () => {
    const effective = effectiveKeybindings([
      { command: "commandPalette.toggle", shortcut: "Mod+P" },
      { command: "commandPalette.toggle", shortcut: "Mod+Shift+P", when: "!inputFocus" },
    ]);
    const entry = row(
      cheatsheetSections(COMMAND_CATALOG, effective, "", "meta"),
      "commandPalette.toggle",
    );
    expect(entry?.chords.map((c) => c.shortcut)).toEqual(["Mod+P", "Mod+Shift+P"]);
    expect(entry?.when).toEqual(["!inputFocus"]);
  });

  it("shows an unbound command with no chords", () => {
    const sections = cheatsheetSections(COMMAND_CATALOG, defaults, "", "meta");
    expect(row(sections, "mcp.open")?.chords).toEqual([]);
    expect(row(sections, "chatWidth.cycle")?.chords).toEqual([]);
    expect(row(sections, "dock.agents")?.chords).toEqual([]);
    const removed = effectiveKeybindings([{ command: "-sidebar.toggle", shortcut: "Mod+B" }]);
    expect(
      row(cheatsheetSections(COMMAND_CATALOG, removed, "", "meta"), "sidebar.toggle")?.chords,
    ).toEqual([]);
  });

  it("searches by title, id and key text", () => {
    const ids = (query: string, modKey: "meta" | "ctrl" = "meta") =>
      rowsOf(cheatsheetSections(COMMAND_CATALOG, defaults, query, modKey)).map((r) => r.id);
    expect(ids("toggle sidebar")).toEqual(["sidebar.toggle"]);
    expect(ids("sidebar.toggle")).toEqual(["sidebar.toggle"]);
    expect(ids("mod+k")).toContain("commandPalette.toggle");
    expect(ids("⌘K")).toContain("commandPalette.toggle");
    expect(ids("cmd+shift+b")).toEqual(["browserPane.toggle"]);
    expect(ids("ctrl+shift+b", "ctrl")).toEqual(["browserPane.toggle"]);
    // `Cmd` is an alias of `Mod`, as in the keymap; `Ctrl` is the Control key.
    expect(ids("cmd+shift+b", "ctrl")).toEqual(["browserPane.toggle"]);
    expect(ids("ctrl+shift+b", "meta")).toEqual([]);
    expect(ids("meta+k")).toContain("commandPalette.toggle");
    // "b" also matches the title "Switch branch" (git.branchPicker).
    expect(ids("cmd shift b")).toContain("browserPane.toggle");
    expect(ids("shift+enter")).toEqual(expect.arrayContaining(["fixed:1"]));
    expect(ids("  ")).toHaveLength(
      rowsOf(cheatsheetSections(COMMAND_CATALOG, defaults, "", "meta")).length,
    );
  });

  it("searches the when clauses", () => {
    const ids = rowsOf(cheatsheetSections(COMMAND_CATALOG, defaults, "planPending", "meta")).map(
      (r) => r.id,
    );
    expect(ids).toEqual(["plan.accept", "plan.acceptAndRun", "plan.revise"]);
  });

  it("drops a section with nothing left and finds an overridden key", () => {
    const effective = effectiveKeybindings([{ command: "font.reset", shortcut: "Mod+Alt+9" }]);
    const sections = cheatsheetSections(COMMAND_CATALOG, effective, "mod+alt+9", "meta");
    expect(sections.map((section) => section.area)).toEqual(["View"]);
    expect(rowsOf(sections).map((r) => r.id)).toEqual(["font.reset"]);
    expect(cheatsheetSections(COMMAND_CATALOG, effective, "no such thing", "meta")).toEqual([]);
  });

  it("covers the whole shipped keymap", () => {
    const shown = new Set(
      rowsOf(cheatsheetSections(COMMAND_CATALOG, defaults, "", "meta")).map((r) => r.id),
    );
    expect(DEFAULT_KEYBINDINGS.filter((binding) => !shown.has(binding.command))).toEqual([]);
  });
});
