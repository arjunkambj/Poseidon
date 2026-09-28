/**
 * The `@pierre/diffs` options every `InlineDiff` and markdown code block
 * renders with, apart from the components so the choice is testable without a
 * DOM. Timeline rows never pass a diff style or `wrap`, so they stay unified
 * and scroll sideways; only the Changes pane offers split and wrapped lines.
 */

import type { FileDiffOptions, FileOptions } from "@pierre/diffs/react";

import type { DiffStyle } from "@/state/ui";

import { HIGHLIGHT_MAX_LINES } from "./code-fence";

export const DIFF_THEMES = { light: "pierre-light", dark: "pierre-dark" } as const;

export const inlineDiffOptions = (
  themeType: "light" | "dark",
  diffStyle: DiffStyle = "unified",
  wrap = false,
): FileDiffOptions<undefined, undefined> => ({
  theme: DIFF_THEMES,
  themeType,
  diffStyle,
  disableFileHeader: true,
  overflow: wrap ? "wrap" : "scroll",
});

/**
 * A markdown code block's options: the diff themes, no header or gutter (the
 * block draws its own header), wrapping when the reader asked for it, and a
 * tokenize cap matching the line count past which the block renders plain
 * anyway. The library reads `tokenizeMaxLength` as a number of lines, not of
 * characters; the character cap is `highlightable`'s alone.
 */
export const codeFileOptions = (
  themeType: "light" | "dark",
  wrap: boolean,
): FileOptions<undefined, undefined> => ({
  theme: DIFF_THEMES,
  themeType,
  disableFileHeader: true,
  disableLineNumbers: true,
  overflow: wrap ? "wrap" : "scroll",
  tokenizeMaxLength: HIGHLIGHT_MAX_LINES,
});
