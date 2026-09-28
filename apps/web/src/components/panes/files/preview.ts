/**
 * The arithmetic and the two judgement calls behind the files tab's preview,
 * kept apart from the component so both are testable.
 *
 * `files.read` is a paging interface: it answers lines `[offset, offset+limit)`
 * plus the file's real `totalLines`, and reports `truncated` when its own byte
 * or character cap bit. So the preview is a page over the whole file rather
 * than one best-effort slice — line 20,000 of a 20,000-line file is a request,
 * not a scroll.
 *
 * Paging is by line offset rather than by page number, because the server is
 * free to answer a window *short*: its 512K-character cap stops the read
 * wherever it bites, so a 500-line request in the middle of a file with long
 * lines comes back as 262 lines and `truncated`. Counting pages would then step
 * over the 238 lines it did not send. The next window therefore starts at the
 * last line this one actually returned, and `capped` says so in the footer.
 *
 * The judgement calls: what counts as binary (the server decodes every file as
 * UTF-8, so a PNG comes back as mojibake rather than as an error), where a
 * page ends when the server returned fewer lines than were asked for, and
 * which pages are worth handing to the syntax highlighter.
 */

import type { FileContent } from "@poseidon/contracts/rpc";
import type { FileOptions } from "@pierre/diffs/react";

import {
  HIGHLIGHT_MAX_LINES,
  highlightable,
  languageForPath,
} from "@/components/timeline/code-fence";
import { DIFF_THEMES } from "@/components/timeline/diff-options";

/** Lines per page. Big enough to read, small enough to render as plain DOM. */
export const PAGE_LINES = 500;

/** The `files.read` window that starts at a zero-based line offset. */
export const windowFor = (offset: number): { readonly offset: number; readonly limit: number } => ({
  offset: Math.max(0, Math.trunc(offset)),
  limit: PAGE_LINES,
});

/** How many lines a page opened at a line shows above it, for context. */
const LINE_LEAD = 100;

/**
 * The offset to open a file at so a 1-based `line` is on the first page, with
 * room around it: a line near the top opens the file at its start, and one
 * further down opens a window that starts `LINE_LEAD` lines above it — never
 * at the line itself, which would hide what leads up to it. A line past the
 * end is the server's to answer ("No lines past …"); a line that is not a
 * positive number opens the top.
 */
export const offsetForLine = (line: number | undefined): number => {
  if (line === undefined || !Number.isFinite(line) || line < 1) {
    return 0;
  }
  const index = Math.trunc(line) - 1;
  return index < PAGE_LINES - LINE_LEAD ? 0 : index - LINE_LEAD;
};

export interface PagePosition {
  /** 1-based, inclusive. Zero when the page holds no lines at all. */
  readonly firstLine: number;
  readonly lastLine: number;
  readonly totalLines: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  /** Where the following window starts — the line after this page's last. */
  readonly nextOffset: number;
  /** The server cut this window short of `PAGE_LINES` with more file to come. */
  readonly capped: boolean;
  /** The footer sentence — "Lines 501–1,000 of 12,043". */
  readonly label: string;
}

const count = (value: number): string => value.toLocaleString("en-US");

/** Where this page sits in the file, given what the server actually returned. */
export const pagePosition = (offset: number, content: FileContent): PagePosition => {
  const start = windowFor(offset).offset;
  const lines = lineCount(content.text);
  const total = Math.max(content.totalLines, start + lines);
  const firstLine = lines === 0 ? 0 : start + 1;
  const lastLine = start + lines;
  const hasNext = lines > 0 && lastLine < total;
  return {
    firstLine,
    lastLine,
    totalLines: total,
    hasPrevious: start > 0,
    // Trust the returned line count over `totalLines`: a window that ran to the
    // end of the file is the last one even if the file grew between two reads.
    hasNext,
    nextOffset: lastLine,
    // A short window with file still to come was cut by the server's own cap,
    // not by the end of the file — the next page picks up where it stopped.
    capped: hasNext && content.truncated && lines < PAGE_LINES,
    label:
      lines === 0
        ? total === 0
          ? "Empty file"
          : `No lines past ${count(start)} of ${count(total)}`
        : `Lines ${count(firstLine)}–${count(lastLine)} of ${count(total)}`,
  };
};

/**
 * Lines in a `files.read` response. The server splits on "\n" exactly as
 * `String.split` does, so an empty body is one empty line — except that an
 * empty *file* answers `totalLines: 0`, and a window past the end answers an
 * empty body. Both of those are "no lines", not "one blank line".
 */
