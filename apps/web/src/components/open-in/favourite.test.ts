import type { DetectedEditor } from "@poseidon/contracts/editors";
import { describe, expect, it } from "vitest";

import { absolutePath, editorsOnly, otherApps, pickFavourite, showOpenIn } from "./favourite";

const cursor: DetectedEditor = {
  id: "cursor",
  label: "Cursor",
  kind: "editor",
  supportsLine: true,
};
const zed: DetectedEditor = { id: "zed", label: "Zed", kind: "editor", supportsLine: true };
const finder: DetectedEditor = {
  id: "finder",
  label: "Finder",
  kind: "file-manager",
  supportsLine: false,
};
const terminal: DetectedEditor = {
  id: "terminal",
  label: "Terminal",
  kind: "terminal",
  supportsLine: false,
};

describe("pickFavourite", () => {
  const detected = [cursor, zed, finder, terminal];

  it("takes the stored editor when this machine has it", () => {
    expect(pickFavourite(detected, "zed")).toBe(zed);
  });

  it("falls back to the first editor when the stored one is unset, unknown or missing", () => {
    expect(pickFavourite(detected, undefined)).toBe(cursor);
    expect(pickFavourite(detected, null)).toBe(cursor);
    expect(pickFavourite(detected, "an-editor-since-dropped")).toBe(cursor);
    expect(pickFavourite(detected, "sublime")).toBe(cursor);
  });

  it("never makes Finder or Terminal the favourite", () => {
    expect(pickFavourite(detected, "finder")).toBe(cursor);
    expect(pickFavourite([finder, terminal], "terminal")).toBeNull();
    expect(pickFavourite([], "cursor")).toBeNull();
  });
});

describe("editorsOnly, otherApps and showOpenIn", () => {
  it("keeps the editors in the server's order", () => {
    expect(editorsOnly([finder, zed, terminal, cursor])).toEqual([zed, cursor]);
  });

  it("keeps the file manager and the terminal apart, in the server's order", () => {
    expect(otherApps([cursor, finder, zed, terminal])).toEqual([finder, terminal]);
    expect(otherApps([cursor])).toEqual([]);
  });

  it("shows the control only when an editor is detected", () => {
    expect(showOpenIn([cursor, finder, terminal])).toBe(true);
    expect(showOpenIn([finder, terminal])).toBe(false);
    expect(showOpenIn([finder])).toBe(false);
    expect(showOpenIn([])).toBe(false);
  });
});

describe("absolutePath", () => {
  it("joins a relative path under the root", () => {
    expect(absolutePath("/Users/me/app", "src/index.ts")).toBe("/Users/me/app/src/index.ts");
    expect(absolutePath("/Users/me/app/", "./src//index.ts")).toBe("/Users/me/app/src/index.ts");
  });

  it("is the root itself for an empty path", () => {
    expect(absolutePath("/Users/me/app/", "")).toBe("/Users/me/app");
    expect(absolutePath("/Users/me/app", ".")).toBe("/Users/me/app");
    expect(absolutePath("/", "etc/hosts")).toBe("/etc/hosts");
  });

  it("keeps a Windows root's backslashes", () => {
    expect(absolutePath("C:\\work\\app", "src/index.ts")).toBe("C:\\work\\app\\src\\index.ts");
  });
});
