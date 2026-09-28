/**
 * The text and thinking rows of a session: opened by the stream, settled by
 * the snapshot.
 *
 * With `includePartialMessages` the SDK reports one model message twice. First
 * as `stream_event`s — `message_start` naming the message id, then per content
 * block a `content_block_start`, its `*_delta`s and a stop — and then as
 * `assistant` snapshots carrying the finished blocks under the same message id.
 * A snapshot does not say which streamed block it finishes, but both halves
 * keep the model's block order, so the n-th text block of a snapshot is the
 * n-th text block the stream opened for that message, and the same for
 * thinking. That is how a row the deltas grew is completed instead of being
 * written a second time.
 *
 * A snapshot with no streamed block to match — partial messages off, or a
 * block the stream never showed — opens and completes a row of its own, or
 * none when the block is empty.
 *
 * A snapshot's block may come back empty where the stream opened a row for
 * it: a thinking block whose text the API left out carries only its
 * signature. The row is completed all the same, with the text its deltas
 * grew, or none. And a turn's `result` completes every row still open
 * (`closeOpen`), so no text or reasoning row outlives its turn.
 */

import type { ItemId } from "@poseidon/contracts/ids";
import { makeItemId } from "@poseidon/contracts/ids";

import type { PendingRuntimeEvent } from "./pending";

export type TextRowKind = "assistant_message" | "reasoning";

interface Row {
  readonly itemId: ItemId;
  readonly kind: TextRowKind;
  done: boolean;
  /** What the deltas grew, for a row completed without a snapshot's text. */
  text: string;
}

export interface TextRows {
  /** A `content_block_start` for a text or thinking block. */
  readonly open: (
    messageId: string,
    index: number,
    kind: TextRowKind,
  ) => ReadonlyArray<PendingRuntimeEvent>;
  /** A `text_delta` or `thinking_delta`; nothing for a block that never opened. */
  readonly delta: (
    messageId: string,
    index: number,
    text: string,
  ) => ReadonlyArray<PendingRuntimeEvent>;
  /** A finished block from an `assistant` snapshot, its text possibly empty. */
  readonly settle: (
    messageId: string,
    kind: TextRowKind,
    text: string,
  ) => ReadonlyArray<PendingRuntimeEvent>;
  /** Every row still open, completed: the turn ended. */
  readonly closeOpen: () => ReadonlyArray<PendingRuntimeEvent>;
}

const completed = (row: { readonly itemId: ItemId; readonly kind: TextRowKind }, text: string) => ({
  itemId: row.itemId,
  type: "item.completed" as const,
  payload: {
    item: {
      itemId: row.itemId,
      kind: row.kind,
      status: "completed" as const,
      ...(text === "" ? {} : { text }),
    },
  },
});

export const makeTextRows = (): TextRows => {
  const byBlock = new Map<string, Row>();
  /** Each message's streamed rows, in block order. */
  const byMessage = new Map<string, Array<Row>>();

  return {
    open: (messageId, index, kind) => {
      const key = `${messageId}:${index}`;
      if (byBlock.has(key)) return [];
      const row: Row = { itemId: makeItemId(), kind, done: false, text: "" };
      byBlock.set(key, row);
      byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), row]);
      return [
        {
          itemId: row.itemId,
          type: "item.started",
          payload: { item: { itemId: row.itemId, kind, status: "in_progress" } },
        },
      ];
    },
    delta: (messageId, index, text) => {
      const row = byBlock.get(`${messageId}:${index}`);
      if (row === undefined || row.done || text === "") return [];
      row.text += text;
      return [
        {
          itemId: row.itemId,
          type: "content.delta",
          payload: {
            itemId: row.itemId,
            kind: row.kind === "reasoning" ? "reasoning" : "text",
            delta: text,
          },
        },
      ];
    },
    settle: (messageId, kind, text) => {
      const row = (byMessage.get(messageId) ?? []).find((each) => !each.done && each.kind === kind);
      if (row === undefined) {
        return text === "" ? [] : [completed({ itemId: makeItemId(), kind }, text)];
      }
      row.done = true;
      return [completed(row, text === "" ? row.text : text)];
    },
    closeOpen: () =>
      [...byMessage.values()].flat().flatMap((row) => {
        if (row.done) return [];
        row.done = true;
        return [completed(row, row.text)];
      }),
  };
};
