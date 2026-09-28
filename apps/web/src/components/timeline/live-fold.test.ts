import type { ItemKind } from "@poseidon/contracts/enums";
import { type ItemId, makeTurnId } from "@poseidon/contracts/ids";
import type { ResolvedDecision } from "@poseidon/contracts/decisions";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { describe, expect, it } from "vitest";

import { buildTimeline, type TimelineRow, type TimelineWorkGroupRow } from "./fold";
import { workGroupLabel } from "./work-summary";

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

  it("times a thought up to the row that closed its burst", () => {
    const user = item("user_message");
    const thought = item("reasoning");
    millis += 3_000;
    const narration = item("assistant_message", { text: "Next, the tests." });
    const test = item("command_execution", { status: "in_progress" });
    const [closed, running] = groups(live([user, thought, narration, test]));
    expect(closed.durationMs).toBe(4_000);
    expect(workGroupLabel(closed.items, closed.durationMs)).toBe("Thought for 4s");
    expect(running.live).toBe(true);
  });

  it("times an opened settled fold's last burst up to the turn's end", () => {
    const turnId = makeTurnId();
    const user = item("user_message", { turnId });
    const thought = item("reasoning", { turnId });
    const rows = buildTimeline([user, thought], {
      turnActive: false,
      isFoldOpen: () => true,
      turnEndedAt: new Map([[turnId, millis + 2_000]]),
    }).rows;
    const [burst] = groups(rows);
    expect(workGroupLabel(burst.items, burst.durationMs)).toBe("Thought for 2s");
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
  });

  it("keeps a burst live when only the answer to its approval follows it", () => {
    const approval: ResolvedDecision = {
      kind: "approval",
      id: "req-1",
      outcome: "allow-once",
      resolvedAt: "2026-01-01T00:00:00.000Z",
    };
    const question: ResolvedDecision = {
      kind: "question",
      id: "req-2",
      outcome: "answered",
      resolvedAt: "2026-01-01T00:00:01.000Z",
    };
    const user = item("user_message");
    const read = item("tool_call");
    const asked = item("command_execution", { status: "in_progress" });
    const answers = [
      { ...approval, afterItemId: asked.itemId },
      { ...question, afterItemId: asked.itemId },
    ];
    const rows = live([user, read, asked], { decisions: answers });
    expect(labels(rows)).toEqual([
      "user_message",
      "work-group",
      "decision:req-1",
      "decision:req-2",
      "working",
    ]);
    const [burst] = groups(rows);
    expect(burst.live).toBe(true);
    expect(burst.items).toEqual([read, asked]);
    // the next step opens a burst of its own, and the approved one settles
    const next = item("command_execution", { status: "in_progress" });
    const after = groups(live([user, read, asked, next], { decisions: answers }));
    expect(after.map((group) => [group.items.length, group.live])).toEqual([
      [2, false],
      [1, true],
    ]);
    // once the turn settles nothing is live
    const settled = buildTimeline([user, read, asked], {
      turnActive: false,
      decisions: answers,
      isFoldOpen: () => true,
    }).rows;
    expect(groups(settled).map((group) => group.live)).toEqual([false]);
  });

  it("keeps no burst live when narration follows the answered one", () => {
    const user = item("user_message");
    const asked = item("command_execution");
    const decision: ResolvedDecision = {
      kind: "approval",
      id: "req-1",
      outcome: "deny",
      resolvedAt: "2026-01-01T00:00:00.000Z",
      afterItemId: asked.itemId,
    };
    const rows = live([user, asked, item("assistant_message", { text: "Skipping it." })], {
      decisions: [decision],
    });
    expect(groups(rows).map((group) => group.live)).toEqual([false]);
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
