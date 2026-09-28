/**
 * Codex's session rollouts, read from `fixtures/codex/session-files/` — a
 * `CODEX_HOME` with three hand-built rollouts in the CLI's record shapes and
 * its `session_index.jsonl`. Each test works on a temporary copy, so nothing
 * reads a real `~/.codex`, and the copy's files are hashed around every read to
 * show the reader never writes.
 */

import { createHash } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { ImportableSession } from "@poseidon/contracts/sessionImport";
import { fixturesRoot } from "@poseidon/testkit/recording";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CODEX_KIND } from "./kind";
import { makeCodexSessionFiles } from "./sessionFiles";
import { parseSessionRef } from "./sessionRef";

const FIXTURE = NodePath.join(fixturesRoot(CODEX_KIND), "session-files");
const ALPHA_ID = "01990000-0000-7000-8000-00000000000a";
const BETA_ID = "01990000-0000-7000-8000-00000000000b";
const SUBAGENT_ID = "01990000-0000-7000-8000-00000000000c";

const rollout = (day: string, time: string, id: string) =>
  NodePath.join("sessions", ...day.split("-"), `rollout-${day}T${time}-${id}.jsonl`);

/** Each rollout's last write, set so the order does not depend on the checkout. */
const MTIMES: ReadonlyArray<readonly [string, string]> = [
  [rollout("2026-09-20", "10-00-00", ALPHA_ID), "2026-09-20T10:05:00.000Z"],
  [rollout("2026-09-21", "08-00-00", BETA_ID), "2026-09-21T08:05:00.000Z"],
  // A subagent's rollout, newer than every session, is still not listed.
  [rollout("2026-09-22", "09-00-00", SUBAGENT_ID), "2026-09-22T09:05:00.000Z"],
];

const copyFixture = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-session-files-"));
  NodeFS.cpSync(FIXTURE, home, { recursive: true });
  for (const [file, at] of MTIMES) {
    const time = new Date(at);
    NodeFS.utimesSync(NodePath.join(home, file), time, time);
  }
  return home;
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

const readerIn = (codexHome: string) => makeCodexSessionFiles({ codexHome });

describe("makeCodexSessionFiles", () => {
  it.effect("lists sessions newest first, titled and counted, leaving subagents out", () =>
    Effect.gen(function* () {
      const sessions = yield* readerIn(copyFixture()).list({ limit: 50 });
      expect(sessions).toEqual([
        {
          sourceId: BETA_ID,
          cwd: "<HOME>/code/beta",
          // Not in the index: the first prompt the user wrote.
          title: "Summarise the beta changelog",
          startedAt: "2026-09-21T08:00:00.000Z",
          updatedAt: "2026-09-21T08:05:00.000Z",
          messageCount: 2,
        },
        {
          sourceId: ALPHA_ID,
          cwd: "<HOME>/code/alpha",
          // The index's name for the thread, the last line for it winning.
          title: "Alpha file tour",
          startedAt: "2026-09-20T10:00:00.000Z",
          updatedAt: "2026-09-20T10:05:00.000Z",
          messageCount: 4,
        },
      ]);
      for (const session of sessions) {
        expect(Schema.decodeUnknownSync(ImportableSession)(session)).toEqual(session);
      }
    }),
  );

  it.effect("stops at the limit", () =>
    Effect.gen(function* () {
      const sessions = yield* readerIn(copyFixture()).list({ limit: 1 });
      expect(sessions.map((session) => session.sourceId)).toEqual([BETA_ID]);
    }),
  );

  it.effect("reads the user's own words and the replies, without injected context", () =>
    Effect.gen(function* () {
      const transcript = yield* readerIn(copyFixture()).read(ALPHA_ID);
      expect(transcript.session.title).toBe("Alpha file tour");
      expect(transcript.messages).toEqual([
        // The developer message, the AGENTS.md preamble and the environment
        // context before it are the CLI's; the torn line after it is skipped.
        { role: "user", text: "List the files in alpha", timestamp: "2026-09-20T10:00:01.000Z" },
        {
          role: "assistant",
          text: "There are two files: README.md and main.ts.",
          timestamp: "2026-09-20T10:00:03.000Z",
        },
        // The prompt after the desktop app's file list, without the image frame.
        {
          role: "user",
          text: "What does main.ts export?",
          timestamp: "2026-09-20T10:01:00.500Z",
        },
        // One reply's two text blocks, joined.
        {
          role: "assistant",
          text: "It exports one function, start.\n\nNothing else is exported.",
          timestamp: "2026-09-20T10:01:02.000Z",
        },
      ]);
      expect(parseSessionRef(transcript.sessionRef)).toEqual({
        threadId: ALPHA_ID,
        cwd: "<HOME>/code/alpha",
      });
    }),
  );

  it.effect("reads an older rollout's conversation from its event copies", () =>
    Effect.gen(function* () {
      const transcript = yield* readerIn(copyFixture()).read(BETA_ID);
      expect(transcript.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "Summarise the beta changelog"],
        ["assistant", "Two releases: one fix and one feature."],
      ]);
      expect(parseSessionRef(transcript.sessionRef)).toEqual({
        threadId: BETA_ID,
        cwd: "<HOME>/code/beta",
      });
    }),
  );

  it.effect("answers an empty list for a home with no sessions", () =>
    Effect.gen(function* () {
      const missing = NodePath.join(NodeOS.tmpdir(), "codex-session-files-missing", "home");
      expect(yield* readerIn(missing).list({ limit: 50 })).toEqual([]);
    }),
  );

  it.effect("refuses an unknown id and one that is not a thread id", () =>
    Effect.gen(function* () {
      const reader = readerIn(copyFixture());
      const unknown = yield* Effect.flip(reader.read("01990000-0000-7000-8000-0000000000ff"));
      expect(unknown.code).toBe("not-found");
      const invalid = yield* Effect.flip(reader.read("../auth"));
      expect(invalid.code).toBe("invalid");
    }),
  );

  it("names the session a thread's ref points at, and none for another connector's", () => {
    const reader = readerIn(copyFixture());
    expect(reader.sourceIdOf?.({ threadId: ALPHA_ID, cwd: "/code/alpha" })).toBe(ALPHA_ID);
    expect(reader.sourceIdOf?.({ sessionId: ALPHA_ID, cwd: "/code/alpha" })).toBeUndefined();
    expect(reader.sourceIdOf?.(null)).toBeUndefined();
  });

  it.effect("leaves every source file byte-identical with its last write unchanged", () =>
    Effect.gen(function* () {
      const home = copyFixture();
      const before = snapshot(home);
      const reader = readerIn(home);
      yield* reader.list({ limit: 50 });
      for (const id of [ALPHA_ID, BETA_ID, SUBAGENT_ID]) {
        yield* reader.read(id);
      }
      expect(snapshot(home)).toEqual(before);
    }),
  );
});
