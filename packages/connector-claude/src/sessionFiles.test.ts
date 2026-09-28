/**
 * Claude Code's session transcripts, read from `fixtures/claude/session-files/`
 * — a config directory's `projects/` with three hand-built sessions in the
 * CLI's record shapes. Each test works on a temporary copy, so nothing reads a
 * real `~/.claude`, and the copy's files are hashed around every read to show
 * the reader never writes.
 */

import { createHash } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { HEAD_BYTES } from "@poseidon/connector-sdk/sessionFiles";
import { ImportableSession } from "@poseidon/contracts/sessionImport";
import { fixturesRoot } from "@poseidon/testkit/recording";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CLAUDE_KIND } from "./kind";
import { makeClaudeSessionFiles } from "./sessionFiles";
import { parseSessionRef } from "./sessionRef";

const FIXTURE = NodePath.join(fixturesRoot(CLAUDE_KIND), "session-files");
const ALPHA_ID = "0b6f3c1e-5a2d-4c8e-9f10-2a3b4c5d6e01";
const NOISY_ID = "0b6f3c1e-5a2d-4c8e-9f10-2a3b4c5d6e02";
const BETA_ID = "0b6f3c1e-5a2d-4c8e-9f10-2a3b4c5d6e03";
const ALPHA_DIR = NodePath.join("projects", "-HOME-code-alpha");
const BETA_DIR = NodePath.join("projects", "-HOME-code-beta");

/** Each file's last write, set so the order does not depend on the checkout. */
const MTIMES: ReadonlyArray<readonly [string, string]> = [
  [NodePath.join(ALPHA_DIR, `${ALPHA_ID}.jsonl`), "2026-09-20T10:05:00.000Z"],
  [NodePath.join(ALPHA_DIR, `${NOISY_ID}.jsonl`), "2026-09-21T09:35:00.000Z"],
  [NodePath.join(BETA_DIR, `${BETA_ID}.jsonl`), "2026-09-22T14:20:00.000Z"],
  // A subagent's transcript, newer than every session, is still not one.
  [
    NodePath.join(ALPHA_DIR, ALPHA_ID, "subagents", "agent-fixture.jsonl"),
    "2026-09-23T08:00:00.000Z",
  ],
];

const copyFixture = () => {
  const config = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-session-files-"));
  NodeFS.cpSync(FIXTURE, config, { recursive: true });
  for (const [file, at] of MTIMES) {
    const time = new Date(at);
    NodeFS.utimesSync(NodePath.join(config, file), time, time);
  }
  return config;
};

/** Every file under `root`, with its content hash and last write. */
const snapshot = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of NodeFS.readdirSync(root, { recursive: true }) as Array<string>) {
    const path = NodePath.join(root, name);
    const info = NodeFS.statSync(path);
    if (!info.isFile()) continue;
    const hash = createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
    out[name] = `${hash} ${info.mtimeMs}`;
  }
  return out;
};

const readerIn = (config: string) => makeClaudeSessionFiles({ env: { CLAUDE_CONFIG_DIR: config } });

