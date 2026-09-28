/**
 * Codex's own session rollouts, for importing them as threads. This is the
 * `sessions` extension, and it only reads.
 *
 * The CLI writes one JSON Lines rollout per thread at
 * `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`, where
 * `CODEX_HOME` is the instance's own, else `~/.codex` — the home a
 * `thread/resume` looks in, so an imported thread resumes the same
 * conversation. Each line is `{ timestamp, type, payload }`
 * (`fixtures/codex/session-files/`):
 *
 * - `session_meta` — the thread's `id`, `cwd` and start `timestamp`. A
 *   `source` naming a `subagent` is a thread another thread spawned, which is
 *   not listed.
 * - `response_item` with `payload.type` `message` — `role` `user` or
 *   `assistant`, whose `content[].text` blocks (`input_text`, `output_text`)
 *   are joined. `developer` messages are the CLI's instructions, and a user
 *   block that is injected context — the `AGENTS.md` preamble, or a block
 *   wholly inside one tag such as `<environment_context>` or
 *   `<user_instructions>`, or an attached image's bare `<image …>` frame — is
 *   not the user's; both are left out. A prompt that mentions files arrives
 *   after the file list, under `## My request:`, and is read from there.
 * - `event_msg` `user_message` / `agent_message` — the older rollouts' copy of
 *   the conversation, used only when a rollout has no messages of the kind
 *   above, so a rollout carrying both is not read twice.
 *
 * Reasoning, tool calls, token counts, turn context and world state are not
 * part of the transcript. `<CODEX_HOME>/session_index.jsonl` names threads —
 * `{ id, thread_name }`, the last line for an id winning — and that name is
 * the title; without one, the first prompt is.
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

import type { CodexSessionRef } from "./sessionRef";

export interface CodexSessionFilesOptions {
  /** The instance's `CODEX_HOME`. */
  readonly codexHome: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_FILE =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Context the CLI puts into a user message: one block wholly inside a single tag. */
const TAGGED_CONTEXT = /^<([a-z_][\w-]*)(\s[^>]*)?>[\s\S]*<\/\1>$/i;
/** A block that is only a tag, opening or closing — an attached image's frame. */
const BARE_TAG = /^<\/?[a-z_][\w-]*(\s[^\n]*)?>$/i;
const AGENTS_PREAMBLE = /^# AGENTS\.md instructions for /;

const isInjected = (text: string): boolean =>
  TAGGED_CONTEXT.test(text) || BARE_TAG.test(text) || AGENTS_PREAMBLE.test(text);

/**
 * The desktop app sends a prompt that mentions files as a list of them and
 * then the prompt under `## My request:`; the prompt is what the user said.
 */
const MENTIONED_FILES = /^# Files mentioned by the user:[\s\S]*?\n## My request:\n/;

const withoutFileList = (text: string): string => text.trim().replace(MENTIONED_FILES, "").trim();

/** A message item's own text blocks, joined; undefined when none is left. */
const contentText = (content: unknown, role: "user" | "assistant"): string | undefined => {
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((block) => {
    if (!isRecord(block) || typeof block.text !== "string") return [];
    if (block.type !== "input_text" && block.type !== "output_text") return [];
    const text = role === "user" ? withoutFileList(block.text) : block.text.trim();
    return text === "" || (role === "user" && isInjected(text)) ? [] : [text];
  });
  return texts.length === 0 ? undefined : texts.join("\n\n");
};

/** What a pass over a rollout's records has found so far. */
class CodexScan {
  id: string | undefined;
  cwd: string | undefined;
  startedAt: string | undefined;
  subagent = false;
  readonly items = new TranscriptWindow();
  readonly events = new TranscriptWindow();

  /** The conversation: the message items, else the older event copy. */
  transcript(): TranscriptWindow {
    return this.items.count > 0 ? this.items : this.events;
  }

  visit = (raw: unknown): void => {
    if (!isRecord(raw) || !isRecord(raw.payload)) return;
    const payload = raw.payload;
    const timestamp = textField(raw, "timestamp");
    const at = timestamp === undefined ? {} : { timestamp };
    if (raw.type === "session_meta") {
      this.id ??= textField(payload, "id");
      this.cwd ??= textField(payload, "cwd");
      this.startedAt ??= textField(payload, "timestamp") ?? timestamp;
      this.subagent ||= isRecord(payload.source) && "subagent" in payload.source;
      return;
    }
    if (raw.type === "response_item" && payload.type === "message") {
      const role = payload.role;
      if (role !== "user" && role !== "assistant") return;
      const text = contentText(payload.content, role);
      if (text !== undefined) this.items.add({ role, text, ...at });
      return;
    }
    if (raw.type === "event_msg") {
      const role =
        payload.type === "user_message"
          ? "user"
          : payload.type === "agent_message"
            ? "assistant"
            : undefined;
      const text = textField(payload, "message")?.trim();
      if (role === undefined || text === undefined) return;
      if (role === "user" && isInjected(text)) return;
      this.events.add({ role, text, ...at });
    }
  };
}

