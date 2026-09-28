import { describe, expect, it } from "vitest";

import { fileLinkAction, findFileReferences } from "./file-links";

/** The references in `line`, each with the exact text its offsets cover. */
const found = (line: string) =>
  findFileReferences(line).map((reference) => ({
    ...reference,
    text: line.slice(reference.start, reference.end),
  }));

describe("findFileReferences", () => {
  it("reads a relative path with a line, and with a line and column", () => {
    expect(found("src/a.ts:12")).toEqual([
      { start: 0, end: 11, path: "src/a.ts", line: 12, text: "src/a.ts:12" },
    ]);
    expect(found("  error at src/a.ts:12:3 here")).toEqual([
      { start: 11, end: 24, path: "src/a.ts", line: 12, column: 3, text: "src/a.ts:12:3" },
    ]);
  });

  it("reads a dot-relative path and a bare file name with an extension", () => {
    expect(found("./a.ts:1")).toEqual([
      { start: 0, end: 8, path: "./a.ts", line: 1, text: "./a.ts:1" },
    ]);
    expect(found("README.md:4")).toEqual([
      { start: 0, end: 11, path: "README.md", line: 4, text: "README.md:4" },
    ]);
  });

  it("reads an absolute path", () => {
    expect(found("/Users/x/proj/src/a.ts:4:2")).toEqual([
      {
        start: 0,
        end: 26,
        path: "/Users/x/proj/src/a.ts",
        line: 4,
        column: 2,
        text: "/Users/x/proj/src/a.ts:4:2",
      },
    ]);
  });

  it("reads a stack frame without its parentheses", () => {
    const line = "    at run (/abs/a.ts:10:5)";
    expect(found(line)).toEqual([
      { start: 12, end: 26, path: "/abs/a.ts", line: 10, column: 5, text: "/abs/a.ts:10:5" },
    ]);
    expect(found("    at /abs/b.js:3:1")).toEqual([
      { start: 7, end: 20, path: "/abs/b.js", line: 3, column: 1, text: "/abs/b.js:3:1" },
    ]);
  });

  it("reads a file URL with a position, covering the whole URL", () => {
    expect(found("at (file:///abs/a.ts:10:5)")).toEqual([
      {
        start: 4,
        end: 25,
        path: "/abs/a.ts",
        line: 10,
        column: 5,
        text: "file:///abs/a.ts:10:5",
      },
    ]);
    expect(found("file://a.ts:1")).toEqual([]);
  });

  it("reads tsc's non-pretty (line,col) form", () => {
    expect(found("src/a.ts(12,3): error TS2322: Type 'x'")).toEqual([
      { start: 0, end: 14, path: "src/a.ts", line: 12, column: 3, text: "src/a.ts(12,3)" },
    ]);
  });

  it("trims wrapping quotes, brackets and trailing punctuation", () => {
    expect(found(`"src/a.ts:12", 'lib/b.ts:3:4'. [c/d.ts:5]; <e/f.ts:6>!`)).toEqual([
      { start: 1, end: 12, path: "src/a.ts", line: 12, text: "src/a.ts:12" },
      { start: 16, end: 28, path: "lib/b.ts", line: 3, column: 4, text: "lib/b.ts:3:4" },
      { start: 32, end: 40, path: "c/d.ts", line: 5, text: "c/d.ts:5" },
      { start: 44, end: 52, path: "e/f.ts", line: 6, text: "e/f.ts:6" },
    ]);
    expect(found("src/a.ts:12:3: warning")[0]?.text).toBe("src/a.ts:12:3");
    expect(found("src/a.ts:12:const x = 1")[0]?.text).toBe("src/a.ts:12");
  });

  it("finds several references on one line, in order", () => {
    expect(found("a/b.ts:1 then c/d.ts:2:3").map((reference) => reference.text)).toEqual([
      "a/b.ts:1",
      "c/d.ts:2:3",
    ]);
  });

  it("offsets count UTF-16 units before the reference", () => {
    expect(found("❯ src/é.ts:7")).toEqual([
      { start: 2, end: 12, path: "src/é.ts", line: 7, text: "src/é.ts:7" },
    ]);
  });

  it("ignores anything inside an http(s) URL", () => {
    expect(found("http://localhost:5173/src/a.ts:12")).toEqual([]);
    expect(found("see (https://example.com/a.ts:3:4)")).toEqual([]);
    expect(found("Local: http://localhost:3000/")).toEqual([]);
  });

  it("ignores clock times, host:port and version-like text", () => {
    expect(found("12:30:45")).toEqual([]);
    expect(found("[12:30:45] started")).toEqual([]);
    expect(found("2026-09-28T12:30:45.123Z")).toEqual([]);
    expect(found("localhost:3000 127.0.0.1:8080 v1.2:3")).toEqual([]);
  });

  it("needs a line, and a path that holds a slash or an extension", () => {
    expect(found("src/a.ts")).toEqual([]);
    expect(found("Makefile:12")).toEqual([]);
    expect(found("src/a.ts:0")).toEqual([]);
    expect(found("docs/Makefile:12").map((reference) => reference.path)).toEqual(["docs/Makefile"]);
  });

  it("does not match a Windows path, a home path or a shell pattern", () => {
    expect(found("C:\\proj\\src\\a.ts:12:3")).toEqual([]);
    expect(found("C:/proj/src/a.ts:12")).toEqual([]);
    expect(found("~/proj/a.ts:1")).toEqual([]);
    expect(found("src/*.ts:1 $HOME/a.ts:2 a=b/c.ts:3")).toEqual([]);
  });
});

describe("fileLinkAction", () => {
  const plain = { metaKey: false, ctrlKey: false };
  const meta = { metaKey: true, ctrlKey: false };
  const ctrl = { metaKey: false, ctrlKey: true };
  const editor = { hasEditor: true };

  it("a plain click shows the file in the owner's Files tab", () => {
    expect(fileLinkAction(plain, "meta", editor)).toBe("files");
    expect(fileLinkAction(plain, "ctrl", { hasEditor: false })).toBe("files");
  });

  it("a mod-click opens the favourite editor, on the platform's own modifier", () => {
    expect(fileLinkAction(meta, "meta", editor)).toBe("editor");
    expect(fileLinkAction(ctrl, "ctrl", editor)).toBe("editor");
    expect(fileLinkAction(ctrl, "meta", editor)).toBe("files");
    expect(fileLinkAction(meta, "ctrl", editor)).toBe("files");
  });

  it("a mod-click with no editor falls back to the Files tab, so no link is dead", () => {
    expect(fileLinkAction(meta, "meta", { hasEditor: false })).toBe("files");
    expect(fileLinkAction(ctrl, "ctrl", { hasEditor: false })).toBe("files");
  });
});
