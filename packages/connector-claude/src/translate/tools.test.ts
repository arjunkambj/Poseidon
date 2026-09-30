/**
 * The pieces a tool row is built from: which kind of row a tool is drawn as,
 * the checklist a TodoWrite carries, the diff a file change shows, and the
 * cut on long output, and the row a proposed plan settles. How whole SDK
 * messages become rows is for the real CLI's recordings to prove, in
 * `recordedSession.test.ts`: the signed-in `edit-approval`, `deny`,
 * `plan-accept`, `question` and `subagent` each carry tool calls.
 */

import { describe, expect, it } from "vitest";

import {
  diffOf,
  kindForTool,
  makeToolRows,
  MAX_TOOL_OUTPUT_CHARS,
  textOfToolResult,
  todosOf,
  truncateToolOutput,
} from "./tools";

describe("kindForTool", () => {
  it.each([
    ["Bash", "command_execution"],
    ["Edit", "file_change"],
    ["MultiEdit", "file_change"],
    ["NotebookEdit", "file_change"],
    ["Write", "file_change"],
    ["Read", "tool_call"],
    ["Glob", "tool_call"],
    ["Grep", "tool_call"],
    ["LS", "tool_call"],
    ["WebFetch", "web_search"],
    ["WebSearch", "web_search"],
    ["mcp__poseidon__browser_open", "mcp_tool_call"],
    ["TodoWrite", "todo"],
    ["Skill", "skill"],
    ["Task", "task"],
    ["Agent", "task"],
    ["AskUserQuestion", "tool_call"],
    ["ExitPlanMode", "plan"],
    ["EnterPlanMode", "plan"],
    ["SomethingNew", "tool_call"],
  ] as const)("draws %s as %s", (tool, kind) => {
    expect(kindForTool(tool)).toBe(kind);
  });
});

describe("todosOf", () => {
  it("reads each entry's content and status, with its place in the list as its id", () => {
    expect(
      todosOf({
        todos: [
          { content: "Write the test", status: "completed", activeForm: "Writing the test" },
          { content: "Make it pass", status: "in_progress", activeForm: "Making it pass" },
          { content: "", status: "pending", activeForm: "" },
          { content: "Ship", status: "someday", activeForm: "Shipping" },
        ],
      }),
    ).toEqual([
      { todoId: "todo-0", text: "Write the test", status: "completed" },
      { todoId: "todo-1", text: "Make it pass", status: "in_progress" },
      { todoId: "todo-3", text: "Ship", status: "pending" },
    ]);
    expect(todosOf({})).toEqual([]);
  });
});

describe("diffOf", () => {
  it("writes an edit's hunks as a unified diff", () => {
    expect(
      diffOf("/r/a.ts", {
        structuredPatch: [
          { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" keep", "-old", "+new"] },
        ],
      }),
    ).toBe(["--- /r/a.ts", "+++ /r/a.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new"].join("\n"));
  });

  it("writes a created file as all additions", () => {
    expect(
      diffOf("/r/hello.txt", { type: "create", structuredPatch: [], content: "hi\nthere\n" }),
    ).toBe(["--- /dev/null", "+++ /r/hello.txt", "@@ -0,0 +1,2 @@", "+hi", "+there"].join("\n"));
  });

  it("has nothing to show without a patch or a created file", () => {
    expect(diffOf("/r/a.ts", {})).toBeUndefined();
    expect(
      diffOf("/r/a.ts", { type: "update", structuredPatch: [], content: "x" }),
    ).toBeUndefined();
  });
});

describe("tool output", () => {
  it("reads a result's text whether it is a string or blocks", () => {
    expect(textOfToolResult("plain")).toBe("plain");
    expect(
      textOfToolResult([
        { type: "text", text: "one" },
        { type: "image", source: {} },
        { type: "text", text: "two" },
      ]),
    ).toBe("one\ntwo");
    expect(textOfToolResult(undefined)).toBe("");
  });

  it("cuts output past the limit and marks the cut", () => {
    const giant = "y".repeat(MAX_TOOL_OUTPUT_CHARS + 10);
    expect(truncateToolOutput(giant)).toBe(`${"y".repeat(MAX_TOOL_OUTPUT_CHARS)}...[truncated]`);
    expect(truncateToolOutput("short")).toBe("short");
  });
});

describe("planProposed", () => {
  it("settles one plan row with the markdown, and settles it once", () => {
    const rows = makeToolRows();
    const [event] = rows.planProposed("toolu_1", "# Plan");
    expect(event).toMatchObject({
      type: "item.completed",
      payload: { item: { kind: "plan", status: "completed", text: "# Plan" } },
    });
    const [again] = rows.planProposed("toolu_1", "# Plan, revised");
    expect(again?.itemId).toBe(event?.itemId);
    // The CLI's refusal of the call, arriving after, leaves the plan row alone.
    expect(
      rows.finished({ tool_use_id: "toolu_1", is_error: true, content: "stopped" }, undefined),
    ).toEqual([]);
    expect(rows.ran()).toBe(0);
  });
});
