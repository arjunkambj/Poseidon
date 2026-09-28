import type { ItemKind } from "@poseidon/contracts/enums";
import type { ItemId } from "@poseidon/contracts/ids";
import type { ResolvedDecision } from "@poseidon/contracts/decisions";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { describe, expect, it } from "vitest";

import { disclosureIds } from "./disclosure";
import { ALL_FOLDS_OPEN, buildTimeline } from "./fold";

let sequence = 0;
let millis = 1_700_000_000_000;

const item = (kind: ItemKind, over: Partial<ItemSnapshot> = {}): ItemSnapshot => {
  sequence += 1;
  millis += 1_000;
  const hex = millis.toString(16).padStart(12, "0");
  const suffix = sequence.toString(16).padStart(12, "0");
  const itemId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${suffix}` as ItemId;
  return { itemId, kind, status: "completed", ...over };
};

const decision: ResolvedDecision = {
  kind: "approval",
  id: "req-1",
  outcome: "allow-once",
  resolvedAt: "2026-01-01T00:00:00.000Z",
};

describe("disclosureIds", () => {
  it("lists a live turn's bursts, the rows inside them and plans, and skips messages", () => {
    const user = item("user_message");
    const reasoning = item("reasoning");
    const command = item("command_execution");
    const change = item("file_change", { fileChange: { path: "a.ts", kind: "edit", diff: "" } });
    const mcp = item("mcp_tool_call");
    const search = item("web_search");
    const plan = item("plan", { text: "1. do it" });
    const todo = item("todo");
    const skill = item("skill");
    const reply = item("assistant_message");
    const projection = buildTimeline(
      [user, reasoning, command, change, mcp, search, plan, todo, skill, reply],
      { turnActive: true },
    );
    // the running work folds into bursts keyed by their first step; a skill has no disclosure
    expect(disclosureIds(projection)).toEqual([
      `work-group:${reasoning.itemId}`,
      reasoning.itemId,
      command.itemId,
      change.itemId,
      mcp.itemId,
      search.itemId,
      plan.itemId,
      `work-group:${skill.itemId}`,
    ]);
  });

  it("lists a settled turn's fold, the work groups inside it, their rows and the card", () => {
    const user = item("user_message");
    const tool = item("tool_call");
    const command = item("command_execution");
    const narration = item("assistant_message");
    const change = item("file_change", { fileChange: { path: "a.ts", kind: "edit", diff: "+a" } });
    const reply = item("assistant_message");
    const items = [user, tool, command, narration, change, reply];

    // closed, the fold hides its groups from the projection on screen…
    const closed = buildTimeline(items, { turnActive: false });
    expect(closed.rows.some((row) => row.kind === "work-group")).toBe(false);

    // …so expand-all walks the projection with every fold open
    const projection = buildTimeline(items, { turnActive: false, isFoldOpen: ALL_FOLDS_OPEN });
    const groups = projection.rows.filter((row) => row.kind === "work-group");
    expect(disclosureIds(projection)).toEqual([
      `turn-fold:${user.itemId}`,
      groups[0]?.id,
      tool.itemId,
      command.itemId,
      groups[1]?.id,
      change.itemId,
      `turn-summary:${user.itemId}`,
    ]);
  });

  it("lists the folds of every settled turn", () => {
    const first = item("user_message");
    const second = item("user_message");
    const projection = buildTimeline(
      [first, item("reasoning"), item("assistant_message"), second, item("tool_call")],
      { turnActive: false, isFoldOpen: ALL_FOLDS_OPEN },
    );
    const ids = disclosureIds(projection);
    expect(ids).toContain(`turn-fold:${first.itemId}`);
    expect(ids).toContain(`turn-fold:${second.itemId}`);
    expect(ids.filter((id) => id.startsWith("work-group:"))).toHaveLength(2);
  });

  it("walks into a task's children at any depth", () => {
    const user = item("user_message");
    const task = item("task");
    const child = item("tool_call", { parentItemId: task.itemId });
    const inner = item("task", { parentItemId: task.itemId });
    const grandchild = item("command_execution", { parentItemId: inner.itemId });
    const note = item("assistant_message", { parentItemId: task.itemId });
    const projection = buildTimeline([user, task, child, inner, grandchild, note], {
      turnActive: true,
    });
    expect(disclosureIds(projection)).toEqual([
      `work-group:${task.itemId}`,
      task.itemId,
      child.itemId,
      inner.itemId,
      grandchild.itemId,
    ]);
  });

  it("lists answered decisions by their row id", () => {
    const user = item("user_message");
    const projection = buildTimeline([user], {
      turnActive: false,
      decisions: [decision, decision],
    });
    expect(disclosureIds(projection)).toEqual(["decision:req-1", "decision:req-1:2"]);
  });

  it("lists nothing for a plain exchange", () => {
    const projection = buildTimeline([item("user_message"), item("assistant_message")], {
      turnActive: false,
    });
    expect(disclosureIds(projection)).toEqual([]);
  });
});
