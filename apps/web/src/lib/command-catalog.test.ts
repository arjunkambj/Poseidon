import { describe, expect, it } from "vitest";

import { parseShortcut } from "@poseidon/client-runtime/keybindings";
import { DEFAULT_KEYBINDINGS, RESERVED_KEYBINDINGS } from "@poseidon/contracts/keybindings";

import { COMMAND_AREAS, COMMAND_CATALOG, FIXED_KEYS } from "./command-catalog";

const catalogIds = COMMAND_CATALOG.map((entry) => entry.id);

describe("COMMAND_CATALOG", () => {
  it("lists each command once", () => {
    expect(new Set(catalogIds).size).toBe(catalogIds.length);
  });

  it("names every command the defaults bind", () => {
    const named = new Set(catalogIds);
    const missing = [...new Set(DEFAULT_KEYBINDINGS.map((row) => row.command))].filter(
      (command) => !named.has(command),
    );
    expect(missing).toEqual([]);
  });

  it("leaves reserved commands out until they ship", () => {
    const reserved = new Set(RESERVED_KEYBINDINGS.map((row) => row.command));
    expect(catalogIds.filter((id) => reserved.has(id))).toEqual([]);
  });

  it("files every entry under a known area, with a title", () => {
    for (const entry of COMMAND_CATALOG) {
      expect(COMMAND_AREAS, entry.id).toContain(entry.area);
      expect(entry.title.length, entry.id).toBeGreaterThan(0);
    }
  });

  it("keeps the numbered families and the rows' stand-ins out of the palette", () => {
    const offered = COMMAND_CATALOG.filter((entry) => entry.palette).map((entry) => entry.id);
    expect(offered.filter((id) => /^(thread\.jump|question\.option)\./u.test(id))).toEqual([]);
    expect(offered).not.toContain("thread.newInProject");
    expect(offered).toContain("project.add");
    expect(offered).toContain("sidebar.toggle");
  });

  it("offers first-run setup in the palette with no default chord", () => {
    const entry = COMMAND_CATALOG.find((c) => c.id === "onboarding.open");
    expect(entry?.palette).toBe(true);
    expect(entry?.area).toBe("General");
    expect(entry?.title).toBe("Set up Poseidon…");
    expect(DEFAULT_KEYBINDINGS.filter((row) => row.command === "onboarding.open")).toEqual([]);
    expect(RESERVED_KEYBINDINGS.filter((row) => row.command === "onboarding.open")).toEqual([]);
  });

  it("offers the chat width cycle in the palette with no default chord", () => {
    const entry = COMMAND_CATALOG.find((c) => c.id === "chatWidth.cycle");
    expect(entry?.palette).toBe(true);
    expect(entry?.area).toBe("View");
    expect(DEFAULT_KEYBINDINGS.filter((row) => row.command === "chatWidth.cycle")).toEqual([]);
  });

  it("offers the Agents tab in the palette with no default chord", () => {
    const entry = COMMAND_CATALOG.find((c) => c.id === "dock.agents");
    expect(entry?.palette).toBe(true);
    expect(entry?.area).toBe("View");
    expect(DEFAULT_KEYBINDINGS.filter((row) => row.command === "dock.agents")).toEqual([]);
  });

  it("offers Regenerate title under Threads with no default chord", () => {
    const entry = COMMAND_CATALOG.find((c) => c.id === "thread.regenerateTitle");
    expect(entry?.palette).toBe(true);
    expect(entry?.area).toBe("Threads");
    expect(entry?.title).toBe("Regenerate title");
    expect(DEFAULT_KEYBINDINGS.filter((row) => row.command === "thread.regenerateTitle")).toEqual(
      [],
    );
    expect(RESERVED_KEYBINDINGS.filter((row) => row.command === "thread.regenerateTitle")).toEqual(
      [],
    );
  });

  it("lists the plugins page with no default chord, reached from Navigation", () => {
    const entry = COMMAND_CATALOG.find((c) => c.id === "plugins.open");
    expect(entry?.area).toBe("General");
    expect(entry?.palette).toBe(false);
    expect(DEFAULT_KEYBINDINGS.filter((row) => row.command === "plugins.open")).toEqual([]);
  });

  it("files find in thread under Timeline", () => {
    const find = COMMAND_CATALOG.find((entry) => entry.id === "timeline.find");
    expect(find?.area).toBe("Timeline");
    expect(find?.title).toBe("Find in thread");
    expect(find?.palette).toBe(true);
  });
});

describe("FIXED_KEYS", () => {
  it("draws only chords the keymap notation can parse", () => {
    for (const row of FIXED_KEYS) {
      expect(COMMAND_AREAS).toContain(row.area);
      for (const key of row.keys) {
        expect(parseShortcut(key), `${row.title}: ${key}`).not.toBeNull();
      }
    }
  });
});
