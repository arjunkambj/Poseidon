import type { ItemKind } from "@poseidon/contracts/enums";
import type { ItemId } from "@poseidon/contracts/ids";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { describe, expect, it } from "vitest";

import { ALL_FOLDS_OPEN, buildTimeline } from "./fold";
import {
  currentMatchIndex,
  findDocuments,
  findMatches,
  locateItem,
  normalizeQuery,
  hasMatch,
  splitHighlights,
  stepMatch,
} from "./thread-find";

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

const projections = (items: ReadonlyArray<ItemSnapshot>, turnActive = false) => ({
  open: buildTimeline(items, { turnActive, isFoldOpen: ALL_FOLDS_OPEN }),
  closed: buildTimeline(items, { turnActive }),
});

describe("findDocuments", () => {
  it("takes the text each kind's row shows and skips command output and tool payloads", () => {
    const user = item("user_message", { text: "fix the parser" });
    const reasoning = item("reasoning", { text: "look at parser.ts" });
    const command = item("command_execution", {
      command: { cmd: "pnpm test parser", output: "parser failed" },
    });
    const bare = item("command_execution", { text: "ls" });
    const tool = item("tool_call", {
      tool: { name: "Read", input: { file_path: "src/parser.ts" }, output: "parser source" },
    });
    const change = item("file_change", { fileChange: { path: "src/parser.ts", kind: "edit" } });
    const plan = item("plan", { plan: { markdown: "1. rewrite parser" } });
    const todo = item("todo", { text: "not searched" });
    const reply = item("assistant_message", { text: "Fixed the parser." });
    const { open } = projections(
      [user, reasoning, command, bare, tool, change, plan, todo, reply],
      true,
    );
    expect(findDocuments(open)).toEqual([
      { itemId: user.itemId, field: "text", text: "fix the parser" },
      { itemId: reasoning.itemId, field: "body", text: "look at parser.ts" },
      { itemId: command.itemId, field: "command", text: "pnpm test parser" },
      { itemId: bare.itemId, field: "command", text: "ls" },
      { itemId: tool.itemId, field: "name", text: "Read" },
      { itemId: tool.itemId, field: "path", text: "src/parser.ts" },
      { itemId: change.itemId, field: "path", text: "src/parser.ts" },
      { itemId: plan.itemId, field: "body", text: "1. rewrite parser" },
      { itemId: reply.itemId, field: "text", text: "Fixed the parser." },
    ]);
  });

  it("orders a work group's items and a task's children before the next row", () => {
    const user = item("user_message", { text: "go" });
    const tool = item("tool_call", { tool: { name: "Grep", input: {} } });
    const task = item("task", { text: "explore" });
    const child = item("command_execution", {
      parentItemId: task.itemId,
      command: { cmd: "rg go" },
    });
    const inner = item("task", { parentItemId: task.itemId, text: "dig" });
    const grandchild = item("reasoning", { parentItemId: inner.itemId, text: "deep" });
    const reply = item("assistant_message", { text: "done" });
    const next = item("user_message", { text: "again" });
    const { open } = projections([user, tool, task, child, inner, grandchild, reply, next]);
    expect(findDocuments(open).map((doc) => doc.itemId)).toEqual([
      user.itemId,
      tool.itemId,
      task.itemId,
      child.itemId,
      inner.itemId,
      grandchild.itemId,
      reply.itemId,
      next.itemId,
    ]);
  });
});

describe("findMatches", () => {
  const docs = [
    { itemId: "a", field: "text", text: "Parser parses; PARSER." },
    { itemId: "b", field: "path", text: "src/parser.ts" },
  ] as const;

  it("finds every non-overlapping occurrence, ignoring case, in document order", () => {
    expect(findMatches(docs, "parser")).toEqual([
      { itemId: "a", field: "text", start: 0, end: 6 },
      { itemId: "a", field: "text", start: 15, end: 21 },
      { itemId: "b", field: "path", start: 4, end: 10 },
    ]);
    expect(findMatches([{ itemId: "c", field: "text", text: "aaaa" }], "aa")).toHaveLength(2);
  });

  it("treats the query as plain text", () => {
    expect(findMatches([{ itemId: "c", field: "text", text: "a.b axb" }], "a.b")).toEqual([
      { itemId: "c", field: "text", start: 0, end: 3 },
    ]);
  });

  it("searches nothing for an empty or blank query", () => {
    expect(normalizeQuery("  ")).toBeUndefined();
    expect(normalizeQuery(" parser ")).toBe("parser");
    expect(findMatches(docs, "")).toEqual([]);
    expect(findMatches(docs, "   ")).toEqual([]);
  });
});