export const makeCodexSessionFiles = (options: CodexSessionFilesOptions): SessionsExtension => {
  const sessionsDir = NodePath.join(options.codexHome, "sessions");
  const indexPath = NodePath.join(options.codexHome, "session_index.jsonl");

  /** Every rollout path, in no order; none when the CLI has never run. */
  const rolloutPaths = Effect.tryPromise(() => readdir(sessionsDir, { recursive: true })).pipe(
    Effect.map((names) =>
      names
        .filter((name) => ROLLOUT_FILE.test(NodePath.basename(name)))
        .map((name) => NodePath.join(sessionsDir, name)),
    ),
    Effect.orElseSucceed((): Array<string> => []),
  );

  /** Thread names by id; none when the index is missing or unreadable. */
  const threadNames = Effect.gen(function* () {
    const names = new Map<string, string>();
    yield* readJsonLines(indexPath, (raw) => {
      if (!isRecord(raw)) return;
      const id = textField(raw, "id");
      const name = textField(raw, "thread_name")?.trim();
      if (id !== undefined && name !== undefined) names.set(id.toLowerCase(), name);
    });
    return names as ReadonlyMap<string, string>;
  }).pipe(Effect.orElseSucceed((): ReadonlyMap<string, string> => new Map()));

  const sessionOf = (
    file: SessionFile,
    scan: CodexScan,
    names: ReadonlyMap<string, string>,
    counted: boolean,
  ): ImportableSession | undefined => {
    const transcript = scan.transcript();
    const sourceId = scan.id ?? ROLLOUT_FILE.exec(NodePath.basename(file.path))?.[1];
    const prompt = transcript.firstPrompt;
    if (sourceId === undefined || !UUID.test(sourceId) || scan.cwd === undefined) return undefined;
    const title =
      names.get(sourceId.toLowerCase()) ??
      (prompt === undefined ? undefined : titleFromPrompt(prompt));
    // A file read whole with nothing to import is not listed; one too long to
    // read whole is, if its head or its title names it.
    if (title === undefined || (counted && transcript.count === 0)) return undefined;
    const updatedAt = isoFromMs(file.mtimeMs);
    return {
      sourceId,
      cwd: scan.cwd,
      title,
      startedAt: scan.startedAt ?? updatedAt,
      updatedAt,
      ...(counted ? { messageCount: transcript.count } : {}),
    };
  };

  const summarize = (file: SessionFile, names: ReadonlyMap<string, string>) =>
    Effect.gen(function* () {
      const scan = new CodexScan();
      yield* readJsonLines(file.path, scan.visit, { end: HEAD_BYTES - 1 });
      return scan.subagent ? undefined : sessionOf(file, scan, names, file.size <= HEAD_BYTES);
    }).pipe(
      // One unreadable rollout leaves the rest of the list standing.
      Effect.catch((error) =>
        Effect.as(Effect.logDebug(`codex sessions: ${error.message}`), undefined),
      ),
    );

  const list = ({ limit }: { readonly limit: number }) =>
    Effect.gen(function* () {
      const wanted = Math.max(0, Math.min(limit, MAX_LISTED_SESSIONS));
      const files = yield* Effect.flatMap(rolloutPaths, newestFirst);
      if (files.length === 0 || wanted === 0) return [];
      const names = yield* threadNames;
      const out: Array<ImportableSession> = [];
      // Newest first, a batch at a time, until the list is full: a subagent's
      // rollout or one with nothing to import does not take a place.
      for (let start = 0; start < files.length && out.length < wanted; start += wanted) {
        const batch = yield* Effect.forEach(
          files.slice(start, start + wanted),
          (file) => summarize(file, names),
          { concurrency: 8 },
        );
        for (const session of batch) {
          if (session !== undefined && out.length < wanted) out.push(session);
        }
      }
      return out;
    });

  const read = (sourceId: string) =>
    Effect.gen(function* () {
      if (!UUID.test(sourceId)) {
        return yield* new ConnectorExtensionFailed({
          code: "invalid",
          message: `not a Codex thread id: ${sourceId}`,
        });
      }
      const matches = (yield* rolloutPaths).filter(
        (path) =>
          ROLLOUT_FILE.exec(NodePath.basename(path))?.[1]?.toLowerCase() === sourceId.toLowerCase(),
      );
      const file = (yield* newestFirst(matches))[0];
      if (file === undefined) {
        return yield* new ConnectorExtensionFailed({
          code: "not-found",
          message: `Codex has no session ${sourceId}`,
        });
      }
      const scan = new CodexScan();
      yield* readJsonLines(file.path, scan.visit);
      const session = sessionOf(file, scan, yield* threadNames, true);
      if (session === undefined) {
        return yield* new ConnectorExtensionFailed({
          code: "invalid",
          message: `Codex's session ${sourceId} has no messages to import`,
        });
      }
      const sessionRef: CodexSessionRef = { threadId: session.sourceId, cwd: session.cwd };
      const transcript: ImportedTranscript = {
        session,
        messages: scan.transcript().messages(),
        sessionRef,
      };
      return transcript;
    });

  return { list, read };
};
