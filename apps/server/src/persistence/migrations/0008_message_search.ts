import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The message-search index.
 *
 * `thread_messages` holds the text of every user and assistant message, one
 * row per timeline item, beside the thread it belongs to; tool output, command
 * output and diffs are never copied in. `thread_messages_fts` is an
 * external-content FTS5 index over that text with the trigram tokenizer, so a
 * phrase query matches any case-insensitive substring of three or more
 * characters — what a search box expects, not whole-word matching. The three
 * triggers are the standard ones for an external-content table: the index is
 * told the OLD text on delete and update, without which it corrupts.
 *
 * The backfill fills the table from the projections already stored, so an
 * existing install is searchable without a projection rebuild. From here on
 * `ReadModelStore.putThread` keeps it in step, inside the command's
 * transaction.
 *
 * `(thread_id, item_id)` rather than `item_id` alone is the key, so a thread
 * that copies another's items keeps its own rows.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE thread_messages (
      rowid INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      UNIQUE (thread_id, item_id)
    )
  `;

  yield* sql`
    CREATE VIRTUAL TABLE thread_messages_fts USING fts5(
      text,
      content = 'thread_messages',
      content_rowid = 'rowid',
      tokenize = 'trigram'
    )
  `;

  yield* sql`
    CREATE TRIGGER thread_messages_ai AFTER INSERT ON thread_messages BEGIN
      INSERT INTO thread_messages_fts (rowid, text) VALUES (new.rowid, new.text);
    END
  `;

  yield* sql`
    CREATE TRIGGER thread_messages_ad AFTER DELETE ON thread_messages BEGIN
      INSERT INTO thread_messages_fts (thread_messages_fts, rowid, text)
      VALUES ('delete', old.rowid, old.text);
    END
  `;

  yield* sql`
    CREATE TRIGGER thread_messages_au AFTER UPDATE ON thread_messages BEGIN
      INSERT INTO thread_messages_fts (thread_messages_fts, rowid, text)
      VALUES ('delete', old.rowid, old.text);
      INSERT INTO thread_messages_fts (rowid, text) VALUES (new.rowid, new.text);
    END
  `;

  yield* sql`
    INSERT OR IGNORE INTO thread_messages (thread_id, item_id, role, text)
    SELECT
      t.thread_id,
      json_extract(i.value, '$.itemId'),
      CASE json_extract(i.value, '$.kind') WHEN 'user_message' THEN 'user' ELSE 'assistant' END,
      json_extract(i.value, '$.text')
    FROM threads t, json_each(t.doc_json, '$.items') i
    WHERE json_extract(i.value, '$.kind') IN ('user_message', 'assistant_message')
      AND json_extract(i.value, '$.itemId') IS NOT NULL
      AND typeof(json_extract(i.value, '$.text')) = 'text'
      AND json_extract(i.value, '$.text') <> ''
  `;
});
