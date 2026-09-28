import { describe, expect, it } from "vitest";

import { DEFAULT_KEYBINDINGS } from "@poseidon/contracts/keybindings";
import { resolveKeybinding } from "@poseidon/client-runtime/keybindings";

import {
  FOCUS_SURFACE,
  keybindingContext,
  surfaceOf,
  type FocusSnapshot,
} from "./keybinding-context";

const snapshot = (patch: Partial<FocusSnapshot> = {}): FocusSnapshot => ({
  editable: false,
  surface: undefined,
  overlayOpen: false,
  ...patch,
});

/** A registry reader over a fixed set of published flags, logging each read. */
const published = (flags: Readonly<Record<string, boolean | string>>) => {
  const reads: Array<string> = [];
  return {
    reads,
    read: (name: string) => {
      reads.push(name);
      return flags[name];
    },
  };
};

describe("keybindingContext", () => {
  it("reads focus in the composer as composer and input focus", () => {
    const context = keybindingContext(
      snapshot({ editable: true, surface: "composer" }),
      published({}).read,
      true,
    );
    expect(context("inputFocus")).toBe(true);
    expect(context("composerFocus")).toBe(true);
    expect(context("terminalFocus")).toBe(false);
    expect(context("browserFocus")).toBe(false);
    expect(context("dialogOpen")).toBe(false);
  });

  it("names the terminal and browser surfaces", () => {
    const terminal = keybindingContext(snapshot({ surface: "terminal" }), () => undefined, false);
    expect(terminal("terminalFocus")).toBe(true);
    expect(terminal("composerFocus")).toBe(false);
    const browser = keybindingContext(snapshot({ surface: "browser" }), () => undefined, false);
    expect(browser("browserFocus")).toBe(true);
    const files = keybindingContext(snapshot({ surface: "files" }), () => undefined, false);
    expect(files("filesFocus")).toBe(true);
    expect(files("browserFocus")).toBe(false);
    expect(browser("filesFocus")).toBe(false);
  });

  it("reports an open dialog", () => {
    const context = keybindingContext(snapshot({ overlayOpen: true }), () => undefined, false);
    expect(context("dialogOpen")).toBe(true);
    expect(context("inputFocus")).toBe(false);
  });

  it("answers isMac from the platform", () => {
    expect(keybindingContext(snapshot(), () => undefined, true)("isMac")).toBe(true);
    expect(keybindingContext(snapshot(), () => undefined, false)("isMac")).toBe(false);
  });

  it("never lets a published flag stand in for a built-in", () => {
    const flags = published({ inputFocus: true, dialogOpen: true, isMac: true });
    const context = keybindingContext(snapshot(), flags.read, false);
    expect(context("inputFocus")).toBe(false);
    expect(context("dialogOpen")).toBe(false);
    expect(context("isMac")).toBe(false);
    expect(flags.reads).toEqual([]);
  });

  it("reads everything else from the registry", () => {
    const context = keybindingContext(
      snapshot(),
      published({ approvalPending: true, threadOpen: true }).read,
      false,
    );
    expect(context("approvalPending")).toBe(true);
    expect(context("threadOpen")).toBe(true);
    expect(context("planPending")).toBeUndefined();
  });

  it("reads the threadRunning alias as turnRunning", () => {
    const flags = published({ turnRunning: true });
    const context = keybindingContext(snapshot(), flags.read, false);
    expect(context("threadRunning")).toBe(true);
    expect(flags.reads).toEqual(["turnRunning"]);
  });
});

interface FakeElement {
  readonly getAttribute: (name: string) => string | null;
  readonly closest: (selector: string) => FakeElement | null;
}

/** A stand-in element: its own attributes, then its ancestors', for `closest`. */
const element = (attributes: Readonly<Record<string, string>>, parent?: FakeElement) => {
  const node: FakeElement = {
    getAttribute: (name) => attributes[name] ?? null,
    closest: (selector) =>
      selector === "[data-context]" && "data-context" in attributes
        ? node
        : (parent?.closest(selector) ?? null),
  };
  return node;
};

describe("surfaceOf", () => {
  it("reads the closest data-context above the focused element", () => {
    const pane = element({ "data-context": FOCUS_SURFACE.browser });
    const addressBar = element({ "aria-label": "Address" }, element({}, pane));
    expect(surfaceOf(addressBar as unknown as EventTarget)).toBe("browser");
    expect(surfaceOf(element({}) as unknown as EventTarget)).toBeUndefined();
    expect(surfaceOf(null)).toBeUndefined();
  });

  it("reads the Files pane's search field as files focus", () => {
    const pane = element({ "data-context": FOCUS_SURFACE.files });
    const search = element({ placeholder: "Search files" }, element({}, pane));
    const context = keybindingContext(
      snapshot({ editable: true, surface: surfaceOf(search as unknown as EventTarget) }),
      () => undefined,
      true,
    );
    expect(context("filesFocus")).toBe(true);
    expect(context("inputFocus")).toBe(true);
    expect(context("composerFocus")).toBe(false);
  });

  it("gives Mod+F to the thread's find but not over a dialog or inside the Files pane", () => {
    const threadOpen = (name: string) => (name === "threadOpen" ? true : undefined);
    const press = {
      key: "f",
      code: "KeyF",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    const resolve = (focus: FocusSnapshot) =>
      resolveKeybinding(
        DEFAULT_KEYBINDINGS,
        press,
        keybindingContext(focus, threadOpen, true),
        "meta",
      )?.command;
    expect(resolve(snapshot({ editable: true, surface: "composer" }))).toBe("timeline.find");
    expect(resolve(snapshot())).toBe("timeline.find");
    expect(resolve(snapshot({ editable: true, overlayOpen: true }))).toBeUndefined();
    expect(resolve(snapshot({ editable: true, surface: "files" }))).toBeUndefined();
  });

  it("gives Mod+L, Mod+[ and Mod+] to the browser pane inside it and to the app elsewhere", () => {
    const pane = element({ "data-context": FOCUS_SURFACE.browser });
    const addressBar = element({}, pane);
    const inPane = keybindingContext(
      snapshot({ editable: true, surface: surfaceOf(addressBar as unknown as EventTarget) }),
      () => undefined,
      true,
    );
    const elsewhere = keybindingContext(snapshot({ editable: true }), () => undefined, true);
    const press = (key: string, code: string) => ({
      key,
      code,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
    for (const [key, code, command, paneCommand] of [
      ["l", "KeyL", "composer.focus", "browser.focusUrl"],
      ["[", "BracketLeft", "nav.back", "browser.back"],
      ["]", "BracketRight", "nav.forward", "browser.forward"],
    ] as const) {
      expect(
        resolveKeybinding(DEFAULT_KEYBINDINGS, press(key, code), inPane, "meta")?.command,
      ).toBe(paneCommand);
      expect(
        resolveKeybinding(DEFAULT_KEYBINDINGS, press(key, code), elsewhere, "meta")?.command,
      ).toBe(command);
    }
  });
});
