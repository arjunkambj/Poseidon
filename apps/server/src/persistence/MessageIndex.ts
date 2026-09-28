/**
 * The message-search index: the text of every user and assistant message,
 * kept beside the thread projection and searched through FTS5.
 *
 * `thread_messages` and its trigram index come from migration 0008. The
 * read-model store calls `syncThreadMessages` from `putThread`, so the index
 * is written in the same transaction as the projection and can never get
 * ahead of the events. Tool output, command output and diffs are never
 * indexed: search answers "where did we talk about this", not "which run
 * printed it".
 */

import type { ItemId, ProjectId, ThreadId } from "@poseidon/contracts/ids";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import type { ThreadDoc } from "../orchestration/state";

/** The most hits one search returns, whatever the caller asks for. */
export const MESSAGE_SEARCH_LIMIT = 50;

/** The trigram tokenizer cannot match anything shorter. */
const MESSAGE_SEARCH_MIN_LENGTH = 3;

const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 80;
const SNIPPET_FALLBACK = SNIPPET_BEFORE + SNIPPET_AFTER;

export type MessageRole = "user" | "assistant";

/** One thread whose message text matched: the newest matching message in it. */
export interface MessageSearchHit {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly archived: boolean;
  readonly itemId: ItemId;
  readonly role: MessageRole;
  /** One line around the first match, `…` where it was cut. */
  readonly snippet: string;
}

interface HitRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly status: string;
  readonly item_id: string;
  readonly role: string;
  readonly text: string;
}

const roleOf = (kind: string): MessageRole | null =>
  kind === "user_message" ? "user" : kind === "assistant_message" ? "assistant" : null;

/**
 * Brings the thread's rows in line with its document: new messages are
 * inserted, a message whose text changed (a streamed answer growing) is
 * reindexed, an unchanged one costs a lookup, and a message no longer in the
 * document is dropped. One statement each, whatever the thread's length.
 */
export const syncThreadMessages = (
  sql: SqlClient.SqlClient,
  doc: ThreadDoc,
): Effect.Effect<void, SqlError> => {
  const messages: Array<{ readonly i: string; readonly r: MessageRole; readonly t: string }> = [];
  for (const item of doc.items) {
    const role = roleOf(item.kind);
    if (role !== null && item.text !== undefined && item.text.trim() !== "") {
      messages.push({ i: item.itemId, r: role, t: item.text });
    }
  }
  const ids = JSON.stringify(messages.map((message) => message.i));
  // `WHERE true` is SQLite's rule for an upsert fed by a SELECT: without a
  // WHERE the parser reads `ON CONFLICT` as a join constraint.
  const upsert =
    messages.length === 0
      ? Effect.void
      : sql`
          INSERT INTO thread_messages (thread_id, item_id, role, text)
          SELECT ${doc.threadId}, json_extract(value, '$.i'), json_extract(value, '$.r'),
            json_extract(value, '$.t')
          FROM json_each(${JSON.stringify(messages)})
          WHERE true
          ON CONFLICT (thread_id, item_id) DO UPDATE SET text = excluded.text
          WHERE thread_messages.text IS NOT excluded.text
        `.pipe(Effect.asVoid);
  const prune = sql`
    DELETE FROM thread_messages
    WHERE thread_id = ${doc.threadId}
      AND item_id NOT IN (SELECT value FROM json_each(${ids}))
  `.pipe(Effect.asVoid);
  return Effect.andThen(upsert, prune);
};

export const removeThreadMessages = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
): Effect.Effect<void, SqlError> =>
  sql`DELETE FROM thread_messages WHERE thread_id = ${threadId}`.pipe(Effect.asVoid);

/**
 * Empties the index. Row by row through the delete trigger, so the FTS table
 * is told about every row it drops and stays consistent.
 */
export const clearMessageIndex = (sql: SqlClient.SqlClient): Effect.Effect<void, SqlError> =>
  sql`DELETE FROM thread_messages`.pipe(Effect.asVoid);

