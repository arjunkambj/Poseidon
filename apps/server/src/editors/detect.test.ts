/**
 * Detection over described machines: an existence check that answers from a
 * set of paths, so every platform and install layout runs on any host.
 */
import { describe, expect, it } from "vitest";

import { detectEditors, editorLabel, toDetectedEditor } from "./detect";

const HOME = "/Users/dev";

const machine = (
  platform: NodeJS.Platform,
  paths: ReadonlyArray<string>,
  pathDirs: ReadonlyArray<string> = [],
) => {
  const present = new Set(paths);
  return detectEditors({ platform, home: HOME, pathDirs, exists: (path) => present.has(path) });
};

describe("detectEditors on macOS", () => {
  it("finds a bundle in ~/Applications and the CLI inside it", () => {
    const found = machine("darwin", [
      `${HOME}/Applications/Cursor.app`,
      `${HOME}/Applications/Cursor.app/Contents/Resources/app/bin/cursor`,
      "/Applications/Zed.app",
      "/Applications/Zed.app/Contents/MacOS/cli",
    ]);
    expect(found).toEqual([
      {
        id: "cursor",
        label: "Cursor",
        kind: "editor",
        cli: `${HOME}/Applications/Cursor.app/Contents/Resources/app/bin/cursor`,
        bundlePath: `${HOME}/Applications/Cursor.app`,
        lineStyle: "goto",
      },
      {
        id: "zed",
        label: "Zed",
        kind: "editor",
        cli: "/Applications/Zed.app/Contents/MacOS/cli",
        bundlePath: "/Applications/Zed.app",
        lineStyle: "suffix",
      },
      { id: "finder", label: "Finder", kind: "file-manager", cli: undefined },
      { id: "terminal", label: "Terminal", kind: "terminal" },
    ]);
  });

  it("keeps a bundle without a CLI, which cannot take a line", () => {
    const found = machine("darwin", ["/Applications/Sublime Text.app"]);
    const sublime = found.find((recipe) => recipe.id === "sublime");
    expect(sublime?.bundlePath).toBe("/Applications/Sublime Text.app");
    expect(sublime?.cli).toBeUndefined();
    expect(toDetectedEditor(sublime!).supportsLine).toBe(false);
  });

  it("falls back to a CLI on PATH when there is no bundle", () => {
    const found = machine("darwin", ["/usr/local/bin/code"], ["relative/bin", "/usr/local/bin"]);
    expect(found.map((recipe) => recipe.id)).toEqual(["vscode", "finder", "terminal"]);
    expect(found[0]).toMatchObject({ cli: "/usr/local/bin/code", bundlePath: undefined });
    expect(toDetectedEditor(found[0]!)).toEqual({
      id: "vscode",
      label: "VS Code",
      kind: "editor",
      supportsLine: true,
    });
  });

  it("lists every editor in a fixed order, then Finder and Terminal", () => {
    const bundles = [
      "Sublime Text.app",
      "Zed.app",
      "Windsurf.app",
      "Cursor.app",
      "Visual Studio Code - Insiders.app",
      "Visual Studio Code.app",
    ].map((bundle) => `/Applications/${bundle}`);
    expect(machine("darwin", bundles).map((recipe) => recipe.id)).toEqual([
      "vscode",
      "vscode-insiders",
      "cursor",
      "windsurf",
      "zed",
      "sublime",
      "finder",
      "terminal",
    ]);
  });

  it("offers only Finder and Terminal on a machine with no editor", () => {
    expect(machine("darwin", []).map(toDetectedEditor)).toEqual([
      { id: "finder", label: "Finder", kind: "file-manager", supportsLine: false },
      { id: "terminal", label: "Terminal", kind: "terminal", supportsLine: false },
    ]);
  });
});

describe("detectEditors on Linux", () => {
  it("finds editors by their CLI on PATH, and the file manager by xdg-open", () => {
    const found = machine(
      "linux",
      ["/usr/bin/zed", "/usr/bin/xdg-open", "/snap/bin/code"],
      ["/usr/bin", "/snap/bin"],
    );
    expect(found.map(toDetectedEditor)).toEqual([
      { id: "vscode", label: "VS Code", kind: "editor", supportsLine: true },
      { id: "zed", label: "Zed", kind: "editor", supportsLine: true },
      { id: "finder", label: "File manager", kind: "file-manager", supportsLine: false },
    ]);
    expect(found[2]?.cli).toBe("/usr/bin/xdg-open");
  });

  it("ignores app bundles and offers nothing without xdg-open", () => {
    expect(machine("linux", ["/Applications/Cursor.app"], ["/usr/bin"])).toEqual([]);
  });
});

describe("detectEditors elsewhere", () => {
  it("offers Explorer alone on Windows, whatever is on PATH", () => {
    const found = machine("win32", ["C:\\bin\\code.cmd"], ["C:\\bin"]);
    expect(found.map(toDetectedEditor)).toEqual([
      { id: "finder", label: "Explorer", kind: "file-manager", supportsLine: false },
    ]);
  });

  it("offers nothing on a platform it does not know", () => {
    expect(machine("freebsd", ["/usr/local/bin/code"], ["/usr/local/bin"])).toEqual([]);
  });

  it("labels an app it did not find", () => {
    expect(editorLabel("windsurf", "linux")).toBe("Windsurf");
    expect(editorLabel("finder", "linux")).toBe("File manager");
  });
});
