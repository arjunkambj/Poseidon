/**
 * Claude Code's own session transcripts, for importing them as threads. This
 * is the `sessions` extension, and it only reads.
 *
 * The CLI writes one JSON Lines transcript per session at
 * `<config>/projects/<cwd, slashes as dashes>/<session id>.jsonl`, where
 * `<config>` is the instance's `CLAUDE_CONFIG_DIR`, else `~/.claude` — the
 * directory a `--resume` looks in, so an imported thread resumes the same
 * conversation. Directories beside the transcripts (a session's subagents)
 * are not sessions and are not read.
 *
 * Each line is one record (`fixtures/claude/session-files/`):
 *
 * - `user` — `message.content` is the prompt as a string, or a block array
 *   whose `text` blocks are kept. An array of `tool_result` blocks alone is a
 *   tool's answer, and a string in one of the CLI's own wrappers
 *   (`<command-name>`, `<local-command-stdout>`, …) is a slash command's echo;
 *   neither is a message.
 * - `assistant` — one record per content block, the blocks of one reply
 *   sharing `message.id`; their `text` blocks are joined. `thinking` and
 *   `tool_use` blocks are left out, as is the CLI's `<synthetic>` model.
 * - `isMeta` records are the CLI's notes to the model, and `isSidechain`
 *   records a subagent's conversation; both are skipped.
 * - `custom-title` (`customTitle`, set by the user) and `ai-title`
 *   (`aiTitle`) name the session; the last of each wins. Every other record
 *   type — attachments, queue operations, file history, system, last prompt,
 *   agent name — is not part of the transcript.
 */

import { readdir } from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ConnectorExtensionFailed,
  type ImportedTranscript,
  type SessionsExtension,
} from "@poseidon/connector-sdk/extensions";
import {
  HEAD_BYTES,
  MAX_LISTED_SESSIONS,
  TranscriptWindow,
  isRecord,
  isoFromMs,
  newestFirst,
  readJsonLines,
  textField,
  titleFromPrompt,
  type SessionFile,
} from "@poseidon/connector-sdk/sessionFiles";
import type { ImportableSession } from "@poseidon/contracts/sessionImport";
import * as Effect from "effect/Effect";

import { claudeConfigDir } from "./plugins";
import { parseSessionRef, type ClaudeSessionRef } from "./sessionRef";

export interface ClaudeSessionFilesOptions {
  /** The environment the instance's sessions run with (`childEnv`). */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** How much of a file's end a `list` reads for a title set late in the session. */
const TAIL_BYTES = 64 * 1024;

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** The CLI's own wrappers around a slash command, its output and its notices. */
const CLI_WRAPPER =
  /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|system-reminder|bash-input|bash-stdout|bash-stderr)>/;

/** What a pass over a transcript's records has found so far. */
class ClaudeScan {
  cwd: string | undefined;
  startedAt: string | undefined;
  customTitle: string | undefined;
  aiTitle: string | undefined;
  readonly transcript = new TranscriptWindow();

  title(): string | undefined {
    const prompt = this.transcript.firstPrompt;
    return (
      this.customTitle ??
      this.aiTitle ??
      (prompt === undefined ? undefined : titleFromPrompt(prompt))
    );
  }

  /** Takes in one record; any record may carry the directory and a time. */
  visit = (raw: unknown): void => {
    if (!isRecord(raw)) return;
    this.startedAt ??= textField(raw, "timestamp");
    this.cwd ??= textField(raw, "cwd");
    if (raw.type === "custom-title") {
      this.customTitle = textField(raw, "customTitle")?.trim() ?? this.customTitle;
      return;
    }
    if (raw.type === "ai-title") {
      this.aiTitle = textField(raw, "aiTitle")?.trim() ?? this.aiTitle;
      return;
    }
    if (raw.type !== "user" && raw.type !== "assistant") return;
    if (raw.isMeta === true || raw.isSidechain === true || !isRecord(raw.message)) return;
    const timestamp = textField(raw, "timestamp");
    const at = timestamp === undefined ? {} : { timestamp };
    if (raw.type === "user") {
      const text = userText(raw.message.content);
      if (text !== undefined) this.transcript.add({ role: "user", text, ...at });
      return;
    }
    if (raw.message.model === "<synthetic>") return;
    const text = blockText(raw.message.content);
    if (text !== undefined) {
      this.transcript.add({ role: "assistant", text, ...at }, textField(raw.message, "id"));
    }
  };
}

/** The `text` blocks of a content array, joined; undefined when there are none. */
const blockText = (content: unknown): string | undefined => {
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string"
      ? [block.text.trim()].filter((text) => text !== "" && !CLI_WRAPPER.test(text))
      : [],
  );
  return texts.length === 0 ? undefined : texts.join("\n\n");
};

/** A user record's prompt, or undefined for a tool's answer or the CLI's own echo. */
const userText = (content: unknown): string | undefined => {
  if (typeof content === "string") {
    const text = content.trim();
    return text === "" || CLI_WRAPPER.test(text) ? undefined : text;
  }
  return blockText(content);
};

