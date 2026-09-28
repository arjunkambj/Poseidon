import type { DetectedEditor } from "@poseidon/contracts/editors";
import { describe, expect, it } from "vitest";

import {
  type FileMenuEntry,
  type FileMenuInput,
  fileMenuEntries,
  workspacePath,
} from "./file-menu";

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

const base: FileMenuInput = {
  path: "src/app.ts",
  isDirectory: false,
  exists: true,
  inWorkspace: true,
  root: "/work/repo",
  editors: [cursor, zed, finder, terminal],
  favourite: zed,
  filesTab: "reveal",
  canAddToChat: true,
};

/** Each entry as a short label, groups joined by `|`. */
const describeEntry = (entry: FileMenuEntry): string => {
  switch (entry.kind) {
    case "files-tab":
      return entry.label;
    case "open":
      return `open:${entry.editor.id}`;
    case "open-with":
      return `with:${entry.editors.map((editor) => editor.id).join(",")}`;
    case "reveal":
      return `reveal:${entry.app.id}`;
    case "copy":
      return `${entry.label}=${entry.text}`;
    case "add-to-chat":
      return "chat";
  }
};

const shape = (input: FileMenuInput): string =>
  fileMenuEntries(input)
    .map((group) => group.map(describeEntry).join(", "))
    .join(" | ");

describe("fileMenuEntries", () => {
  it("lists showing, revealing, copying and chat in that order", () => {
    expect(shape(base)).toBe(
      "Open in Files tab, open:zed, with:cursor,zed | reveal:finder | " +
        "Copy path=/work/repo/src/app.ts, Copy relative path=src/app.ts | chat",
    );
  });

  it("calls the Files-tab entry Open inside the tab itself", () => {
    expect(fileMenuEntries({ ...base, filesTab: "open" })[0]?.[0]).toEqual({
      kind: "files-tab",
      label: "Open",
    });
  });

  it("offers no Files-tab preview for a directory, nor where no thread answers it", () => {
    expect(shape({ ...base, isDirectory: true, path: "src" })).not.toContain("Files tab");
    expect(shape({ ...base, filesTab: null })).not.toContain("Files tab");
  });

  it("leaves out Open in and Open with when no editor is detected", () => {
    expect(shape({ ...base, editors: [finder, terminal], favourite: null })).toBe(
      "Open in Files tab | reveal:finder | " +
        "Copy path=/work/repo/src/app.ts, Copy relative path=src/app.ts | chat",
    );
  });

  it("drops a group that ends up empty", () => {
    expect(
      shape({ ...base, editors: [], favourite: null, filesTab: null, canAddToChat: false }),
    ).toBe("Copy path=/work/repo/src/app.ts, Copy relative path=src/app.ts");
  });

  it("only copies or adds to the chat a file no longer on disk", () => {
    expect(shape({ ...base, exists: false })).toBe(
      "Copy path=/work/repo/src/app.ts, Copy relative path=src/app.ts | chat",
    );
  });

  it("only copies the relative path, or adds to the chat, a file outside the workspace", () => {
    expect(shape({ ...base, path: "docs/readme.md", inWorkspace: false })).toBe(
      "Copy relative path=docs/readme.md | chat",
    );
  });

  it("copies only the relative path when the root is not known", () => {
    expect(shape({ ...base, root: null })).toContain("| Copy relative path=src/app.ts |");
    expect(shape({ ...base, root: null })).not.toContain("Copy path=");
  });
});

describe("workspacePath", () => {
  it("keeps a path when the workspace is the repository's top level", () => {
    expect(workspacePath("src/app.ts", "")).toBe("src/app.ts");
  });

  it("strips a subfolder workspace's prefix, and has no path for a file outside it", () => {
    expect(workspacePath("packages/app/src/a.ts", "packages/app/")).toBe("src/a.ts");
    expect(workspacePath("packages/other/a.ts", "packages/app/")).toBeNull();
    expect(workspacePath("packages/application/a.ts", "packages/app/")).toBeNull();
  });
});
