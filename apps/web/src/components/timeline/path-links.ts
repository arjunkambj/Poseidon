/**
 * Which strings in an agent's message name a file in the workspace — the
 * string-level half of the timeline's file chips. Nothing here knows whether a
 * file exists: these functions pick the candidates, `files.stat` confirms
 * them (`use-path-chips.ts`), and only a confirmed path becomes a chip.
 *
 * - `parsePathLink` reads a markdown link target: a relative or absolute path,
 *   optionally with `:line[:col]`, `#L12` or `#L12-L20`, or a `file://` URL.
 *   Any other scheme, a bare anchor, a protocol-relative URL and anything with
 *   a query string is not a path.
 * - `inlineCodePathCandidate` is stricter, because inline code is mostly not a
 *   path: it needs a `/` or a file extension, and gives up on anything that
 *   reads as a command, a flag, a glob, a variable or a URL.
 * - `collectPathCandidates` scans a whole message for both, cheaply, so one
 *   batched `files.stat` covers every chip the message could show.
 * - `pathChipSuffixes` names the parent folders that tell two chips with the
 *   same file name apart, and `confirmedFiles` joins them onto the files
 *   `files.stat` confirmed.
 */

import type { FileStat } from "@poseidon/contracts/rpc";

/** A path a link or a code span names, with the line it points at. */
export interface PathLink {
  /** The path as written — what `files.stat` is asked about. */
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  /** The end of a `#L12-L20` range. */
  readonly endLine?: number;
}

/** Past this, inline code is prose or data, not a path someone would name. */
const MAX_INLINE_PATH = 200;

