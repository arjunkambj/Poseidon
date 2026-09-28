/**
 * Which strings a terminal line prints name a place in a file — the string
 * half of the terminal's file links. Nothing here knows whether a file
 * exists: `findFileReferences` picks the candidates, `files.stat` confirms
 * them (`./file-link-provider`), and only a confirmed file becomes a link.
 *
 * A reference needs a line: `src/a.ts:12`, `src/a.ts:12:3`, `./a.ts:1`, an
 * absolute path, a stack frame's `(/abs/a.ts:10:5)`, a `file://` URL with a
 * position, or tsc's `src/a.ts(12,3)`. Quotes, brackets and trailing
 * punctuation around it are not part of it. The path must hold a `/` or a file
 * extension, so a clock time (`12:30:45`) or a `host:port` never qualifies,
 * and nothing inside an http(s) URL is looked at — those are the web-links
 * addon's. A Windows path (a drive letter or a backslash) is not matched.
 */

import type { ModKey } from "@poseidon/client-runtime/keybindings";

import { plausiblePath } from "@/components/timeline/path-links";

/** A file position a terminal line names, by its UTF-16 offsets in the line. */
export interface FileReference {
  /** Where the reference starts, inclusive. */
  readonly start: number;
  /** Where it ends, exclusive. */
  readonly end: number;
  /** The path as printed — what `files.stat` is asked about. */
  readonly path: string;
  readonly line: number;
  readonly column?: number;
}

const LEADING_WRAPPERS = "\"'`([{<";
const FILE_URL = "file://";
// The path (no colon, paren, quote or brace), then `:line[:col]` or tsc's
// `(line,col)`, then the end of the token or punctuation that follows it.
const REFERENCE =
  /^([^:()"'`<>|,;{}]+?)(?::(\d+)(?::(\d+))?|\((\d+)(?:,(\d+))?\))(?=$|[:,;.)\]}'"`>!?])/;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
// Glob and shell characters, variables and a backslash: a command, a pattern
// or a Windows path, not a workspace path to open.
const NOT_PATH = /[*?$<>|;&"'`{}=,\\!^%]/;

const positive = (digits: string | undefined): number | undefined => {
  if (digits === undefined) return undefined;
  const value = Number.parseInt(digits, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

const pathLike = (path: string): boolean => {
  if (!plausiblePath(path) || NOT_PATH.test(path) || !/[A-Za-z0-9_]/.test(path)) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return path.includes("/") || EXTENSION.test(name);
};

/** The reference one whitespace-free token holds, if any; `at` is its offset in the line. */
const referenceIn = (token: string, at: number): FileReference | null => {
  let lead = 0;
  while (lead < token.length && LEADING_WRAPPERS.includes(token.charAt(lead))) lead += 1;
  let core = token.slice(lead);
  let prefix = 0;
  if (core.slice(0, FILE_URL.length).toLowerCase() === FILE_URL) {
    prefix = FILE_URL.length;
    core = core.slice(prefix);
    if (!core.startsWith("/")) return null;
  }
  // Any other URL — http(s) above all — is not a file on disk.
  if (core.includes("://")) return null;
  const match = REFERENCE.exec(core);
  if (match === null) return null;
  const path = match[1] ?? "";
  const line = positive(match[2] ?? match[4]);
  const column = positive(match[3] ?? match[5]);
  if (line === undefined || !pathLike(path)) return null;
  const start = at + lead;
  return {
    start,
    end: start + prefix + match[0].length,
    path,
    line,
    ...(column === undefined ? {} : { column }),
  };
};

/** Every file reference `lineText` prints, in order. */
export const findFileReferences = (lineText: string): ReadonlyArray<FileReference> => {
  const found: Array<FileReference> = [];
  for (const token of lineText.matchAll(/\S+/g)) {
    const reference = referenceIn(token[0], token.index);
    if (reference !== null) found.push(reference);
  }
  return found;
};

/**
 * What a click on a confirmed file link does. A plain click shows the file in
 * the owner's Files tab — the thread's, or on the New task page the
 * project's; a mod-click (⌘ on macOS, Ctrl elsewhere) opens it in the
 * favourite editor, or in the Files tab when no editor was found.
 */
export const fileLinkAction = (
  event: { readonly metaKey: boolean; readonly ctrlKey: boolean },
  modKey: ModKey,
  scope: { readonly hasEditor: boolean },
): "files" | "editor" => {
  const mod = modKey === "meta" ? event.metaKey : event.ctrlKey;
  return mod && scope.hasEditor ? "editor" : "files";
};
