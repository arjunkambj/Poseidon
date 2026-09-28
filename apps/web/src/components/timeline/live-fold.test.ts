import type { ItemKind } from "@poseidon/contracts/enums";
import { type ItemId, makeTurnId } from "@poseidon/contracts/ids";
import type { ResolvedDecision } from "@poseidon/contracts/decisions";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { describe, expect, it } from "vitest";

import { buildTimeline, type TimelineRow, type TimelineWorkGroupRow } from "./fold";

let sequence = 0;

/** A deterministic UUIDv7 with a controllable millisecond prefix. */
const itemIdAt = (millis: number): ItemId => {
  sequence += 1;
  const hex = millis.toString(16).padStart(12, "0");
  const suffix = sequence.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${suffix}` as ItemId;
};

let millis = 1_700_000_000_000;

const item = (kind: ItemKind, over: Partial<ItemSnapshot> = {}): ItemSnapshot => {
  millis += 1_000;
  return { itemId: itemIdAt(millis), kind, status: "completed", ...over };
};

const groups = (rows: ReadonlyArray<TimelineRow>) =>
  rows.filter((row): row is TimelineWorkGroupRow => row.kind === "work-group");

/** Row kinds, item rows by their item kind and decisions by their id. */
const labels = (rows: ReadonlyArray<TimelineRow>) =>
  rows.map((row) =>
    row.kind === "item"
      ? row.item.kind
      : row.kind === "decision"
        ? `decision:${row.decision.id}`
        : row.kind,
  );

const live = (items: ReadonlyArray<ItemSnapshot>, over: object = {}) =>
  buildTimeline(items, { turnActive: true, ...over }).rows;

describe("buildTimeline live bursts", () => {
  it("folds consecutive work in the running turn into one live burst", () => {
    const user = item("user_message");
    const reasoning = item("reasoning");
    const tool = item("tool_call");
    const command = item("command_execution");
    const change = item("file_change", { fileChange: { path: "a.ts", kind: "edit" } });
    const rows = live([user, reasoning, tool, command, change]);
    expect(labels(rows)).toEqual(["user_message", "work-group", "working"]);
    const [burst] = groups(rows);
    expect(burst.id).toBe(`work-group:${reasoning.itemId}`);
    expect(burst.live).toBe(true);
    expect(burst.items).toEqual([reasoning, tool, command, change]);
  });

  it("keeps the burst's row id and the row count as steps stream in", () => {
    const user = item("user_message");
    const first = item("reasoning");
    const steps = [item("tool_call"), item("command_execution"), item("tool_call")];
    const ids = live([user, first]).map((row) => row.id);
    expect(ids).toEqual([user.itemId, `work-group:${first.itemId}`, "working"]);
    for (let n = 1; n <= steps.length; n += 1) {
      const rows = live([user, first, ...steps.slice(0, n)]);
      expect(rows.map((row) => row.id)).toEqual(ids);
      expect(groups(rows)[0].items).toHaveLength(n + 1);
    }
  });

  it("folds a single step into a group, never a plain item row", () => {
    const user = item("user_message");
    const tool = item("tool_call");
    const rows = live([user, tool]);
    expect(rows.map((row) => row.id)).toEqual([
      user.itemId,
      `work-group:${tool.itemId}`,
      "working",
    ]);
    expect(groups(rows)[0].live).toBe(true);
  });

  it("splits bursts at narration and marks only the trailing one live", () => {
    const user = item("user_message");
    const read = item("tool_call");
    const narration = item("assistant_message", { text: "Now the tests." });
    const test = item("command_execution");
    const rows = live([user, read, narration, test]);
    expect(labels(rows)).toEqual([
      "user_message",
      "work-group",
      "assistant_message",
      "work-group",
      "working",
    ]);
    expect(groups(rows).map((group) => [group.id, group.live])).toEqual([
      [`work-group:${read.itemId}`, false],
      [`work-group:${test.itemId}`, true],
    ]);
    // narration after the last burst: no burst is running
    const streaming = item("assistant_message", { text: "Done." });
    expect(groups(live([user, read, narration, test, streaming])).map((g) => g.live)).toEqual([
      false,
      false,
    ]);
  });

  it("splits a burst at a decision anchored inside it", () => {
    const decision: ResolvedDecision = {
      kind: "approval",
      id: "req-1",
      outcome: "allow-once",
      resolvedAt: "2026-01-01T00:00:00.000Z",
    };
    const user = item("user_message");
    const asked = item("command_execution");
    const after = item("command_execution");
    const rows = live([user, item("reasoning"), asked, after], {
      decisions: [{ ...decision, afterItemId: asked.itemId }],
    });
    expect(labels(rows)).toEqual([
      "user_message",
      "work-group",
      "decision:req-1",
      "work-group",
      "working",
    ]);
    expect(groups(rows).map((group) => [group.items.length, group.live])).toEqual([
      [2, false],
      [1, true],
    ]);
    // a decision after the last step leaves no burst running
    const last = live([user, asked], { decisions: [{ ...decision, afterItemId: asked.itemId }] });
    expect(labels(last)).toEqual(["user_message", "work-group", "decision:req-1", "working"]);
    expect(groups(last)[0].live).toBe(false);
  });

  it("keeps task children nested: a burst holds roots only", () => {
    const user = item("user_message");
    const task = item("task");
    const child = item("tool_call", { parentItemId: task.itemId });
    const tool = item("tool_call");
    const { rows, childrenByParent } = buildTimeline([user, task, child, tool], {
      turnActive: true,
    });
    expect(groups(rows)[0].items).toEqual([task, tool]);
    expect(childrenByParent.get(task.itemId)).toEqual([child]);
  });

  it("folds the leading work of a running thread without a user message", () => {
    const rows = live([item("reasoning"), item("tool_call")]);
    expect(labels(rows)).toEqual(["work-group", "working"]);
    expect(groups(rows)[0].live).toBe(true);
  });

  it("settles into the turn fold, the answer with its end and the card", () => {
    const turnId = makeTurnId();
    const user = item("user_message", { turnId });
    const work = [
      item("reasoning", { turnId }),
      item("file_change", { turnId, fileChange: { path: "a.ts", kind: "edit", diff: "+a" } }),
    ];
    const answer = item("assistant_message", { turnId, text: "Done." });
    const items = [user, ...work, answer];
    expect(labels(live(items))).toEqual([
      "user_message",
      "work-group",
      "assistant_message",
      "working",
    ]);
    const settled = buildTimeline(items, { turnActive: false }).rows;
    expect(labels(settled)).toEqual([
      "user_message",
      "turn-fold",
      "assistant_message",
      "turn-summary",
    ]);
    const answerRow = settled.find((row) => row.id === answer.itemId);
    expect(answerRow?.kind === "item" && answerRow.turnEnd?.turnId).toBe(turnId);
    // opened, the settled group has the burst's id, so its disclosure carries over
    const opened = buildTimeline(items, { turnActive: false, isFoldOpen: () => true }).rows;
    expect(groups(opened).map((group) => [group.id, group.live])).toEqual([
      [`work-group:${work[0].itemId}`, false],
    ]);
  });
});
