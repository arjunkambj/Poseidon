/**
 * Finding the dev server a script prints — `Local: http://localhost:5173/`,
 * `Listening on http://0.0.0.0:3000` — in a script terminal's output, so the
 * drawer and the Run menu can offer to open it in a browser.
 *
 * Only loopback pages count: `localhost` and its `*.localhost` names,
 * `127.0.0.1`, `[::1]`, and `0.0.0.0`, which a server binds to but a browser
 * cannot open, so it becomes `localhost`. A network address the same banner
 * prints beside it is left out. Colour codes are stripped first; the few URLs
 * kept are the first ones printed.
 *
 * Output arrives in pieces cut anywhere, a URL included. `makeUrlScanner`
 * carries the unfinished end of the last line into the next piece, and reads
 * a URL only once something has followed it.
 */

import type { TerminalAttachItem } from "@poseidon/client-runtime/terminalAtoms";

/** At most this many dev servers per terminal. */
export const DEV_SERVER_URLS_MAX = 4;

/** How much of an unfinished line the scanner carries into the next piece. */
const CARRY_MAX_CHARS = 500;

const ESC = "\u001b";
/** CSI, OSC (ended by BEL or ST) and the two-character escapes. */
const ANSI = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)`,
    `${ESC}[@-Z\\\\-_]`,
    "\\u009b[0-?]*[ -/]*[@-~]",
  ].join("|"),
  "g",
);

/** The text without its colour codes and other escape sequences. */
export const stripAnsi = (text: string): string => text.replace(ANSI, "");

/** The C0 and C1 control ranges, which never belong to a URL. */
const CONTROLS = "\u0000-\u001f\u007f-\u009f";
/** A URL candidate: up to whitespace, a quote, an angle bracket, a backtick or a control. */
const CANDIDATE = new RegExp(`https?://[^\\s"'<>\`${CONTROLS}]+`, "gi");
/** Punctuation that ends a sentence rather than the URL. */
const TRAILING = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", "'", '"']);
/** What is left of a colour code whose escape was cut off, as `[39m`. */
const SGR_RESIDUE = /\[[\d;]*m$/;

const count = (text: string, char: string): number => text.split(char).length - 1;

/** The candidate without the sentence punctuation or code residue after it. */
const trimCandidate = (raw: string): string => {
  let url = raw.replace(SGR_RESIDUE, "");
  while (url.length > 0) {
    const last = url[url.length - 1]!;
    if (!TRAILING.has(last)) break;
    // `[::1]` and `(…)` in a path keep a closer that has its opener.
    if (last === "]" && count(url, "[") >= count(url, "]")) break;
    if (last === ")" && count(url, "(") >= count(url, ")")) break;
    url = url.slice(0, -1).replace(SGR_RESIDUE, "");
  }
  return url;
};

const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]" ||
  hostname === "0.0.0.0";

/** The loopback page `raw` names, normalised; null for anything else. */
const devServerUrlOf = (raw: string): string | null => {
  let url: URL;
  try {
    url = new URL(trimCandidate(raw));
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopback(url.hostname)) {
    return null;
  }
  if (url.hostname === "0.0.0.0") url.hostname = "localhost";
  return url.href;
};

/** The dev server URLs in `text`, first printed first, deduplicated, at most `DEV_SERVER_URLS_MAX`. */
export const devServerUrls = (text: string): ReadonlyArray<string> => {
  const found: Array<string> = [];
  for (const match of stripAnsi(text).matchAll(CANDIDATE)) {
    const url = devServerUrlOf(match[0]);
    if (url !== null && !found.includes(url)) {
      found.push(url);
      if (found.length === DEV_SERVER_URLS_MAX) break;
    }
  }
  return found;
};

/** `host:port` for a label — `localhost:5173`. */
export const devServerLabel = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export interface UrlScanner {
  /** The dev server URLs first seen in this piece of output. */
  readonly push: (chunk: string) => ReadonlyArray<string>;
}

export const makeUrlScanner = (): UrlScanner => {
  let carry = "";
  const seen = new Set<string>();
  return {
    push: (chunk) => {
      const text = carry + chunk;
      // Only what something has followed is read: a URL at the very end may
      // go on in the next piece.
      const lastSpace = text.search(/\s\S*$/);
      const settled = lastSpace === -1 ? "" : text.slice(0, lastSpace + 1);
      const lineEnd = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
      carry = text.slice(lineEnd + 1).slice(-CARRY_MAX_CHARS);
      if (seen.size >= DEV_SERVER_URLS_MAX) return [];
      const fresh = devServerUrls(settled).filter((url) => !seen.has(url));
      const kept = fresh.slice(0, DEV_SERVER_URLS_MAX - seen.size);
      kept.forEach((url) => seen.add(url));
      return kept;
    },
  };
};

/**
 * Wraps an attach stream's `push` so a script terminal's output — its
 * snapshot's scrollback, then each `output` item — goes through a scanner,
 * and `note` hears of each dev server it finds. A plain shell's is not read.
 */
export const scanningDevServers = (
  push: (item: TerminalAttachItem) => void,
  note: (urls: ReadonlyArray<string>) => void,
): ((item: TerminalAttachItem) => void) => {
  let scanner: UrlScanner | null = null;
  return (item) => {
    if (item.kind === "snapshot") {
      scanner = item.terminal.script === undefined ? null : makeUrlScanner();
    }
    if (scanner !== null && (item.kind === "snapshot" || item.kind === "output")) {
      const urls = scanner.push(item.data);
      if (urls.length > 0) note(urls);
    }
    push(item);
  };
};
