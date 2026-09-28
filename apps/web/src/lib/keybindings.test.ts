import { describe, expect, it } from "vitest";
import { DEFAULT_KEYBINDINGS } from "@poseidon/contracts/keybindings";
import type { Keybinding } from "@poseidon/contracts/settings";
import { resolveKeybinding } from "@poseidon/client-runtime/keybindings";

import {
  effectiveKeybindings,
  guestChordsFor,
  keycapsFor,
  shortcutFor,
  yieldsToTerminal,
} from "./keybindings";

describe("effectiveKeybindings", () => {
  it("is exactly the shipped defaults when nothing is overridden", () => {
    expect(effectiveKeybindings([])).toEqual(DEFAULT_KEYBINDINGS);
  });

  it("replaces an overridden command's default and keeps every other one", () => {
    const overrides: ReadonlyArray<Keybinding> = [{ command: "thread.new", shortcut: "Cmd+J" }];
    const table = effectiveKeybindings(overrides);
    expect(shortcutFor(table, "thread.new")).toBe("Cmd+J");
    expect(shortcutFor(table, "sidebar.toggle")).toBe("Mod+B");
    expect(table).toHaveLength(DEFAULT_KEYBINDINGS.length);
  });

  it("leaves a command unbound by a -command row unbound", () => {
    const table = effectiveKeybindings([{ command: "-sidebar.toggle", shortcut: "Cmd+B" }]);
    expect(shortcutFor(table, "sidebar.toggle")).toBeNull();
  });
});

describe("guestChordsFor", () => {
  const chord = (command: string, key: string, meta: boolean, control: boolean) => ({
    command,
    key,
    meta,
    control,
    alt: false,
    shift: false,
  });

  it("resolves the browser chords for the shell, with the platform modifier", () => {
    expect(guestChordsFor(DEFAULT_KEYBINDINGS, "meta")).toEqual([
      chord("browser.focusUrl", "l", true, false),
      chord("browser.reload", "r", true, false),
      chord("browser.back", "[", true, false),
      chord("browser.forward", "]", true, false),
    ]);
    expect(guestChordsFor(DEFAULT_KEYBINDINGS, "ctrl")[1]).toEqual(
      chord("browser.reload", "r", false, true),
    );
  });

  it("leaves out other commands, other scopes and unparseable chords", () => {
    const table: ReadonlyArray<Keybinding> = [
      { command: "thread.new", shortcut: "Mod+N" },
      { command: "browser.reload", shortcut: "Mod+R", when: "composerFocus" },
      { command: "browser.back", shortcut: "Mod+", when: "browserFocus" },
      { command: "browser.forward", shortcut: "Alt+ArrowRight" },
    ];
    expect(guestChordsFor(table, "meta")).toEqual([
      {
        command: "browser.forward",
        key: "arrowright",
        meta: false,
        control: false,
        alt: true,
        shift: false,
      },
    ]);
  });
});

describe("yieldsToTerminal", () => {
  it("lets the terminal toggle act from inside a focused terminal", () => {
    expect(yieldsToTerminal("terminal.toggle", "terminal")).toBe(false);
  });

  it("leaves every other chord to a focused terminal", () => {
    expect(yieldsToTerminal("thread.interrupt", "terminal")).toBe(true);
    expect(yieldsToTerminal("commandPalette.toggle", "terminal")).toBe(true);
    expect(yieldsToTerminal("sidebar.toggle", "terminal")).toBe(true);
  });

  it("yields nothing when the focus is anywhere else", () => {
    expect(yieldsToTerminal("thread.interrupt", "composer")).toBe(false);
    expect(yieldsToTerminal("commandPalette.toggle", "composer")).toBe(false);
    expect(yieldsToTerminal("commandPalette.toggle", undefined)).toBe(false);
  });
});

describe("shortcutFor", () => {
  it("finds the chord a command is bound to", () => {
    expect(shortcutFor(DEFAULT_KEYBINDINGS, "sidebar.toggle")).toBe("Mod+B");
  });

  it("returns null for a command the table does not bind", () => {
    expect(shortcutFor(DEFAULT_KEYBINDINGS, "nothing.here")).toBeNull();
  });
});