export const makeClaudeSessionFiles = (options: ClaudeSessionFilesOptions): SessionsExtension => {
  const projectsDir = NodePath.join(claudeConfigDir(options.env), "projects");

  /** Every transcript path, in no order; none when the CLI has never run. */
  const transcriptPaths = Effect.gen(function* () {
    const projects = yield* Effect.tryPromise(() =>
      readdir(projectsDir, { withFileTypes: true }),
    ).pipe(Effect.orElseSucceed(() => []));
    const perProject = yield* Effect.forEach(
      projects.filter((entry) => entry.isDirectory()),
      (project) => {
        const dir = NodePath.join(projectsDir, project.name);
        return Effect.tryPromise(() => readdir(dir)).pipe(
          Effect.map((names) =>
            names.filter((name) => SESSION_FILE.test(name)).map((name) => NodePath.join(dir, name)),
          ),
          Effect.orElseSucceed((): Array<string> => []),
        );
      },
      { concurrency: 16 },
    );
    return perProject.flat();
  });

  const sessionOf = (
    file: SessionFile,
    scan: ClaudeScan,
    counted: boolean,
  ): ImportableSession | undefined => {
    const count = scan.transcript.count;
    const sourceId = SESSION_FILE.exec(NodePath.basename(file.path))?.[1];
    const title = scan.title();
    // A file read whole with nothing to import is not listed; one too long to
    // read whole is, if its head or its title names it.
    if (sourceId === undefined || scan.cwd === undefined || title === undefined) return undefined;
    if (counted && count === 0) return undefined;
    const updatedAt = isoFromMs(file.mtimeMs);
    return {
      sourceId,
      cwd: scan.cwd,
      title,
      startedAt: scan.startedAt ?? updatedAt,
      updatedAt,
      ...(counted ? { messageCount: count } : {}),
    };
  };

  /** One file's listing from its head, and its tail for a late title. */
  const summarize = (file: SessionFile) =>
    Effect.gen(function* () {
      const scan = new ClaudeScan();
      yield* readJsonLines(file.path, scan.visit, { end: HEAD_BYTES - 1 });
      if (file.size > HEAD_BYTES) {
        const tail = new ClaudeScan();
        yield* readJsonLines(file.path, tail.visit, {
          start: Math.max(HEAD_BYTES, file.size - TAIL_BYTES),
        });
        scan.customTitle = tail.customTitle ?? scan.customTitle;
        scan.aiTitle = tail.aiTitle ?? scan.aiTitle;
      }
      return sessionOf(file, scan, file.size <= HEAD_BYTES);
    }).pipe(
      // One unreadable transcript leaves the rest of the list standing.
      Effect.catch((error) =>
        Effect.as(Effect.logDebug(`claude sessions: ${error.message}`), undefined),
      ),
    );

  const list = ({ limit }: { readonly limit: number }) =>
    Effect.gen(function* () {
      const wanted = Math.max(0, Math.min(limit, MAX_LISTED_SESSIONS));
      const files = yield* Effect.flatMap(transcriptPaths, newestFirst);
      const out: Array<ImportableSession> = [];
      // Newest first, a batch at a time, until the list is full: a transcript
      // with nothing to import does not take a place.
      for (let start = 0; start < files.length && out.length < wanted; start += wanted) {
        const batch = yield* Effect.forEach(files.slice(start, start + wanted), summarize, {
          concurrency: 8,
        });
        for (const session of batch) {
          if (session !== undefined && out.length < wanted) out.push(session);
        }
      }
      return out;
    });

  const read = (sourceId: string) =>
    Effect.gen(function* () {
      if (!SESSION_FILE.test(`${sourceId}.jsonl`)) {
        return yield* new ConnectorExtensionFailed({
          code: "invalid",
          message: `not a Claude Code session id: ${sourceId}`,
        });
      }
      const matches = (yield* transcriptPaths).filter(
        (path) => NodePath.basename(path).toLowerCase() === `${sourceId.toLowerCase()}.jsonl`,
      );
      const file = (yield* newestFirst(matches))[0];
      if (file === undefined) {
        return yield* new ConnectorExtensionFailed({
          code: "not-found",
          message: `Claude Code has no session ${sourceId}`,
        });
      }
      const scan = new ClaudeScan();
      yield* readJsonLines(file.path, scan.visit);
      const session = sessionOf(file, scan, true);
      if (session === undefined) {
        return yield* new ConnectorExtensionFailed({
          code: "invalid",
          message: `Claude Code's session ${sourceId} has no messages to import`,
        });
      }
      const sessionRef: ClaudeSessionRef = { sessionId: session.sourceId, cwd: session.cwd };
      const transcript: ImportedTranscript = {
        session,
        messages: scan.transcript.messages(),
        sessionRef,
      };
      return transcript;
    });

  /** The session a thread of this connector runs: the one its ref names. */
  const sourceIdOf = (sessionRef: unknown): string | undefined =>
    parseSessionRef(sessionRef)?.sessionId;

  return { list, read, sourceIdOf };
};
