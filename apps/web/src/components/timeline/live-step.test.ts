import type { ItemKind } from "@poseidon/contracts/enums";
import type { ItemId } from "@poseidon/contracts/ids";
import type { FileChangeKind, ItemSnapshot } from "@poseidon/contracts/runtime";
import { describe, expect, it } from "vitest";

import { liveStepCount, liveStepLabel } from "./live-step";

let sequence = 0;

/** A deterministic UUIDv7 whose leading 48 bits are `millis`. */
const itemIdAt = (millis: number): ItemId => {
  sequence += 1;
  const hex = millis.toString(16).padStart(12, "0");
  const suffix = sequence.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${suffix}` as ItemId;
};

const BASE = 1_700_000_000_000;

const item = (kind: ItemKind, over: Partial<ItemSnapshot> = {}, at = BASE): ItemSnapshot => ({
  itemId: itemIdAt(at),
  kind,
  status: "completed",
  ...over,
});

const running = { status: "in_progress" } as const;

const command = (cmd: string, over: Partial<ItemSnapshot> = {}, at = BASE) =>
  item("command_execution", { command: { cmd }, ...over }, at);

const file = (path: string, kind: FileChangeKind, over: Partial<ItemSnapshot> = {}) =>
  item("file_change", { fileChange: { path, kind }, ...over });

const call = (
  name: string,
  input: Record<string, unknown>,
  over: Partial<ItemSnapshot> = {},
  kind: ItemKind = "tool_call",
) => item(kind, { tool: { name, input }, ...over });

/** The label of a burst holding `step` alone. */
const one = (step: ItemSnapshot) => liveStepLabel([step]);

describe("liveStepLabel", () => {
  it("names a command by its first line, present while running and past once done", () => {
    expect(one(command("pnpm test", running))).toBe("Running pnpm test");
    expect(one(command("pnpm test"))).toBe("Ran pnpm test");
    expect(one(command("git status\ngit diff", running))).toBe("Running git status");
    expect(one(call("Bash", { command: "ls -la" }, running))).toBe("Running ls -la");
  });

  it("cuts a long command to one short line", () => {
    const long = `echo ${"x".repeat(80)}`;
    expect(one(command(long))).toBe(`Ran ${long.slice(0, 60)}…`);
  });

  it("names a file change by the file's name", () => {
    expect(one(file("apps/web/src/app.tsx", "edit", running))).toBe("Editing app.tsx");
    expect(one(file("apps/web/src/app.tsx", "edit"))).toBe("Edited app.tsx");
    expect(one(file("src/new.ts", "create", running))).toBe("Creating new.ts");
    expect(one(file("src/new.ts", "create"))).toBe("Created new.ts");
    expect(one(file("src/old.ts", "delete"))).toBe("Deleted old.ts");
    expect(one(call("Edit", { file_path: "/repo/src/a.ts" }, running))).toBe("Editing a.ts");
  });

  it("names reads, searches and listings by their target", () => {
    expect(one(call("Read", { file_path: "/repo/README.md" }, running))).toBe("Reading README.md");
    expect(one(call("Read", { file_path: "/repo/README.md" }))).toBe("Read README.md");
    expect(one(call("Grep", { pattern: "useMemo", path: "src" }, running))).toBe(
      "Searching useMemo",
    );
    expect(one(call("Grep", { pattern: "useMemo" }))).toBe("Searched useMemo");
    expect(one(call("list_dir", { path: "src/components" }, running))).toBe(
      "Listing src/components",
    );
    expect(one(call("list_dir", { path: "src" }))).toBe("Listed src");
  });

  it("names web searches and fetches", () => {
    const search = (over: Partial<ItemSnapshot>) =>
      item("web_search", {
        tool: { name: "WebSearch", input: { query: "effect schema" } },
        ...over,
      });
    expect(one(search(running))).toBe("Searching the web for effect schema");
    expect(one(search({}))).toBe("Searched the web for effect schema");
    const fetch = item("web_search", {
      tool: { name: "WebFetch", input: { url: "https://example.com" } },
    });
    expect(one(fetch)).toBe("Fetched https://example.com");
  });

  it("reads a browser call as what it did to the page", () => {
    const open = call(
      "mcp__poseidon__browser_open",
      { url: "http://localhost:3000" },
      running,
      "mcp_tool_call",
    );
    expect(one(open)).toBe("Opened http://localhost:3000");
  });

  it("names other tools by their name", () => {
    expect(one(call("lookup", {}, running, "mcp_tool_call"))).toBe("Calling lookup");
    expect(one(call("lookup", {}, {}, "mcp_tool_call"))).toBe("Called lookup");
    expect(one(call("frobnicate", {}, running))).toBe("Using frobnicate");
    expect(one(call("frobnicate", {}))).toBe("Used frobnicate");
  });

  it("names a task by its title and a skill by its name", () => {
    expect(one(item("task", { text: "Audit the tests", ...running }))).toBe("Audit the tests");
    expect(one(item("task"))).toBe("Subagent task");
    expect(one(item("skill", { text: "frontend-design" }))).toBe("frontend-design");
  });

  it("thinks while reasoning streams, then times it up to when it was seen to end", () => {
    const thinking = item("reasoning", running, BASE);
    expect(liveStepLabel([thinking])).toBe("Thinking…");
    expect(liveStepLabel([thinking], BASE + 4_000)).toBe("Thinking…");
    const thought = item("reasoning", {}, BASE);
    expect(liveStepLabel([thought], BASE + 4_000)).toBe("Thought for 4s");
    expect(liveStepLabel([command("ls", {}, BASE - 1_000), thought], BASE + 4_000)).toBe(
      "Thought for 4s",
    );
    expect(liveStepLabel([thought])).toBe("Thought");
    expect(liveStepLabel([thought], BASE)).toBe("Thought");
  });

  it("reads the newest step of the burst", () => {
    const items = [
      item("reasoning", {}, BASE),
      command("pnpm test", {}, BASE + 1_000),
      file("src/app.tsx", "edit", { ...running }),
    ];
    expect(liveStepLabel(items)).toBe("Editing app.tsx");
    expect(liveStepCount(items)).toBe(3);
  });

  it("puts a failed step in the past tense", () => {
    expect(one(command("pnpm test", { status: "failed" }))).toBe("Ran pnpm test");
  });
});