describe("keycapsFor", () => {
  it("draws the platform modifier as a glyph on macOS", () => {
    expect(keycapsFor("Mod+Shift+B", "meta")).toEqual(["⌘", "⇧", "B"]);
    expect(keycapsFor("Cmd+Shift+B", "meta")).toEqual(["⌘", "⇧", "B"]);
  });

  it("spells the modifiers out elsewhere", () => {
    expect(keycapsFor("Cmd+Shift+B", "ctrl")).toEqual(["Ctrl", "Shift", "B"]);
  });

  it("does not draw Ctrl twice when Cmd already means Control", () => {
    expect(keycapsFor("Cmd+Ctrl+K", "ctrl")).toEqual(["Ctrl", "K"]);
  });

  it("labels named keys", () => {
    expect(keycapsFor("Escape", "meta")).toEqual(["Esc"]);
    expect(keycapsFor("Cmd+Enter", "meta")).toEqual(["⌘", "↵"]);
    expect(keycapsFor("Cmd+,", "meta")).toEqual(["⌘", ","]);
  });

  it("draws nothing for an unparseable chord", () => {
    expect(keycapsFor("Cmd+", "meta")).toEqual([]);
  });
});

describe("the default table and the matcher agree", () => {
  const press = (
    key: string,
    modifiers: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
  ) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  });

  const resolve = (
    event: ReturnType<typeof press>,
    flags: Readonly<Record<string, boolean>> = {},
  ) =>
    resolveKeybinding(effectiveKeybindings([]), event, (name) => flags[name], "meta")?.command ??
    null;

  it("routes every chord the shell advertises to its command", () => {
    expect(resolve(press("k", { metaKey: true }))).toBe("commandPalette.toggle");
    expect(resolve(press("n", { metaKey: true }))).toBe("thread.new");
    expect(resolve(press("b", { metaKey: true }))).toBe("sidebar.toggle");
    expect(resolve(press("b", { metaKey: true, shiftKey: true }))).toBe("browserPane.toggle");
    expect(resolve(press("s", { metaKey: true, shiftKey: true }))).toBe("skills.open");
    expect(resolve(press(",", { metaKey: true }))).toBe("settings.open");
    expect(resolve(press("Enter", { metaKey: true }))).toBe("composer.queue");
    expect(resolve(press("Escape"), { turnRunning: true })).toBe("thread.interrupt");
    expect(resolve(press("j", { metaKey: true }))).toBe("terminal.toggle");
  });

  it("routes AZERTY number-row presses to the digit commands", () => {
    // The unshifted key at Digit1 types `&`; the digit bindings must still fire.
    const azerty = (key: string, code: string, modifiers: Parameters<typeof press>[1] = {}) => ({
      ...press(key, modifiers),
      code,
    });
    expect(resolve(azerty("&", "Digit1", { metaKey: true }))).toBe("thread.jump.1");
    expect(resolve(azerty("&", "Digit1"), { approvalPending: true })).toBe("approval.allowOnce");
  });

  it("fires the browser pane's keys only while the pane has focus", () => {
    const inPane = { browserFocus: true };
    expect(resolve(press("r", { metaKey: true }))).toBeNull();
    expect(resolve(press("l", { metaKey: true }))).toBe("composer.focus");
    expect(resolve(press("r", { metaKey: true }), inPane)).toBe("browser.reload");
    expect(resolve(press("l", { metaKey: true }), inPane)).toBe("browser.focusUrl");
    expect(resolve(press("[", { metaKey: true }), inPane)).toBe("browser.back");
    expect(resolve(press("]", { metaKey: true }), inPane)).toBe("browser.forward");
  });

  it("starts in the background only on New task", () => {
    const chord = press("Enter", { metaKey: true, altKey: true });
    expect(resolve(chord)).toBeNull();
    expect(resolve(chord, { newTaskOpen: true })).toBe("composer.startInBackground");
    // The plain queue chord is not taken by it.
    expect(resolve(press("Enter", { metaKey: true }), { newTaskOpen: true })).toBe(
      "composer.queue",
    );
  });

  it("does not fire a bare chord when an extra modifier is held", () => {
    expect(resolve(press("Escape", { shiftKey: true }), { turnRunning: true })).toBeNull();
  });
});
