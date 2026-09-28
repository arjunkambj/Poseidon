/**
 * Claude Code's tools in Poseidon's approval vocabulary: the kind the ladder
 * reads, the pattern "allow always" proposes, the MCP reference, and the
 * input the ladder is given. The table is the connector's promise; the
 * patterns are checked against the shared pattern parser so a suggestion is
 * always one the settings page can save.
 */

import { parsePattern } from "@poseidon/shared/permissionPattern";
import { describe, expect, it } from "vitest";

import {
  approvalKindFor,
  approvalRequestFor,
  descriptionFor,
  ladderInputFor,
  mcpToolFor,
  NO_PERMISSION_TOOLS,
  patternSuggestionFor,
} from "./approvals";

const TABLE = [
  ["Bash", { command: "npm run test -- --watch" }, "command", "Shell(npm *)"],
  ["Bash", { command: "   " }, "command", "Shell(*)"],
  ["Edit", { file_path: "/repo/src/a.ts" }, "file_write", "Edit(/repo/src/a.ts)"],
  ["MultiEdit", { file_path: "/repo/src/a.ts" }, "file_write", "Edit(/repo/src/a.ts)"],
  ["Write", { file_path: "/repo/hello.txt" }, "file_write", "Edit(/repo/hello.txt)"],
  ["Write", {}, "file_write", "Edit(*)"],
  ["NotebookEdit", { notebook_path: "/repo/n.ipynb" }, "file_write", "Edit(/repo/n.ipynb)"],
  ["Read", { file_path: "/repo/.env" }, "file_read", "Read(/repo/.env)"],
  ["Glob", { pattern: "**/*.ts", path: "/repo/src" }, "file_read", "Read(/repo/src)"],
  ["Grep", { pattern: "TODO" }, "file_read", "Grep"],
  ["LS", { path: "/repo" }, "file_read", "Read(/repo)"],
  ["WebFetch", { url: "https://x.dev/a", prompt: "sum" }, "web", "Fetch(https://x.dev/a)"],
  ["WebSearch", { query: "effect v4" }, "web", "Fetch(effect v4)"],
  ["mcp__poseidon__browser_open", { url: "file:///x" }, "mcp_tool", "Mcp(poseidon.browser_open)"],
  ["mcp__gh__issues__list", {}, "mcp_tool", "Mcp(gh.issues__list)"],
  ["TodoWrite", { todos: [] }, "other", "TodoWrite"],
  ["Task", { description: "look around" }, "other", "Task"],
  ["Skill", { skill: "pdf" }, "other", "Skill"],
] as const;

describe("the approval mapping", () => {
  it.each(TABLE)("%s %j is %s, allowed always as %s", (tool, input, kind, pattern) => {
    expect(approvalKindFor(tool)).toBe(kind);
    expect(patternSuggestionFor(tool, input)).toBe(pattern);
    expect(parsePattern(pattern)).not.toBeNull();
  });

  it("names an MCP call's server and tool, splitting at the first separator", () => {
    expect(mcpToolFor("mcp__poseidon__browser_open")).toEqual({
      server: "poseidon",
      tool: "browser_open",
    });
    expect(mcpToolFor("mcp__gh__issues__list")).toEqual({ server: "gh", tool: "issues__list" });
    expect(mcpToolFor("Bash")).toBeUndefined();
    expect(mcpToolFor("mcp__nameonly")).toBeUndefined();
  });

  it("puts NotebookEdit's path where the ladder reads a file path", () => {
    expect(ladderInputFor("NotebookEdit", { notebook_path: "/r/.ssh/n.ipynb" })).toEqual({
      notebook_path: "/r/.ssh/n.ipynb",
      file_path: "/r/.ssh/n.ipynb",
    });
    const edit = { file_path: "/r/a.ts", old_string: "a", new_string: "b" };
    expect(ladderInputFor("Edit", edit)).toBe(edit);
  });

  it("builds the whole request, with the MCP reference only for MCP calls", () => {
    const mcp = approvalRequestFor("mcp__poseidon__browser_open", { url: "file:///etc" });
    expect(mcp).toMatchObject({
      kind: "mcp_tool",
      toolName: "mcp__poseidon__browser_open",
      input: { url: "file:///etc" },
      patternSuggestion: "Mcp(poseidon.browser_open)",
      mcpTool: { server: "poseidon", tool: "browser_open" },
      description: "Call browser_open on the poseidon MCP server",
    });
    const shell = approvalRequestFor("Bash", { command: "cat .env" });
    expect(shell.mcpTool).toBeUndefined();
    expect(shell.requestId).not.toBe(approvalRequestFor("Bash", { command: "ls" }).requestId);
    expect(approvalRequestFor("", {}).toolName).toBe("unknown");
  });

  it.each([
    ["Bash", { command: "cat .env" }, "Run cat .env"],
    ["Edit", { file_path: "/r/a.ts" }, "Edit /r/a.ts"],
    ["Write", { file_path: "/r/hello.txt" }, "Write /r/hello.txt"],
    ["Read", {}, "Read a file"],
    ["Grep", { pattern: "TODO", path: "/r" }, "Search for TODO in /r"],
    ["Glob", { pattern: "*.ts" }, "Find files matching *.ts"],
    ["WebSearch", { query: "effect" }, "Search the web for effect"],
    ["WebFetch", { url: "https://x.dev" }, "Fetch https://x.dev"],
    ["Skill", { skill: "pdf" }, "Use Skill"],
  ] as const)("describes %s %j as %j", (tool, input, line) => {
    expect(descriptionFor(tool, input)).toBe(line);
  });

  it("names only the CLI's no-permission tools as passing the hook", () => {
    for (const tool of ["Agent", "Task", "TodoWrite", "ToolSearch", "EnterPlanMode", "TaskStop"]) {
      expect(NO_PERMISSION_TOOLS.has(tool)).toBe(true);
    }
    // Skill asks before running a skill no rule allows; the rest run commands
    // or change the working directory.
    for (const tool of [
      "Skill",
      "Bash",
      "Edit",
      "Monitor",
      "EnterWorktree",
      "ExitWorktree",
      "CronCreate",
      "RemoteTrigger",
      "AskUserQuestion",
      "ExitPlanMode",
    ]) {
      expect(NO_PERMISSION_TOOLS.has(tool)).toBe(false);
    }
  });

  it("keeps a long command to one short line", () => {
    const line = descriptionFor("Bash", { command: `echo ${"x".repeat(500)}\nls` });
    expect(line.length).toBeLessThanOrEqual(204);
    expect(line).not.toContain("\n");
  });
});
