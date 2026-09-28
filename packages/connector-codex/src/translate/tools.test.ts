/**
 * The pieces an item row is built from: which kind of row an item type is
 * drawn as, a file change's paths, and how rows open, grow, settle and fail.
 * How whole recorded turns become rows is for `recordedSession.test.ts` and
 * `translator.test.ts`; no recording has a tool item yet, so the shapes here
 * are the protocol's own, cut down to the members the rows read.
 */

import { describe, expect, it } from "vitest";

import { MAX_TOOL_OUTPUT_CHARS } from "./pending";
import { changesOf, kindOfItem, makeItemRows } from "./tools";

describe("kindOfItem", () => {
  it.each([
    ["agentMessage", "assistant_message"],
    ["reasoning", "reasoning"],
    ["plan", "plan"],
    ["commandExecution", "command_execution"],
    ["fileChange", "file_change"],
    ["mcpToolCall", "mcp_tool_call"],
    ["webSearch", "web_search"],
    ["contextCompaction", "context_compaction"],
    ["collabAgentToolCall", "task"],
    ["dynamicToolCall", "tool_call"],
    ["imageView", "tool_call"],
  ] as const)("draws %s as %s", (type, kind) => {
    expect(kindOfItem(type)).toBe(kind);
  });
});

describe("changesOf", () => {
  it("reads each change's path, kind and diff, and skips one with no path", () => {
    expect(
      changesOf([
        { path: "/w/a.txt", kind: { type: "add" }, diff: "+a" },
        { path: "/w/b.txt", kind: { type: "update", move_path: null }, diff: "" },
        { path: "/w/c.txt", kind: { type: "delete" }, diff: "-c" },
        { path: "", kind: { type: "add" }, diff: "" },
      ]),
    ).toEqual([
      { path: "/w/a.txt", kind: "create", diff: "+a" },
      { path: "/w/b.txt", kind: "edit" },
      { path: "/w/c.txt", kind: "delete", diff: "-c" },
    ]);
  });
});

describe("makeItemRows", () => {
  it("draws no row for the user's own message", () => {
    const rows = makeItemRows();
    expect(rows.started({ type: "userMessage", id: "u1" })).toEqual([]);
    expect(rows.completed({ type: "userMessage", id: "u1" })).toEqual([]);
  });

  it("gives each path of a file change a row of its own", () => {
    const rows = makeItemRows();
    const started = rows.started({
      type: "fileChange",
      id: "f1",
      status: "inProgress",
      changes: [{ path: "/w/a.txt", kind: { type: "add" }, diff: "+a" }],
    });
    const completed = rows.completed({
      type: "fileChange",
      id: "f1",
      status: "completed",
      changes: [
        { path: "/w/a.txt", kind: { type: "add" }, diff: "+a" },
        { path: "/w/b.txt", kind: { type: "update", move_path: null }, diff: "-b\n+B" },
      ],
    });
    expect(started.map((event) => event.type)).toEqual(["item.started"]);
    const items = completed.flatMap((event) =>
      event.type === "item.completed" ? [event.payload.item] : [],
    );
    expect(
      items.map((item) => [item.fileChange?.path, item.fileChange?.kind, item.status]),
    ).toEqual([
      ["/w/a.txt", "create", "completed"],
      ["/w/b.txt", "edit", "completed"],
    ]);
    expect(items[0]!.itemId).toBe(started[0]!.itemId);
  });

  it("grows a command's output as it streams, cut at the cap, and settles it with the exit", () => {
    const rows = makeItemRows();
    rows.started({
      type: "commandExecution",
      id: "c1",
      command: "ls",
      cwd: "/w",
      status: "inProgress",
    });
    const [update] = rows.commandOutput("c1", "a\n");
    expect(update?.type === "item.updated" && update.payload.item.command?.output).toBe("a\n");
    rows.commandOutput("c1", "x".repeat(MAX_TOOL_OUTPUT_CHARS + 10));
    const [done] = rows.completed({
      type: "commandExecution",
      id: "c1",
      command: "ls",
      cwd: "/w",
      status: "failed",
      exitCode: 2,
      aggregatedOutput: null,
    });
    const item = done?.type === "item.completed" ? done.payload.item : undefined;
    expect(item?.status).toBe("failed");
    expect(item?.command?.exitCode).toBe(2);
    expect(item?.command?.output?.endsWith("...[truncated]")).toBe(true);
  });

  it("opens a row for a delta whose start never came, and never settles a row twice", () => {
    const rows = makeItemRows();
    expect(rows.delta("m1", "agentMessage", "hi").map((event) => event.type)).toEqual([
      "item.started",
      "content.delta",
    ]);
    expect(rows.completed({ type: "agentMessage", id: "m1", text: "hi" })).toHaveLength(1);
    expect(rows.completed({ type: "agentMessage", id: "m1", text: "hi" })).toEqual([]);
    expect(rows.delta("m1", "agentMessage", "more")).toEqual([]);
  });

  it("fails what a turn left open, and only that", () => {
    const rows = makeItemRows();
    rows.started({ type: "agentMessage", id: "m1", text: "" });
    rows.started({ type: "reasoning", id: "r1", summary: [], content: [] });
    rows.completed({ type: "reasoning", id: "r1", summary: ["thought"], content: [] });
    const failed = rows.failOpen();
    expect(
      failed.map((event) => (event.type === "item.completed" ? event.payload.item.kind : "")),
    ).toEqual(["assistant_message"]);
    expect(
      failed.every(
        (event) => event.type === "item.completed" && event.payload.item.status === "failed",
      ),
    ).toBe(true);
    expect(rows.failOpen()).toEqual([]);
  });
});