export const lineCount = (text: string): number => (text === "" ? 0 : text.split("\n").length);

/** One numbered row of the preview. `number` is 1-based within the whole file. */
export interface PreviewLine {
  readonly number: number;
  readonly text: string;
}

export const previewLines = (offset: number, content: FileContent): ReadonlyArray<PreviewLine> => {
  if (content.text === "") {
    return [];
  }
  const start = windowFor(offset).offset;
  return content.text.split("\n").map((text, index) => ({ number: start + index + 1, text }));
};

/** How much of the text is sampled before deciding it is not text. */
const BINARY_SAMPLE = 4_096;

/**
 * The two characters this test is about, built rather than written: the
 * formatter rewrites a `\u0000` escape into the byte itself, and an invisible
 * control character in a source file is unreadable in every diff after that.
 */
const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xff_fd);

/**
 * Whether this is a file no preview should render.
 *
 * The server has no content-type notion: it decodes every byte range as UTF-8
 * and hands back whatever that produced. A NUL byte survives that decode
 * intact and never appears in source, and bytes that are not valid UTF-8 come
 * back as U+FFFD - a few of those are a stray encoding, a page full of them is
 * an image. Either way the answer is "binary", not a wall of mojibake.
 */
export const looksBinary = (text: string): boolean => {
  const sample = text.slice(0, BINARY_SAMPLE);
  if (sample.includes(NUL)) {
    return true;
  }
  if (sample.length === 0) {
    return false;
  }
  let replacements = 0;
  for (const character of sample) {
    if (character === REPLACEMENT) {
      replacements += 1;
    }
  }
  return replacements / sample.length > 0.1;
};

/**
 * The directory prefix and the basename of a search hit, so the list can show
 * the name and mute the path it sits under.
 */
export const splitPath = (path: string): { readonly directory: string; readonly name: string } => {
  const cut = path.lastIndexOf("/");
  return cut < 0
    ? { directory: "", name: path }
    : { directory: path.slice(0, cut + 1), name: path.slice(cut + 1) };
};

/**
 * The highlighter language of a page that holds text in a language it knows,
 * or `undefined` for an empty page, a binary file or a name that says nothing.
 */
const previewLanguage = (path: string, content: FileContent): string | undefined =>
  content.text === "" || looksBinary(content.text) ? undefined : languageForPath(path);

/**
 * Whether the page is the whole file: it starts at the top, nothing follows,
 * and the server's own cap did not cut it. Only then do the line numbers the
 * highlighter draws (it always counts from 1) match the file's.
 */
const wholeFile = (offset: number, content: FileContent): boolean =>
  windowFor(offset).offset === 0 && !content.truncated && !pagePosition(offset, content).hasNext;

/**
 * The language to highlight this page in, or `null` to show it as plain rows:
 * a binary file, a name the highlighter has no grammar for, a file longer than
 * one page (paged or cut by the server), and one over the timeline's own caps
 * (`highlightable`), since tokenizing it would stall a worker.
 */
export const previewHighlight = (
  path: string,
  content: FileContent,
  offset: number,
): { readonly language: string } | null => {
  const language = previewLanguage(path, content);
  return language !== undefined && wholeFile(offset, content) && highlightable(content.text)
    ? { language }
    : null;
};

/**
 * Whether a file the highlighter knows is shown plain only because of its
 * size, so the footer can say why the colours are missing.
 */
export const tooLargeToHighlight = (path: string, content: FileContent, offset: number): boolean =>
  previewLanguage(path, content) !== undefined && previewHighlight(path, content, offset) === null;

/**
 * Names a highlighted page for the worker pool's cache: the path, the length
 * and a hash of the text, so a file edited in place — same length, other
 * bytes — is tokenized again rather than shown with its old colours.
 */
export const previewCacheKey = (path: string, text: string): string => {
  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01_00_01_93);
  }
  return `files:${path}:${text.length}:${(hash >>> 0).toString(36)}`;
};

/**
 * The options a highlighted page renders with: the diff themes (so it follows
 * light and dark like every diff), line numbers, no header (the pane shows the
 * path), long lines scrolling sideways, and the timeline's tokenize cap — the
 * library reads `tokenizeMaxLength` as lines.
 */
export const previewFileOptions = (
  themeType: "light" | "dark",
): FileOptions<undefined, undefined> => ({
  theme: DIFF_THEMES,
  themeType,
  disableFileHeader: true,
  disableLineNumbers: false,
  overflow: "scroll",
  tokenizeMaxLength: HIGHLIGHT_MAX_LINES,
});