const FILE_URL = "file://";
const LINE_SUFFIX = /:(\d+)(?::(\d+))?$/;
const LINE_FRAGMENT = /^L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
// Whitespace, glob and shell characters, quotes, variables, and a backslash: a
// command, a pattern or a Windows path, not a workspace path to open.
const NOT_INLINE_PATH = /[\s*?$<>|;&"'`{}=,\\!^%]/;

/** A control character (NUL, a line break, DEL) never belongs in a path worth opening. */
const hasControl = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const positive = (digits: string | undefined): number | undefined => {
  if (digits === undefined) return undefined;
  const value = Number.parseInt(digits, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

const withPosition = (
  path: string,
  line: number | undefined,
  column?: number,
  endLine?: number,
): PathLink => ({
  path,
  ...(line === undefined ? {} : { line }),
  ...(line === undefined || column === undefined ? {} : { column }),
  ...(line === undefined || endLine === undefined || endLine <= line ? {} : { endLine }),
});

/** `path` with a trailing `:line[:col]` split off. */
const splitLineSuffix = (value: string): PathLink => {
  const match = LINE_SUFFIX.exec(value);
  if (match === null) return { path: value };
  return withPosition(value.slice(0, match.index), positive(match[1]), positive(match[2]));
};

/** Whether what is left after the position is a plausible path at all. */
export const plausiblePath = (path: string): boolean =>
  path !== "" &&
  path !== "." &&
  path !== ".." &&
  !path.startsWith("//") &&
  !path.startsWith("~") &&
  !path.startsWith("#") &&
  !hasControl(path) &&
  !SCHEME.test(path);

const decode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

/** The path a `file://` URL names: absolute, with any `localhost` host dropped. */
const fileUrlPath = (href: string): string | null => {
  const rest = href.slice(FILE_URL.length);
  const withoutHost = rest.startsWith("localhost/") ? rest.slice("localhost".length) : rest;
  return withoutHost.startsWith("/") ? withoutHost : null;
};

/** The workspace path a markdown link points at, or null when it is not one. */
export const parsePathLink = (href: string): PathLink | null => {
  let value = href.trim();
  if (value === "" || value.includes("?")) return null;
  if (value.slice(0, FILE_URL.length).toLowerCase() === FILE_URL) {
    const path = fileUrlPath(value);
    if (path === null) return null;
    value = path;
  }
  let fragment: string | undefined;
  const hash = value.indexOf("#");
  if (hash >= 0) {
    fragment = value.slice(hash + 1);
    value = value.slice(0, hash);
  }
  const decoded = decode(value);
  if (decoded === null) return null;
  const link = splitLineSuffix(decoded);
  if (!plausiblePath(link.path)) return null;
  const range = fragment === undefined ? null : LINE_FRAGMENT.exec(fragment);
  if (range !== null) {
    return withPosition(link.path, positive(range[1]), undefined, positive(range[2]));
  }
  // Any other fragment is a heading in the file (`README.md#install`): the
  // file is still the target, without a line.
  return link;
};

/** The path an inline code span names, or null when it does not look like one. */
export const inlineCodePathCandidate = (text: string): PathLink | null => {
  if (text === "" || text.length > MAX_INLINE_PATH) return null;
  if (NOT_INLINE_PATH.test(text) || text.startsWith("-") || text.includes("#")) return null;
  const link = splitLineSuffix(text);
  const { path } = link;
  if (!plausiblePath(path)) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!path.includes("/") && !EXTENSION.test(name)) return null;
  // A path of dots and slashes alone (`../..`) names no file.
  if (!/[A-Za-z0-9_]/.test(path)) return null;
  return link;
};

const LINK_TARGET = /\]\(\s*<?([^\s)>]+)>?(?:\s+["'(][^)]*)?\)/g;
const REFERENCE_TARGET = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm;
const CODE_SPAN = /(`+)([^\n]+?)\1(?!`)/g;

/**
 * Every path the message could turn into a chip, each once, in the order
 * first seen. A cheap scan of the source rather than a parse: a candidate it
 * finds that the renderer never shows (a span inside a fenced block) costs one
 * extra entry in the batch, and one it misses renders as plain text.
 */
export const collectPathCandidates = (markdown: string): ReadonlyArray<string> => {
  const found = new Set<string>();
  for (const pattern of [LINK_TARGET, REFERENCE_TARGET]) {
    for (const match of markdown.matchAll(pattern)) {
      const link = parsePathLink(match[1] ?? "");
      if (link !== null) found.add(link.path);
    }
  }
  for (const match of markdown.matchAll(CODE_SPAN)) {
    const link = inlineCodePathCandidate((match[2] ?? "").trim());
    if (link !== null) found.add(link.path);
  }
  return [...found];
};

/**
 * For relative paths shown by their file name, the parent folders each one
 * needs to be told apart from the others with the same name: `lib/` for
 * `apps/web/src/lib/format.ts` and `src/` for `packages/shared/src/format.ts`.
 * When the nearest folders match as well, more of the path is shown. A path
 * whose name is unique gets no entry.
 */
export const pathChipSuffixes = (paths: ReadonlyArray<string>): ReadonlyMap<string, string> => {
  const byName = new Map<string, Array<{ path: string; parents: ReadonlyArray<string> }>>();
  for (const path of new Set(paths)) {
    const parts = path.split("/").filter((part) => part !== "");
    const name = parts.at(-1) ?? path;
    byName.set(name, [...(byName.get(name) ?? []), { path, parents: parts.slice(0, -1) }]);
  }
  const suffixes = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const entry of group) {
      const tail = (parents: ReadonlyArray<string>, size: number) => parents.slice(-size).join("/");
      let depth = 1;
      while (
        depth < entry.parents.length &&
        group.some(
          (other) => other !== entry && tail(other.parents, depth) === tail(entry.parents, depth),
        )
      ) {
        depth += 1;
      }
      const suffix = tail(entry.parents, depth);
      if (suffix !== "") suffixes.set(entry.path, `${suffix}/`);
    }
  }
  return suffixes;
};

/** A file `files.stat` confirmed, as a chip shows it. */
export interface ConfirmedFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  /** The parent folders shown before the name when another chip shares it. */
  readonly suffix?: string;
}

/**
 * The confirmed answers keyed by the path as it was asked, so the renderer
 * looks a link or a code span up by the string it parsed. Directories are left
 * out: a chip opens a file.
 */
export const confirmedFiles = (
  stats: ReadonlyArray<FileStat>,
): ReadonlyMap<string, ConfirmedFile> => {
  const files = stats.filter((stat) => !stat.isDirectory);
  const suffixes = pathChipSuffixes(files.map((stat) => stat.relativePath));
  return new Map(
    files.map((stat) => {
      const suffix = suffixes.get(stat.relativePath);
      return [
        stat.path,
        {
          relativePath: stat.relativePath,
          absolutePath: stat.absolutePath,
          ...(suffix === undefined ? {} : { suffix }),
        },
      ] as const;
    }),
  );
};

/** A file's name: the last segment of its path. */
export const baseName = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
};

/** `:12`, `:12:3` or `:12–20`, the position a chip shows after the name. */
export const positionLabel = (link: Pick<PathLink, "line" | "column" | "endLine">): string => {
  if (link.line === undefined) return "";
  if (link.endLine !== undefined) return `:${link.line}–${link.endLine}`;
  return link.column === undefined ? `:${link.line}` : `:${link.line}:${link.column}`;
};
