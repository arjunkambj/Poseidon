import fixture from "@poseidon/contracts/fixtures/rpc/terminal-summary.project.json";
import type { TerminalSummary } from "@poseidon/contracts/terminal";
import { describe, expect, it } from "vitest";

import { runningTerminalCount, runningTerminals, runningTerminalsLabel } from "./running-terminals";

const terminal = (status: "running" | "exited"): TerminalSummary => ({
  ...(fixture as TerminalSummary),
  status,
  exitCode: status === "exited" ? 0 : null,
});

describe("runningTerminals", () => {
  it("keeps the running terminals and leaves the exited ones out", () => {
    const running = { ...terminal("running"), title: "Terminal 2" };
    const terminals = [terminal("exited"), running];
    expect(runningTerminals({ _tag: "ok", terminals })).toEqual([running]);
  });

  it("is empty before the listing answers, or when it failed", () => {
    expect(runningTerminals(null)).toEqual([]);
    expect(runningTerminals({ _tag: "error", message: "offline" })).toEqual([]);
  });
});

describe("runningTerminalCount", () => {
  it("counts the running terminals and leaves the exited ones out", () => {
    const terminals = [terminal("running"), terminal("exited"), terminal("running")];
    expect(runningTerminalCount({ _tag: "ok", terminals })).toBe(2);
  });

  it("is nothing before the listing answers, or when it failed", () => {
    expect(runningTerminalCount(null)).toBe(0);
    expect(runningTerminalCount({ _tag: "error", message: "offline" })).toBe(0);
    expect(runningTerminalCount({ _tag: "ok", terminals: [terminal("exited")] })).toBe(0);
  });
});

describe("runningTerminalsLabel", () => {
  it("says how many run, and where", () => {
    expect(runningTerminalsLabel(1)).toBe("1 terminal running in this project's folder");
    expect(runningTerminalsLabel(2)).toBe("2 terminals running in this project's folder");
  });
});
