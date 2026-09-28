/**
 * Message search: the RPC the command palette asks for threads whose user or
 * assistant text contains what was typed, and the hit it answers with.
 *
 * Kept apart from `rpc.ts` for the same reason `editors.ts` is: the method
 * name is spread into `RPC_METHODS`, and `rpc.ts` lists the RPC in
 * `PoseidonRpcGroup`. The server searches its own index of message text; tool
 * output, command output and diffs are never part of it.
 */

import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { ItemId, ProjectId, ThreadId } from "./ids";
import { PoseidonRpcError } from "./rpcError";

/** The most hits one search answers, whatever the caller asks for. */
export const MESSAGE_SEARCH_LIMIT = 50;

/** A query shorter than this (in characters) matches nothing and is not sent. */
export const MESSAGE_SEARCH_MIN_LENGTH = 3;

export const MessageSearchRole = Schema.Literals(["user", "assistant"]);
export type MessageSearchRole = typeof MessageSearchRole.Type;

/**
 * One thread whose message text matched, carried by its newest matching
 * message. `archived` marks a thread the sidebar no longer lists, so the
 * palette can say so. `snippet` is one line around the first match, with `…`
 * where it was cut; the client marks the match itself.
 */
export const MessageSearchHit = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  archived: Schema.Boolean,
  itemId: ItemId,
  role: MessageSearchRole,
  snippet: Schema.String,
});
export type MessageSearchHit = typeof MessageSearchHit.Type;

// ── Method names and RPCs ──────────────────────────────────────

/** Spread into `RPC_METHODS`, so the names stay in the one table. */
export const THREAD_SEARCH_RPC_METHODS = {
  threadsSearchMessages: "threads.searchMessages",
} as const;

/**
 * Threads across every project, archived ones included, whose user or
 * assistant text contains `query` (case-insensitive), one hit per thread and
 * the most recently active first. A query under `MESSAGE_SEARCH_MIN_LENGTH`
 * characters answers an empty list; `limit` is clamped to
 * `MESSAGE_SEARCH_LIMIT`.
 */
export const ThreadsSearchMessagesRpc = Rpc.make(THREAD_SEARCH_RPC_METHODS.threadsSearchMessages, {
  payload: Schema.Struct({
    query: Schema.String,
    limit: Schema.optional(Schema.Int),
  }),
  success: Schema.Array(MessageSearchHit),
  error: PoseidonRpcError,
});
