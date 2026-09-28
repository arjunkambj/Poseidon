/**
 * The message-search index over a real SQLite file in a temp directory: what
 * `putThread` indexes (user and assistant text, never tool output), how it
 * follows edits and deletions, and what `searchMessages` answers.
 */
import { mkdtempSync } from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  makeEventId,
  makeItemId,
  makeProjectId,
  makeThreadId,
  type ProjectId,
  type ThreadId,
} from "@poseidon/contracts/ids";
import type { OrchestrationEvent } from "@poseidon/contracts/orchestration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { foldThread, type ItemSnapshot, type ThreadDoc } from "../orchestration/state";
import { MESSAGE_SEARCH_LIMIT, messageSnippet } from "./MessageIndex";
import { runMigrations } from "./Migrations";
import { ReadModelStore } from "./ReadModels";
import { layer as sqliteLayer } from "./Sqlite";

const createdEvent = (threadId: ThreadId, projectId: ProjectId, title: string) =>
  ({
    sequence: 1,
    eventId: makeEventId(),
    streamKind: "thread",
    streamId: threadId,
    streamVersion: 1,
    occurredAt: "2026-01-01T00:00:00.000Z",
    actor: "user",
    type: "thread.created",
    payload: {
      threadId,
      projectId,
      title,
      settings: { model: "fake/model", runtimeMode: "full-access", interactionMode: "default" },
    },
  }) as OrchestrationEvent;

const message = (
  kind: "user_message" | "assistant_message",
  text: string,
  itemId = makeItemId(),
): ItemSnapshot => ({ itemId, kind, status: "completed", text });

