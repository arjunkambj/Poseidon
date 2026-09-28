/**
 * The text and thinking rows' own bookkeeping: a snapshot settles the row its
 * stream opened even when the block came back empty, and the end of a turn
 * completes every row still open, once.
 */

import { describe, expect, it } from "vitest";

import type { PendingRuntimeEvent } from "./pending";
import { makeTextRows } from "./textRows";

const MESSAGE = "msg_01";

const startedId = (events: ReadonlyArray<PendingRuntimeEvent>) => {
  const started = events[0];
  if (started?.type !== "item.started") throw new Error("no row opened");
  return started.payload.item.itemId;
};

const completedItems = (events: ReadonlyArray<PendingRuntimeEvent>) =>
  events.flatMap((event) => (event.type === "item.completed" ? [event.payload.item] : []));

describe("the text and thinking rows", () => {
  it("completes a streamed thinking row whose snapshot carries no thinking", () => {
    const rows = makeTextRows();
    const itemId = startedId(rows.open(MESSAGE, 0, "reasoning"));
    const settled = completedItems(rows.settle(MESSAGE, "reasoning", ""));
    expect(settled).toEqual([{ itemId, kind: "reasoning", status: "completed" }]);
    expect(rows.closeOpen()).toEqual([]);
  });

  it("keeps what the deltas grew when the snapshot's block is empty", () => {
    const rows = makeTextRows();
    const itemId = startedId(rows.open(MESSAGE, 0, "reasoning"));
    rows.delta(MESSAGE, 0, "Weighing ");
    rows.delta(MESSAGE, 0, "the options");
    expect(completedItems(rows.settle(MESSAGE, "reasoning", ""))).toEqual([
      { itemId, kind: "reasoning", status: "completed", text: "Weighing the options" },
    ]);
  });

  it("opens no row for an empty block the stream never showed", () => {
    const rows = makeTextRows();
    expect(rows.settle(MESSAGE, "reasoning", "")).toEqual([]);
    expect(completedItems(rows.settle(MESSAGE, "assistant_message", "Done."))).toMatchObject([
      { kind: "assistant_message", status: "completed", text: "Done." },
    ]);
  });

  it("completes only the rows still open at the end of the turn, once", () => {
    const rows = makeTextRows();
    const thinking = startedId(rows.open(MESSAGE, 0, "reasoning"));
    const answer = startedId(rows.open(MESSAGE, 1, "assistant_message"));
    const later = startedId(rows.open("msg_02", 0, "assistant_message"));
    rows.delta(MESSAGE, 1, "Half an answer");
    rows.settle(MESSAGE, "reasoning", "Thought it through");

    const closed = completedItems(rows.closeOpen());
    expect(closed).toEqual([
      { itemId: answer, kind: "assistant_message", status: "completed", text: "Half an answer" },
      { itemId: later, kind: "assistant_message", status: "completed" },
    ]);
    expect(closed.map((item) => item.itemId)).not.toContain(thinking);
    expect(rows.closeOpen()).toEqual([]);
    // A delta for a closed row adds nothing.
    expect(rows.delta(MESSAGE, 1, "more")).toEqual([]);
  });
});
