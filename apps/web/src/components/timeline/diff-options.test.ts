/** The diff layout, unified unless a caller asks for split, and the code blocks. */

import { describe, expect, it } from "vitest";

import { HIGHLIGHT_MAX_LINES } from "./code-fence";
import { codeFileOptions, inlineDiffOptions } from "./diff-options";

describe("inlineDiffOptions", () => {
  it("renders unified when no style is given, as the timeline's rows do", () => {
    expect(inlineDiffOptions("light").diffStyle).toBe("unified");
    expect(inlineDiffOptions("dark").themeType).toBe("dark");
  });

  it("passes a split style through to the renderer", () => {
    expect(inlineDiffOptions("light", "split").diffStyle).toBe("split");
    expect(inlineDiffOptions("light", "unified").diffStyle).toBe("unified");
  });

  it("scrolls long lines unless asked to wrap them", () => {
    expect(inlineDiffOptions("light").overflow).toBe("scroll");
    expect(inlineDiffOptions("light", "split", false).overflow).toBe("scroll");
    expect(inlineDiffOptions("light", "split", true).overflow).toBe("wrap");
    expect(inlineDiffOptions("dark", "unified", true).overflow).toBe("wrap");
  });
});

describe("codeFileOptions", () => {
  it("draws no header or gutter and follows the theme", () => {
    const options = codeFileOptions("dark", false);
    expect(options.themeType).toBe("dark");
    expect(options.disableFileHeader).toBe(true);
    expect(options.disableLineNumbers).toBe(true);
    // A line count to the library, so it caps where the block's own line cap does.
    expect(options.tokenizeMaxLength).toBe(HIGHLIGHT_MAX_LINES);
  });

  it("wraps only when asked", () => {
    expect(codeFileOptions("light", false).overflow).toBe("scroll");
    expect(codeFileOptions("light", true).overflow).toBe("wrap");
  });
});