/** Real read models over a database file in a fresh temp directory. */
const stack = Effect.gen(function* () {
  const directory = mkdtempSync(NodePath.join(NodeOS.tmpdir(), "poseidon-search-"));
  const built = yield* Layer.build(
    sqliteLayer({ filename: NodePath.join(directory, "state.sqlite") }),
  );
  const sqlite = Layer.succeedContext(built);
  yield* runMigrations.pipe(Effect.provide(sqlite));
  const context = yield* Layer.build(ReadModelStore.layer.pipe(Layer.provide(sqlite)));
  const readModels = Context.get(context, ReadModelStore);
  const sql = Context.get(built, SqlClient.SqlClient);
  const projectId = makeProjectId();
  let clock = 0;
  /** Stores a thread with `items`; each call is newer than the last. */
  const put = (items: ReadonlyArray<ItemSnapshot>, overrides: Partial<ThreadDoc> = {}) =>
    Effect.gen(function* () {
      const threadId = overrides.threadId ?? makeThreadId();
      clock += 1;
      const doc: ThreadDoc = {
        ...foldThread([createdEvent(threadId, projectId, overrides.title ?? "Thread")])!,
        items,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString(),
        ...overrides,
      };
      yield* readModels.putThread(doc);
      return doc;
    });
  const rowCount = sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM thread_messages`.pipe(
    Effect.map((rows) => rows[0]!.n),
  );
  return { readModels, put, projectId, rowCount, sql };
});

describe("the message index", () => {
  it.effect("indexes user and assistant text and never tool or command output", () =>
    Effect.gen(function* () {
      const { readModels, put } = yield* stack;
      const doc = yield* put([
        message("user_message", "Please refactor the parser module"),
        message("assistant_message", "I rewrote the tokenizer loop"),
        {
          itemId: makeItemId(),
          kind: "command_execution",
          status: "completed",
          command: { cmd: "ls", output: "zebracorn.txt" },
        },
        {
          itemId: makeItemId(),
          kind: "tool_call",
          status: "completed",
          text: "giraffe tool text",
          tool: { name: "Read", input: { path: "okapi" }, output: "okapi contents" },
        },
        {
          itemId: makeItemId(),
          kind: "file_change",
          status: "completed",
          fileChange: { path: "a.ts", kind: "edit", diff: "+quokka" },
        },
        { itemId: makeItemId(), kind: "reasoning", status: "completed", text: "pondering wombats" },
      ]);

      const user = yield* readModels.searchMessages("parser");
      expect(user).toEqual([
        {
          threadId: doc.threadId,
          projectId: doc.projectId,
          title: "Thread",
          archived: false,
          itemId: doc.items[0]!.itemId,
          role: "user",
          snippet: "Please refactor the parser module",
        },
      ]);
      const assistant = yield* readModels.searchMessages("tokenizer");
      expect(assistant.map((hit) => hit.role)).toEqual(["assistant"]);
      for (const query of ["zebracorn", "giraffe", "okapi", "quokka", "wombat"]) {
        expect(yield* readModels.searchMessages(query)).toEqual([]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("finds an edited message by its new text and not its old", () =>
    Effect.gen(function* () {
      const { readModels, put } = yield* stack;
      const itemId = makeItemId();
      const doc = yield* put([message("assistant_message", "Looking at the lighthouse", itemId)]);
      yield* put([message("assistant_message", "Looking at the harbour instead", itemId)], {
        threadId: doc.threadId,
      });
      expect(yield* readModels.searchMessages("lighthouse")).toEqual([]);
      const hits = yield* readModels.searchMessages("harbour");
      expect(hits.map((hit) => [hit.threadId, hit.itemId])).toEqual([[doc.threadId, itemId]]);
    }).pipe(Effect.scoped),
  );

  it.effect("drops a message that left the document", () =>
    Effect.gen(function* () {
      const { readModels, put, rowCount } = yield* stack;
      const kept = message("user_message", "keep this sentence");
      const doc = yield* put([kept, message("assistant_message", "drop this sentence")]);
      yield* put([kept], { threadId: doc.threadId });
      expect(yield* rowCount).toBe(1);
      expect(yield* readModels.searchMessages("drop this")).toEqual([]);
      expect((yield* readModels.searchMessages("keep this")).length).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("empties with removeThread and clearProjections", () =>
    Effect.gen(function* () {
      const { readModels, put, rowCount, sql } = yield* stack;
      const first = yield* put([message("user_message", "the first meadow")]);
      yield* put([message("user_message", "the second meadow")]);
      yield* readModels.removeThread(first.threadId);
      expect(yield* rowCount).toBe(1);
      expect((yield* readModels.searchMessages("meadow")).map((hit) => hit.snippet)).toEqual([
        "the second meadow",
      ]);
      yield* readModels.clearProjections;
      expect(yield* rowCount).toBe(0);
      expect(yield* readModels.searchMessages("meadow")).toEqual([]);
      // The FTS index agrees with its content table after all those deletes.
      yield* put([message("user_message", "a third meadow")]);
      expect((yield* readModels.searchMessages("meadow")).length).toBe(1);
      yield* sql`INSERT INTO thread_messages_fts (thread_messages_fts) VALUES ('integrity-check')`;
    }).pipe(Effect.scoped),
  );

  it.effect("returns archived threads, marked", () =>
    Effect.gen(function* () {
      const { readModels, put } = yield* stack;
      const archived = yield* put([message("user_message", "old sunflower notes")], {
        status: "archived",
      });
      const hits = yield* readModels.searchMessages("sunflower");
      expect(hits.map((hit) => [hit.threadId, hit.archived])).toEqual([[archived.threadId, true]]);
    }).pipe(Effect.scoped),
  );

  it.effect("returns one hit per thread — its newest match — newest thread first", () =>
    Effect.gen(function* () {
      const { readModels, put } = yield* stack;
      const older = yield* put([
        message("user_message", "compass one"),
        message("assistant_message", "compass two"),
      ]);
      const newer = yield* put([message("user_message", "compass three")], { title: "Newer" });
      const hits = yield* readModels.searchMessages("compass");
      expect(hits.map((hit) => [hit.threadId, hit.snippet])).toEqual([
        [newer.threadId, "compass three"],
        [older.threadId, "compass two"],
      ]);
      expect(hits[0]!.title).toBe("Newer");
    }).pipe(Effect.scoped),
  );

  it.effect("caps the hits at 50", () =>
    Effect.gen(function* () {
      const { readModels, put } = yield* stack;
      for (let index = 0; index < 61; index += 1) {
        yield* put([message("user_message", `lantern number ${index}`)]);
      }
      expect((yield* readModels.searchMessages("lantern")).length).toBe(MESSAGE_SEARCH_LIMIT);
      expect((yield* readModels.searchMessages("lantern", 500)).length).toBe(MESSAGE_SEARCH_LIMIT);
      expect((yield* readModels.searchMessages("lantern", 5)).length).toBe(5);
    }).pipe(Effect.scoped),
  );

  it.effect("answers nothing under three characters", () =>
    Effect.gen(function* () {
      const { readModels, put } = yield* stack;
      yield* put([message("user_message", "ab ab ab")]);
      for (const query of ["", "  ", "ab", " ab "]) {
        expect(yield* readModels.searchMessages(query)).toEqual([]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("treats query syntax as text", () =>
    Effect.gen(function* () {
      const { readModels, put } = yield* stack;
      yield* put([message("user_message", 'run "npm test" -- --watch: a*b OR c NEAR d')]);
      for (const query of ['"npm test"', "--watch:", "a*b", "OR c NEAR", '"', '""""', "*:-"]) {
        const hits = yield* readModels.searchMessages(query);
        expect(hits.length).toBeLessThanOrEqual(1);
      }
      expect((yield* readModels.searchMessages('"npm test"')).length).toBe(1);
      expect((yield* readModels.searchMessages("--watch:")).length).toBe(1);
      expect((yield* readModels.searchMessages("a*b")).length).toBe(1);
      expect(yield* readModels.searchMessages("a*z")).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores case and matches inside words", () =>
    Effect.gen(function* () {
      const { readModels, put } = yield* stack;
      yield* put([message("assistant_message", "The WebSocketServer restarted")]);
      expect((yield* readModels.searchMessages("websocket")).length).toBe(1);
      expect((yield* readModels.searchMessages("SOCKETSERV")).length).toBe(1);
      expect((yield* readModels.searchMessages("  socket  ")).length).toBe(1);
    }).pipe(Effect.scoped),
  );
});

describe("messageSnippet", () => {
  it("keeps a short message whole, on one line", () => {
    expect(messageSnippet("  first line\n\n  second\tline  ", "second")).toBe(
      "first line second line",
    );
  });

  it("cuts around the first match at word breaks, marking both cuts", () => {
    const before = Array.from({ length: 20 }, (_, index) => `word${index}`).join(" ");
    const after = Array.from({ length: 30 }, (_, index) => `tail${index}`).join(" ");
    const snippet = messageSnippet(`${before} NEEDLE ${after}`, "needle");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("NEEDLE");
    // No half words at either end.
    expect(snippet.slice(1, -1).split(" ")[0]).toMatch(/^word\d+$/);
    expect(snippet.slice(1, -1).split(" ").at(-1)).toMatch(/^tail\d+$/);
    const at = snippet.indexOf("NEEDLE");
    expect(at).toBeLessThanOrEqual(41);
    expect(snippet.length - at).toBeLessThanOrEqual(1 + 6 + 80 + 1);
  });

  it("does not cut before a match near the start", () => {
    const snippet = messageSnippet(`needle ${"x ".repeat(100)}`, "needle");
    expect(snippet.startsWith("needle")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("matches across collapsed whitespace", () => {
    expect(messageSnippet("foo\n   bar baz", "foo  bar")).toBe("foo bar baz");
  });

  it("falls back to the start when case folding misses the match", () => {
    const long = `${"a".repeat(200)}`;
    expect(messageSnippet(long, "zzz")).toBe(`${"a".repeat(120)}…`);
    expect(messageSnippet("short", "zzz")).toBe("short");
  });

  it("indexes the original text when lower-casing changes its length", () => {
    // "İ" lower-cases to two code units, which would shift a naive index.
    const snippet = messageSnippet(`${"İ".repeat(60)} target ${"z ".repeat(60)}`, "target");
    expect(snippet).toContain("target");
    expect(snippet.startsWith("…")).toBe(true);
  });
});