/**
 * The query as one FTS5 phrase: quoted, with its own quotes doubled, so `*`,
 * `:`, `-`, `AND` and the rest are text to find rather than query syntax.
 */
const phraseOf = (query: string): string => `"${query.replaceAll('"', '""')}"`;

/**
 * Threads whose user or assistant text contains `query` (case-insensitive),
 * one hit per thread — its newest matching message — most recently active
 * first, archived threads included and marked. Under three characters the
 * trigram index cannot answer, so the answer is empty.
 */
export const searchMessages = (
  sql: SqlClient.SqlClient,
  query: string,
  limit: number = MESSAGE_SEARCH_LIMIT,
): Effect.Effect<ReadonlyArray<MessageSearchHit>, SqlError> => {
  const trimmed = query.trim();
  if (Array.from(trimmed).length < MESSAGE_SEARCH_MIN_LENGTH) {
    return Effect.succeed([]);
  }
  const cap = Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.floor(limit), MESSAGE_SEARCH_LIMIT))
    : MESSAGE_SEARCH_LIMIT;
  return sql<HitRow>`
    SELECT t.thread_id, t.project_id, t.title, t.status, m.item_id, m.role, m.text
    FROM (
      SELECT thread_id, MAX(rowid) AS best
      FROM thread_messages
      WHERE rowid IN (
        SELECT rowid FROM thread_messages_fts WHERE thread_messages_fts MATCH ${phraseOf(trimmed)}
      )
      GROUP BY thread_id
    ) hits
    JOIN thread_messages m ON m.rowid = hits.best
    JOIN threads t ON t.thread_id = m.thread_id
    ORDER BY t.updated_at DESC
    LIMIT ${cap}
  `.pipe(
    Effect.map((rows) =>
      rows.map((row): MessageSearchHit => ({
        threadId: row.thread_id as ThreadId,
        projectId: row.project_id as ProjectId,
        title: row.title,
        archived: row.status === "archived",
        itemId: row.item_id as ItemId,
        role: row.role === "user" ? "user" : "assistant",
        snippet: messageSnippet(row.text, trimmed),
      })),
    ),
  );
};

/**
 * One line of `text` around the first case-insensitive occurrence of
 * `query`: about 40 characters before it and 80 after, cut at word breaks
 * where one is near, with `…` on each cut end. When JavaScript's case folding
 * misses a match SQLite found (some non-ASCII text), the line starts at the
 * text's beginning instead.
 */
export const messageSnippet = (text: string, query: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  const needle = query.replace(/\s+/g, " ").trim().toLowerCase();
  const at = needle === "" ? -1 : indexIgnoringCase(line, needle);
  if (at < 0) {
    const end = Math.min(line.length, SNIPPET_FALLBACK);
    return `${line.slice(0, end)}${end < line.length ? "…" : ""}`;
  }
  const matchEnd = at + needle.length;
  let start = Math.max(0, at - SNIPPET_BEFORE);
  let end = Math.min(line.length, matchEnd + SNIPPET_AFTER);
  // Start and end on a word break when there is one between the cut and the
  // match, so the line does not open or close on half a word.
  if (start > 0) {
    const space = line.indexOf(" ", start);
    if (space >= 0 && space < at) {
      start = space + 1;
    }
  }
  if (end < line.length) {
    const space = line.lastIndexOf(" ", end);
    if (space > matchEnd) {
      end = space;
    }
  }
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
};

/**
 * Where `needle` (already lower case) first occurs in `line`, ignoring case,
 * as an index into `line` itself. Lower-casing a few characters changes the
 * string's length, which would shift an index taken from the lower-cased
 * copy, so such text is compared window by window instead.
 */
const indexIgnoringCase = (line: string, needle: string): number => {
  const lower = line.toLowerCase();
  if (lower.length === line.length) {
    return lower.indexOf(needle);
  }
  for (let index = 0; index + needle.length <= line.length; index += 1) {
    if (line.slice(index, index + needle.length).toLowerCase() === needle) {
      return index;
    }
  }
  return -1;
};
