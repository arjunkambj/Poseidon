import type { FileContent } from "@poseidon/contracts/rpc";
import { describe, expect, it } from "vitest";

import { HIGHLIGHT_MAX_CHARS, HIGHLIGHT_MAX_LINES } from "@/components/timeline/code-fence";

import {
  lineCount,
  looksBinary,
  offsetForLine,
  PAGE_LINES,
  pagePosition,
  previewCacheKey,
  previewFileOptions,
  previewHighlight,
  previewLines,
  splitPath,
  tooLargeToHighlight,
  windowFor,
} from "./preview";

const content = (over: Partial<FileContent>): FileContent => ({
  path: "src/app.ts",
  text: "",
  totalLines: 0,
  truncated: false,
  ...over,
});

/** `n` lines of body, the way `files.read` joins them back together. */
const body = (n: number, from = 0): string =>
  Array.from({ length: n }, (_, i) => `line ${from + i + 1}`).join("\n");

describe("files preview opened at a line", () => {
  it("a line near the top opens the file at its start", () => {
    expect(offsetForLine(1)).toBe(0);
    expect(offsetForLine(12)).toBe(0);
    expect(offsetForLine(400)).toBe(0);
  });

  it("a line further down opens a window with lines above it", () => {
    expect(offsetForLine(401)).toBe(300);
    expect(offsetForLine(20_000)).toBe(19_899);
  });

  it("the line always lands on the first page, below its lead", () => {
    for (const line of [1, 399, 400, 401, 500, 501, 1_234, 99_999]) {
      const offset = offsetForLine(line);
      const position = pagePosition(
        offset,
        content({ text: body(PAGE_LINES, offset), totalLines: 100_000 }),
      );
      expect(position.firstLine).toBeLessThanOrEqual(line);
      expect(position.lastLine).toBeGreaterThanOrEqual(line);
    }
  });

  it("no line, or one that is not a positive number, opens the top", () => {
    expect(offsetForLine(undefined)).toBe(0);
    expect(offsetForLine(0)).toBe(0);
    expect(offsetForLine(-5)).toBe(0);
    expect(offsetForLine(Number.NaN)).toBe(0);
    expect(offsetForLine(Number.POSITIVE_INFINITY)).toBe(0);
    expect(offsetForLine(450.9)).toBe(349);
  });
});

describe("files preview paging", () => {
  it("a line offset becomes the read window the server expects", () => {
    expect(windowFor(0)).toEqual({ offset: 0, limit: PAGE_LINES });
    expect(windowFor(PAGE_LINES)).toEqual({ offset: PAGE_LINES, limit: PAGE_LINES });
    expect(windowFor(20_000)).toEqual({ offset: 20_000, limit: PAGE_LINES });
    // Negative or fractional offsets cannot reach the wire.
    expect(windowFor(-3)).toEqual({ offset: 0, limit: PAGE_LINES });
    expect(windowFor(262.7)).toEqual({ offset: 262, limit: PAGE_LINES });
  });

  it("the first page of a long file offers next but not previous", () => {
    const position = pagePosition(0, content({ text: body(PAGE_LINES), totalLines: 12_043 }));
    expect(position.firstLine).toBe(1);
    expect(position.lastLine).toBe(PAGE_LINES);
    expect(position.hasPrevious).toBe(false);
    expect(position.hasNext).toBe(true);
    expect(position.nextOffset).toBe(PAGE_LINES);
    expect(position.capped).toBe(false);
    expect(position.label).toBe("Lines 1–500 of 12,043");
  });

  it("a middle page reads past the server's text cap", () => {
    // 20,000 lines is well past what one `files.read` will return in full;
    // the offset is a window request, and the footer says where it landed.
    const position = pagePosition(
      20_000,
      content({ text: body(PAGE_LINES, 20_000), totalLines: 40_000, truncated: true }),
    );
    expect(position.firstLine).toBe(20_001);
    expect(position.lastLine).toBe(20_500);
    expect(position.hasPrevious).toBe(true);
    expect(position.hasNext).toBe(true);
    expect(position.nextOffset).toBe(20_500);
    expect(position.label).toBe("Lines 20,001–20,500 of 40,000");
  });

  it("a window the server cut short resumes at the line it stopped on", () => {
    // The real failure: `readFileWindow` stops collecting at its 512K-character
    // cap, so a 500-line request over long lines answers 262 lines and
    // `truncated` in the *middle* of the file. Stepping by page number would
    // skip lines 263–500 with nothing on screen to say so.
    const position = pagePosition(
      0,
      content({ text: body(262), totalLines: 1_000, truncated: true }),
    );
    expect(position.lastLine).toBe(262);
    expect(position.hasNext).toBe(true);
    expect(position.nextOffset).toBe(262);
    expect(windowFor(position.nextOffset).offset).toBe(262);
    expect(previewLines(position.nextOffset, content({ text: "x" }))[0]?.number).toBe(263);
    // And the footer admits the window was the server's choice, not the file's.
    expect(position.capped).toBe(true);
  });

  it("a short last page ends the file", () => {
    const position = pagePosition(500, content({ text: body(12, 500), totalLines: 512 }));
    expect(position.lastLine).toBe(512);
    expect(position.hasNext).toBe(false);
    expect(position.capped).toBe(false);
    expect(position.label).toBe("Lines 501–512 of 512");
  });

  it("an empty file and a window past the end are both no lines", () => {
    const empty = pagePosition(0, content({ text: "", totalLines: 0 }));
    expect(empty.label).toBe("Empty file");
    expect(empty.hasNext).toBe(false);

    const past = pagePosition(2_000, content({ text: "", totalLines: 300 }));
    expect(past.hasNext).toBe(false);
    expect(past.hasPrevious).toBe(true);
    expect(past.label).toBe("No lines past 2,000 of 2,000");
  });

  it("line numbers continue from the window's offset", () => {
    expect(previewLines(500, content({ text: "a\nb", totalLines: 502 }))).toEqual([
      { number: 501, text: "a" },
      { number: 502, text: "b" },
    ]);
    expect(previewLines(0, content({ text: "" }))).toEqual([]);
  });

  it("counts lines the way the server split them", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\nb")).toBe(2);
    // A trailing newline yields a final empty line, as `String.split` does.
    expect(lineCount("a\n")).toBe(2);
  });
});

