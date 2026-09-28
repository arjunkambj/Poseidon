/**
 * What every `sessions` extension needs to read a harness's session files:
 * JSON Lines read a line at a time, files ordered newest first, a title from a
 * prompt, and a transcript kept within its caps. The formats themselves stay
 * in each connector.
 *
 * Everything here only reads. Files are opened with the `r` flag and nothing
 * is written anywhere, so an import never changes what the harness recorded.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import * as NodeReadline from "node:readline";
import * as Effect from "effect/Effect";

import { ConnectorExtensionFailed, type ImportedMessage } from "./extensions";

/** The most sessions one `list` answers, whatever it asks for. */
export const MAX_LISTED_SESSIONS = 200;

/** How much of each file a `list` reads for its id, directory and first prompt. */
export const HEAD_BYTES = 256 * 1024;

/** The most messages a `read` keeps: the newest ones. */
export const MAX_TRANSCRIPT_MESSAGES = 500;

/** The most text a `read` keeps across its messages, in characters. */
export const MAX_TRANSCRIPT_CHARS = 1_000_000;

/** The most text one message keeps; the rest is cut. */
const MAX_MESSAGE_CHARS = 32_000;

/** How long a title made from a prompt may be. */
const MAX_TITLE_CHARS = 80;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A string field with something in it, else undefined. */
export const textField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

export const failedRead = (path: string, error: unknown): ConnectorExtensionFailed =>
  new ConnectorExtensionFailed({
    code: "internal",
    message: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
  });

export interface LineRange {
  /** The first byte read. A range that starts past 0 drops its first, partial line. */
  readonly start?: number;
  /** The last byte read, inclusive. The line it cuts is not valid JSON, so it is dropped. */
  readonly end?: number;
}

/**
 * Hands `visit` each line of `path` that parses as JSON, in order, until the
 * file (or the range) ends or `visit` answers `false`. A line that does not
 * parse — a torn last line, a range's cut edge — is skipped, not an error.
 */
export const readJsonLines = (
  path: string,
  visit: (record: unknown) => boolean | void,
  range: LineRange = {},
): Effect.Effect<void, ConnectorExtensionFailed> =>
  Effect.tryPromise({
    try: async () => {
      const input = createReadStream(path, { flags: "r", encoding: "utf8", ...range });
      const lines = NodeReadline.createInterface({ input, crlfDelay: Infinity });
      let skip = (range.start ?? 0) > 0;
      try {
        for await (const line of lines) {
          if (skip) {
            skip = false;
            continue;
          }
          if (line.trim() === "") continue;
          let record: unknown;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          if (visit(record) === false) break;
        }
      } finally {
        lines.close();
        input.destroy();
      }
    },
    catch: (error) => failedRead(path, error),
  });

export interface SessionFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** The files that exist, newest write first; one that cannot be stat'd is left out. */
export const newestFirst = (
  paths: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<SessionFile>> =>
  Effect.forEach(
    paths,
    (path) =>
      Effect.tryPromise(() => stat(path)).pipe(
        Effect.map((info): ReadonlyArray<SessionFile> =>
          info.isFile() ? [{ path, size: info.size, mtimeMs: info.mtimeMs }] : [],
        ),
        Effect.orElseSucceed((): ReadonlyArray<SessionFile> => []),
      ),
    { concurrency: 16 },
  ).pipe(Effect.map((found) => found.flat().sort((left, right) => right.mtimeMs - left.mtimeMs)));

/** A prompt as a title: its whitespace collapsed and its length capped, at a word when it can. */
export const titleFromPrompt = (prompt: string): string => {
  const flat = prompt.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_TITLE_CHARS) return flat;
  const cut = flat.slice(0, MAX_TITLE_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > MAX_TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

const capMessage = (text: string): string =>
  text.length <= MAX_MESSAGE_CHARS ? text : `${text.slice(0, MAX_MESSAGE_CHARS)}…`;

/**
 * A transcript being read. `add` counts every message; `messages` answers the
 * newest of them within the caps, oldest first. An assistant message added
 * with the same `key` as the one before it — a harness writing one reply's
 * text blocks as separate records — is joined onto it instead.
 */
export class TranscriptWindow {
  private kept: Array<{ role: ImportedMessage["role"]; text: string; timestamp?: string }> = [];
  private lastKey: string | undefined;
  count = 0;
  firstPrompt: string | undefined;

  add(message: ImportedMessage, key?: string): void {
    const last = this.kept.at(-1);
    if (
      key !== undefined &&
      key === this.lastKey &&
      message.role === "assistant" &&
      last?.role === "assistant"
    ) {
      last.text = capMessage(`${last.text}\n\n${message.text}`);
      return;
    }
    this.lastKey = key;
    this.count += 1;
    if (message.role === "user" && this.firstPrompt === undefined) {
      this.firstPrompt = message.text;
    }
    this.kept.push({
      role: message.role,
      text: capMessage(message.text),
      ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
    });
    // Older messages past the cap are let go as the read goes, keeping the
    // last one so a join still finds it.
    if (this.kept.length > MAX_TRANSCRIPT_MESSAGES * 2) {
      this.kept = this.kept.slice(-MAX_TRANSCRIPT_MESSAGES);
    }
  }

  messages(): ReadonlyArray<ImportedMessage> {
    const newest = this.kept.slice(-MAX_TRANSCRIPT_MESSAGES);
    let chars = newest.reduce((total, message) => total + message.text.length, 0);
    let first = 0;
    while (chars > MAX_TRANSCRIPT_CHARS && first < newest.length - 1) {
      chars -= newest[first]!.text.length;
      first += 1;
    }
    return newest.slice(first).map((message) => ({ ...message }));
  }
}

/** A file's last write as the wire's timestamp. */
export const isoFromMs = (ms: number): string => new Date(ms).toISOString();