describe("stepMatch", () => {
  it("wraps around in both directions", () => {
    expect(stepMatch(3, -1, "next")).toBe(0);
    expect(stepMatch(3, 0, "next")).toBe(1);
    expect(stepMatch(3, 2, "next")).toBe(0);
    expect(stepMatch(3, 0, "previous")).toBe(2);
    expect(stepMatch(3, 2, "previous")).toBe(1);
    expect(stepMatch(3, -1, "previous")).toBe(2);
    expect(stepMatch(3, 7, "next")).toBe(0);
  });

  it("has nothing to step to without matches", () => {
    expect(stepMatch(0, -1, "next")).toBe(-1);
    expect(stepMatch(0, 2, "previous")).toBe(-1);
  });
});

describe("currentMatchIndex", () => {
  const match = (itemId: string, start: number) =>
    ({ itemId, field: "text", start, end: start + 3 }) as const;

  it("starts on the first match and has none without matches", () => {
    expect(currentMatchIndex([match("a", 0), match("b", 0)], undefined)).toBe(0);
    expect(currentMatchIndex([], { match: match("a", 0), index: 0 })).toBe(-1);
  });

  it("follows the selected match when matches are added before it", () => {
    const selected = { match: match("b", 4), index: 1 };
    const next = [match("a", 0), match("a", 9), match("b", 4), match("c", 0)];
    expect(currentMatchIndex(next, selected)).toBe(2);
  });

  it("clamps the old index when the selected match is gone", () => {
    expect(
      currentMatchIndex([match("a", 0), match("c", 0)], { match: match("b", 4), index: 1 }),
    ).toBe(1);
    expect(currentMatchIndex([match("a", 0)], { match: match("b", 4), index: 5 })).toBe(0);
  });
});

describe("locateItem", () => {
  it("opens the turn fold, the work group and each task above a match in a settled turn", () => {
    const user = item("user_message", { text: "go" });
    const task = item("task", { text: "explore" });
    const inner = item("task", { parentItemId: task.itemId, text: "dig" });
    const reasoning = item("reasoning", { parentItemId: inner.itemId, text: "deep" });
    const reply = item("assistant_message", { text: "done" });
    const { open, closed } = projections([user, task, inner, reasoning, reply]);
    const group = `work-group:${task.itemId}`;

    expect(locateItem(open, closed, reasoning.itemId, "body")).toEqual({
      rowId: group,
      open: [`turn-fold:${user.itemId}`, group, task.itemId, inner.itemId, reasoning.itemId],
    });
    expect(locateItem(open, closed, task.itemId, "text")).toEqual({
      rowId: group,
      open: [`turn-fold:${user.itemId}`, group],
    });
  });

  it("opens the fold over hidden narration but nothing for the answer", () => {
    const user = item("user_message", { text: "go" });
    const narration = item("assistant_message", { text: "looking" });
    const command = item("command_execution", { command: { cmd: "ls" } });
    const reply = item("assistant_message", { text: "done" });
    const next = item("user_message", { text: "more" });
    const { open, closed } = projections([user, narration, command, reply, next]);
    expect(locateItem(open, closed, narration.itemId)).toEqual({
      rowId: narration.itemId,
      open: [`turn-fold:${user.itemId}`],
    });
    expect(locateItem(open, closed, reply.itemId)).toEqual({ rowId: reply.itemId, open: [] });
  });

  it("opens nothing for a visible user message or an already open fold", () => {
    const user = item("user_message", { text: "go" });
    const command = item("command_execution", { command: { cmd: "ls" } });
    const reply = item("assistant_message", { text: "done" });
    const { open, closed } = projections([user, command, reply]);
    expect(locateItem(open, closed, user.itemId)).toEqual({ rowId: user.itemId, open: [] });
    expect(locateItem(open, open, command.itemId, "command")).toEqual({
      rowId: `work-group:${command.itemId}`,
      open: [`work-group:${command.itemId}`],
    });
  });

  it("finds nothing for an unknown item", () => {
    const { open, closed } = projections([item("user_message")]);
    expect(locateItem(open, closed, "missing")).toBeUndefined();
  });
});

describe("splitHighlights", () => {
  it("cuts text into marked and unmarked runs", () => {
    expect(splitHighlights("Parse the parser", "PARSE")).toEqual([
      { text: "Parse", match: true },
      { text: " the ", match: false },
      { text: "parse", match: true },
      { text: "r", match: false },
    ]);
  });

  it("keeps text whole without a query and yields nothing for empty text", () => {
    expect(splitHighlights("plain", " ")).toEqual([{ text: "plain", match: false }]);
    expect(splitHighlights("", "x")).toEqual([]);
  });
});

describe("hasMatch", () => {
  it("finds the query ignoring case, and nothing without one", () => {
    expect(hasMatch("Deploy the service", "SERVICE")).toBe(true);
    expect(hasMatch("Deploy the service", "a.b")).toBe(false);
    expect(hasMatch("Deploy", "  ")).toBe(false);
  });
});