describe("looksBinary", () => {
  // Written as escapes rather than literals: a raw NUL in a source file is
  // invisible in every diff it ever appears in.
  const NUL = String.fromCharCode(0);
  const REPLACEMENT = String.fromCharCode(0xff_fd);

  it("passes source through", () => {
    expect(looksBinary("")).toBe(false);
    expect(looksBinary("const a = 1;\nexport { a };\n")).toBe(false);
    // Text is not binary just because it is not ASCII.
    expect(looksBinary('const label = "Lines 1-500 · cafe";')).toBe(false);
  });

  it("catches a NUL byte anywhere in the sample", () => {
    expect(looksBinary(`PNG${NUL}${NUL}IHDR`)).toBe(true);
    expect(looksBinary(`${"x".repeat(1_000)}${NUL}`)).toBe(true);
  });

  it("catches a decode that produced mostly replacement characters", () => {
    expect(looksBinary(`${REPLACEMENT.repeat(50)}${"x".repeat(50)}`)).toBe(true);
    // One stray replacement in a page of source is an encoding wobble.
    expect(looksBinary(`${"x".repeat(500)}${REPLACEMENT}`)).toBe(false);
  });
});

describe("splitPath", () => {
  it("separates the directory from the name", () => {
    expect(splitPath("apps/web/src/main.tsx")).toEqual({
      directory: "apps/web/src/",
      name: "main.tsx",
    });
    expect(splitPath("README.md")).toEqual({ directory: "", name: "README.md" });
  });
});

describe("files preview highlighting", () => {
  const small = content({ text: "const a = 1;\nexport { a };", totalLines: 2 });

  it("highlights a small code file shown whole", () => {
    expect(previewHighlight("src/app.ts", small, 0)).toEqual({ language: "typescript" });
    expect(tooLargeToHighlight("src/app.ts", small, 0)).toBe(false);
  });

  it("keeps a file longer than one page plain, on every page", () => {
    const first = content({ text: body(PAGE_LINES), totalLines: 1_200 });
    expect(previewHighlight("src/app.ts", first, 0)).toBeNull();
    expect(tooLargeToHighlight("src/app.ts", first, 0)).toBe(true);
    const last = content({ text: body(200, 1_000), totalLines: 1_200 });
    expect(previewHighlight("src/app.ts", last, 1_000)).toBeNull();
    expect(tooLargeToHighlight("src/app.ts", last, 1_000)).toBe(true);
  });

  it("keeps a page the server cut short plain", () => {
    const cut = content({ text: body(10), totalLines: 10, truncated: true });
    expect(previewHighlight("src/app.ts", cut, 0)).toBeNull();
    expect(tooLargeToHighlight("src/app.ts", cut, 0)).toBe(true);
  });

  it("keeps a whole file over the character cap plain", () => {
    const wide = content({ text: "x".repeat(HIGHLIGHT_MAX_CHARS + 1), totalLines: 1 });
    expect(previewHighlight("src/app.ts", wide, 0)).toBeNull();
    expect(tooLargeToHighlight("src/app.ts", wide, 0)).toBe(true);
  });

  it("keeps an unknown extension, plain text and an empty file plain, with no size note", () => {
    for (const path of ["data.unknownext", "notes.txt", "LICENSE"]) {
      expect(previewHighlight(path, small, 0)).toBeNull();
      expect(tooLargeToHighlight(path, small, 0)).toBe(false);
    }
    expect(previewHighlight("src/app.ts", content({}), 0)).toBeNull();
  });

  it("never highlights a binary file", () => {
    const png = content({ text: `PNG${String.fromCharCode(0)}IHDR`, totalLines: 1 });
    expect(previewHighlight("logo.ts", png, 0)).toBeNull();
    expect(tooLargeToHighlight("logo.ts", png, 0)).toBe(false);
  });

  it("names a page by path and text, so an edit of the same length is a new key", () => {
    expect(previewCacheKey("a.ts", "abc")).toBe(previewCacheKey("a.ts", "abc"));
    expect(previewCacheKey("a.ts", "abc")).not.toBe(previewCacheKey("a.ts", "abd"));
    expect(previewCacheKey("a.ts", "abc")).not.toBe(previewCacheKey("b.ts", "abc"));
  });

  it("renders with line numbers, no header, sideways scroll and the tokenize cap", () => {
    expect(previewFileOptions("dark")).toMatchObject({
      themeType: "dark",
      disableFileHeader: true,
      disableLineNumbers: false,
      overflow: "scroll",
      tokenizeMaxLength: HIGHLIGHT_MAX_LINES,
    });
  });
});