describe("makeClaudeSessionFiles", () => {
  it.effect("lists sessions newest first, titled and counted", () =>
    Effect.gen(function* () {
      const sessions = yield* readerIn(copyFixture()).list({ limit: 50 });
      expect(sessions).toEqual([
        {
          sourceId: BETA_ID,
          cwd: "<HOME>/code/beta",
          // The CLI's own title, since the user set none.
          title: "Rename beta package",
          startedAt: "2026-09-22T14:15:00.000Z",
          updatedAt: "2026-09-22T14:20:00.000Z",
          messageCount: 2,
        },
        {
          sourceId: NOISY_ID,
          cwd: "<HOME>/code/alpha",
          // No title at all: the first real prompt, cut at a word.
          title: "Explain how the retry loop in the fetch helper decides when to stop, and…",
          startedAt: "2026-09-21T09:30:00.000Z",
          updatedAt: "2026-09-21T09:35:00.000Z",
          messageCount: 4,
        },
        {
          sourceId: ALPHA_ID,
          cwd: "<HOME>/code/alpha",
          // The user's title wins over the CLI's, and the last one set wins.
          title: "Alpha README",
          startedAt: "2026-09-20T10:00:00.000Z",
          updatedAt: "2026-09-20T10:05:00.000Z",
          messageCount: 5,
        },
      ]);
      for (const session of sessions) {
        expect(Schema.decodeUnknownSync(ImportableSession)(session)).toEqual(session);
      }
    }),
  );

  it.effect("stops at the limit", () =>
    Effect.gen(function* () {
      const sessions = yield* readerIn(copyFixture()).list({ limit: 2 });
      expect(sessions.map((session) => session.sourceId)).toEqual([BETA_ID, NOISY_ID]);
    }),
  );

  it.effect("reads a long file's title from its end, and leaves its count to a read", () =>
    Effect.gen(function* () {
      const config = copyFixture();
      const file = NodePath.join(config, BETA_DIR, `${BETA_ID}.jsonl`);
      const filler = JSON.stringify({
        type: "attachment",
        attachment: { type: "todo_reminder", content: [] },
        sessionId: BETA_ID,
        padding: "x".repeat(1024),
      });
      const lines = Array.from({ length: Math.ceil(HEAD_BYTES / filler.length) + 1 }, () => filler);
      lines.push(
        JSON.stringify({ type: "custom-title", customTitle: "Gamma rename", sessionId: BETA_ID }),
      );
      NodeFS.appendFileSync(file, `${lines.join("\n")}\n`);
      const sessions = yield* readerIn(config).list({ limit: 50 });
      const beta = sessions.find((session) => session.sourceId === BETA_ID);
      expect(beta?.title).toBe("Gamma rename");
      // Too long to read whole, so the list gives no count rather than a short one.
      expect(beta?.messageCount).toBeUndefined();
      expect((yield* readerIn(config).read(BETA_ID)).session.messageCount).toBe(2);
    }),
  );

  it.effect("reads a transcript's messages and a ref the connector resumes from", () =>
    Effect.gen(function* () {
      const transcript = yield* readerIn(copyFixture()).read(ALPHA_ID);
      expect(transcript.session.title).toBe("Alpha README");
      expect(transcript.messages).toEqual([
        {
          role: "user",
          text: "Add a README to the alpha project",
          timestamp: "2026-09-20T10:00:01.000Z",
        },
        // The reply's thinking and tool call are left out; its text is kept.
        {
          role: "assistant",
          text: "I'll add a short README.",
          timestamp: "2026-09-20T10:00:02.000Z",
        },
        {
          role: "assistant",
          text: "README.md is in place.",
          timestamp: "2026-09-20T10:00:04.000Z",
        },
        { role: "user", text: "Also mention the licence", timestamp: "2026-09-20T10:00:05.000Z" },
        { role: "assistant", text: "Added a licence line.", timestamp: "2026-09-20T10:00:06.000Z" },
      ]);
      expect(parseSessionRef(transcript.sessionRef)).toEqual({
        sessionId: ALPHA_ID,
        cwd: "<HOME>/code/alpha",
      });
    }),
  );

  it.effect("skips meta, sidechain, tool and command records and a torn line", () =>
    Effect.gen(function* () {
      const transcript = yield* readerIn(copyFixture()).read(NOISY_ID);
      expect(transcript.messages.map((message) => [message.role, message.text])).toEqual([
        [
          "user",
          "Explain how the retry loop in the fetch helper decides when to stop, and whether it waits between attempts at all",
        ],
        // One reply written as several records sharing its message id.
        ["assistant", "It stops after three attempts,\n\nand it doubles the wait between them."],
        ["user", "Thanks"],
        ["assistant", "You're welcome."],
      ]);
      expect(transcript.session.messageCount).toBe(4);
    }),
  );

  it.effect("never takes a compaction's summary for a message or a title", () =>
    Effect.gen(function* () {
      const config = copyFixture();
      // The alpha fixture's own compaction: its summary is not in the messages.
      const alpha = yield* readerIn(config).read(ALPHA_ID);
      expect(alpha.messages.some((message) => message.text.includes("being continued"))).toBe(
        false,
      );
      // A file that starts with the summary is titled by the prompt after it.
      const source = NodeFS.readFileSync(NodePath.join(config, ALPHA_DIR, `${ALPHA_ID}.jsonl`), {
        encoding: "utf8",
      }).split("\n");
      const summary = source.find((line) => line.includes('"isCompactSummary":true'));
      const prompt = source.find((line) => line.includes('"Also mention the licence"'));
      const id = "0b6f3c1e-5a2d-4c8e-9f10-2a3b4c5d6e04";
      NodeFS.writeFileSync(
        NodePath.join(config, ALPHA_DIR, `${id}.jsonl`),
        `${[summary, prompt].join("\n")}\n`,
      );
      const read = yield* readerIn(config).read(id);
      expect(read.session.title).toBe("Also mention the licence");
      expect(read.messages.map((message) => message.text)).toEqual(["Also mention the licence"]);
    }),
  );

  it.effect("answers an empty list for a config directory with no sessions", () =>
    Effect.gen(function* () {
      const missing = NodePath.join(NodeOS.tmpdir(), "claude-session-files-missing", "config");
      expect(yield* readerIn(missing).list({ limit: 50 })).toEqual([]);
    }),
  );

  it.effect("refuses an unknown id and one that is not a session id", () =>
    Effect.gen(function* () {
      const reader = readerIn(copyFixture());
      const unknown = yield* Effect.flip(reader.read("0b6f3c1e-5a2d-4c8e-9f10-2a3b4c5d6eff"));
      expect(unknown.code).toBe("not-found");
      const invalid = yield* Effect.flip(reader.read("../settings"));
      expect(invalid.code).toBe("invalid");
    }),
  );

  it("names the session a thread's ref points at, and none for another connector's", () => {
    const reader = readerIn(copyFixture());
    expect(reader.sourceIdOf?.({ sessionId: ALPHA_ID, cwd: "/code/alpha" })).toBe(ALPHA_ID);
    expect(
      reader.sourceIdOf?.({ sessionId: ALPHA_ID, cwd: "/code/alpha", lastAssistantUuid: "a" }),
    ).toBe(ALPHA_ID);
    expect(reader.sourceIdOf?.({ threadId: ALPHA_ID, cwd: "/code/alpha" })).toBeUndefined();
    expect(reader.sourceIdOf?.(null)).toBeUndefined();
  });

  it.effect("leaves every source file byte-identical with its last write unchanged", () =>
    Effect.gen(function* () {
      const config = copyFixture();
      const before = snapshot(config);
      const reader = readerIn(config);
      yield* reader.list({ limit: 50 });
      for (const id of [ALPHA_ID, NOISY_ID, BETA_ID]) {
        yield* reader.read(id);
      }
      expect(snapshot(config)).toEqual(before);
    }),
  );
});
