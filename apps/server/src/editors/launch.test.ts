/**
 * The argv each app is started with: a command from the recipe or the
 * platform's opener, and an absolute target, with a line only through a CLI.
 */
import { describe, expect, it } from "vitest";

import type { EditorRecipe } from "./detect";
import { buildLaunch, type LaunchInput } from "./launch";

const FILE = "/work/app/src/main.ts";
const DIR = "/work/app";

const recipe = (overrides: Partial<EditorRecipe> & Pick<EditorRecipe, "id">): EditorRecipe => ({
  label: overrides.id,
  kind: "editor",
  ...overrides,
});

const launch = (input: Partial<LaunchInput> & Pick<LaunchInput, "recipe">) =>
  buildLaunch({ platform: "darwin", target: FILE, isDirectory: false, ...input });

const VSCODE_FAMILY = [
  ["vscode", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"],
  ["vscode-insiders", "/usr/local/bin/code-insiders"],
  ["cursor", "/Applications/Cursor.app/Contents/Resources/app/bin/cursor"],
  ["windsurf", "/usr/local/bin/windsurf"],
] as const;

describe("buildLaunch for editors", () => {
  for (const [id, cli] of VSCODE_FAMILY) {
    it(`opens a file at a line in ${id} with -g`, () => {
      const editor = recipe({ id, cli, lineStyle: "goto" });
      expect(launch({ recipe: editor, line: 42 })).toEqual({
        command: cli,
        args: ["-g", `${FILE}:42`],
      });
      expect(launch({ recipe: editor })).toEqual({ command: cli, args: [FILE] });
    });
  }

  for (const [id, cli] of [
    ["zed", "/Applications/Zed.app/Contents/MacOS/cli"],
    ["sublime", "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"],
  ] as const) {
    it(`opens a file at a line in ${id} as file:line`, () => {
      const editor = recipe({ id, cli, lineStyle: "suffix" });
      expect(launch({ recipe: editor, line: 7 })).toEqual({ command: cli, args: [`${FILE}:7`] });
      expect(launch({ recipe: editor })).toEqual({ command: cli, args: [FILE] });
    });
  }

  it("opens a folder without a line, even when one is asked for", () => {
    const editor = recipe({ id: "cursor", cli: "/bin/cursor", lineStyle: "goto" });
    expect(launch({ recipe: editor, target: DIR, isDirectory: true, line: 3 })).toEqual({
      command: "/bin/cursor",
      args: [DIR],
    });
  });

  it("falls back to open -a on the bundle, dropping the line", () => {
    const editor = recipe({
      id: "sublime",
      bundlePath: "/Applications/Sublime Text.app",
      lineStyle: "suffix",
    });
    expect(launch({ recipe: editor, line: 9 })).toEqual({
      command: "/usr/bin/open",
      args: ["-a", "/Applications/Sublime Text.app", FILE],
    });
  });

  it("has no launch for an editor with neither CLI nor bundle", () => {
    expect(launch({ recipe: recipe({ id: "zed" }) })).toBeNull();
    expect(
      launch({
        platform: "linux",
        recipe: recipe({ id: "zed", bundlePath: "/Applications/Zed.app" }),
      }),
    ).toBeNull();
  });
});

describe("buildLaunch for the file manager and terminal", () => {
  const finder = recipe({ id: "finder", kind: "file-manager" });
  const terminal = recipe({ id: "terminal", kind: "terminal" });

  it("opens a folder in Finder and reveals a file or a revealed folder", () => {
    expect(launch({ recipe: finder, target: DIR, isDirectory: true })).toEqual({
      command: "/usr/bin/open",
      args: [DIR],
    });
    expect(launch({ recipe: finder })).toEqual({ command: "/usr/bin/open", args: ["-R", FILE] });
    expect(launch({ recipe: finder, target: DIR, isDirectory: true, reveal: true })).toEqual({
      command: "/usr/bin/open",
      args: ["-R", DIR],
    });
  });

  it("opens Terminal in a folder, or in the folder holding a file", () => {
    expect(launch({ recipe: terminal, target: DIR, isDirectory: true })).toEqual({
      command: "/usr/bin/open",
      args: ["-a", "Terminal", DIR],
    });
    expect(launch({ recipe: terminal })).toEqual({
      command: "/usr/bin/open",
      args: ["-a", "Terminal", "/work/app/src"],
    });
    expect(launch({ platform: "linux", recipe: terminal })).toBeNull();
  });

  it("uses xdg-open on Linux, on the folder holding a file", () => {
    const xdg = recipe({ id: "finder", kind: "file-manager", cli: "/usr/bin/xdg-open" });
    expect(launch({ platform: "linux", recipe: xdg, target: DIR, isDirectory: true })).toEqual({
      command: "/usr/bin/xdg-open",
      args: [DIR],
    });
    expect(launch({ platform: "linux", recipe: xdg })).toEqual({
      command: "/usr/bin/xdg-open",
      args: ["/work/app/src"],
    });
    expect(launch({ platform: "linux", recipe: finder })).toBeNull();
  });

  it("selects a file in Explorer on Windows", () => {
    const file = "C:\\work\\app\\main.ts";
    expect(launch({ platform: "win32", recipe: finder, target: file })).toEqual({
      command: "explorer.exe",
      args: [`/select,${file}`],
    });
    expect(
      launch({ platform: "win32", recipe: finder, target: "C:\\work\\app", isDirectory: true }),
    ).toEqual({ command: "explorer.exe", args: ["C:\\work\\app"] });
  });
});
