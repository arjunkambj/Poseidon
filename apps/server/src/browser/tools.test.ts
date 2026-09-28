import { describe, expect, it } from "vitest";

import { findBrowserTool, type PrepareResult } from "./tools";

const prepare = (name: string, args: Record<string, unknown>): PrepareResult => {
  const tool = findBrowserTool(name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.prepare(args);
};

const argvOf = (name: string, args: Record<string, unknown>): ReadonlyArray<string> | string => {
  const prepared = prepare(name, args);
  return prepared.ok ? prepared.call.argv : prepared.error;
};

describe("agent-supplied values never reach agent-browser as flags", () => {
  // agent-browser 0.38.1 reads these anywhere in argv, even after `--`.
  const flags = ["--auto-connect", "--session", "--cdp=ws://x", "-p", "--"];

  const cases: ReadonlyArray<readonly [string, (value: string) => Record<string, unknown>]> = [
    ["browser_click", (value) => ({ selector: value })],
    ["browser_fill", (value) => ({ selector: value, text: "x" })],
    ["browser_fill", (value) => ({ selector: "@e1", text: value })],
    ["browser_type", (value) => ({ text: value })],
    ["browser_press", (value) => ({ key: value })],
    ["browser_scroll", (value) => ({ selector: value })],
    ["browser_wait", (value) => ({ selector: value })],
    ["browser_wait", (value) => ({ load: value })],
    ["browser_wait", (value) => ({ url: value })],
    ["browser_wait", (value) => ({ text: value })],
    ["browser_wait", (value) => ({ fn: value })],
    ["browser_get", (value) => ({ what: "text", selector: value })],
    ["browser_eval", (value) => ({ js: value })],
    ["browser_tabs", (value) => ({ action: "switch", tab: value })],
    ["browser_tabs", (value) => ({ action: "close", tab: value })],
  ];

  it.each(cases)("%s refuses a value that reads as a flag", (name, argsFor) => {
    for (const flag of flags) {
      const prepared = prepare(name, argsFor(flag));
      expect(prepared.ok, `${name} ${flag}`).toBe(false);
    }
  });

  it("passes values that merely start with a dash or hold one later", () => {
    expect(argvOf("browser_fill", { selector: "@e1", text: "-5" })).toEqual(["fill", "@e1", "-5"]);
    expect(argvOf("browser_type", { text: "a --session b" })).toEqual([
      "keyboard",
      "type",
      "a --session b",
    ]);
    expect(argvOf("browser_press", { key: "-" })).toEqual(["press", "-"]);
    expect(argvOf("browser_tabs", { action: "switch", tab: "t2" })).toEqual(["tab", "t2"]);
    expect(argvOf("browser_tabs", { action: "close" })).toEqual(["tab", "close"]);
    expect(argvOf("browser_wait", { load: "networkidle" })).toEqual([
      "wait",
      "--load",
      "networkidle",
    ]);
    expect(argvOf("browser_wait", { url: "**/done" })).toEqual(["wait", "--url", "**/done"]);
    expect(argvOf("browser_scroll", { selector: "#list", px: 50 })).toEqual([
      "scroll",
      "down",
      "50",
      "--selector",
      "#list",
    ]);
  });

  it("says why it refused", () => {
    expect(argvOf("browser_tabs", { action: "switch", tab: "--auto-connect" })).toBe(
      'browser_tabs: tab may not start with "--" or "-" and a letter: agent-browser reads it as a flag',
    );
  });
});
