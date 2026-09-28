import type { TerminalId } from "@poseidon/contracts/ids";
import type { DetectedScript, ProjectScript } from "@poseidon/contracts/scripts";
import { describe, expect, it } from "vitest";

import type { TerminalTab } from "@/components/terminal/drawer-state";

import {
  hasUnwatchedScript,
  nextScriptId,
  planRun,
  primaryScript,
  runnableFromDetected,
  runningTerminalOf,
  scriptsFromDrafts,
  validateScripts,
  withScripts,
  type ScriptDraft,
} from "./project-scripts";

const dev: ProjectScript = { id: "dev", name: "Dev", command: "pnpm dev" };
const test: ProjectScript = { id: "test", name: "Test", command: "pnpm test", primary: true };

const draft = (over: Partial<ScriptDraft> = {}): ScriptDraft => ({
  id: null,
  name: "Dev",
  command: "pnpm dev",
  primary: false,
  ...over,
});

const id = (n: number) => `0199c0de-0012-7000-8000-00000000000${n}` as TerminalId;

const tab = (n: number, over: Partial<TerminalTab> = {}): TerminalTab => ({
  terminalId: id(n),
  title: `Terminal ${n}`,
  status: "running",
  exitCode: null,
  script: null,
  ...over,
});

describe("withScripts", () => {
  it("keeps the setup script and other projects", () => {
    const current = { p1: { setupScript: "pnpm install" }, p2: { scripts: [dev] } };
    expect(withScripts(current, "p1", [dev, test])).toEqual({
      p1: { setupScript: "pnpm install", scripts: [dev, test] },
      p2: { scripts: [dev] },
    });
  });

  it("drops the key for an empty list, and the entry for a project left with nothing", () => {
    expect(withScripts({ p1: { setupScript: "x", scripts: [dev] } }, "p1", [])).toEqual({
      p1: { setupScript: "x" },
    });
    expect(withScripts({ p1: { scripts: [dev] }, p2: { setupScript: "y" } }, "p1", [])).toEqual({
      p2: { setupScript: "y" },
    });
  });

  it("is null when nothing changed", () => {
    expect(withScripts({ p1: { scripts: [dev] } }, "p1", [{ ...dev }])).toBeNull();
    expect(withScripts({}, "p1", [])).toBeNull();
    expect(withScripts({ p1: { scripts: [test] } }, "p1", [{ ...test, primary: false }])).toEqual({
      p1: { scripts: [{ ...test, primary: false }] },
    });
  });
});

describe("primaryScript", () => {
  it("takes the primary one, else the first, else none", () => {
    expect(primaryScript([dev, test])).toBe(test);
    expect(primaryScript([dev, { ...test, primary: false }])).toBe(dev);
    expect(primaryScript([])).toBeNull();
  });
});

describe("validateScripts", () => {
  it("accepts a clean draft", () => {
    expect(validateScripts([draft(), draft({ name: "Test", primary: true })])).toBeNull();
    expect(validateScripts([])).toBeNull();
  });

  it("reports blank names and commands, and duplicate names", () => {
    expect(
      validateScripts([draft({ name: "  " }), draft({ name: "Build", command: " " })]),
    ).toEqual(["Give the script a name.", "Give the script a command."]);
    expect(validateScripts([draft(), draft({ name: " Dev " })])).toEqual([
      null,
      "Another script is already named “Dev”.",
    ]);
  });

  it("allows one primary at most", () => {
    expect(
      validateScripts([draft({ primary: true }), draft({ name: "Test", primary: true })]),
    ).toEqual([null, "Only one script can be the primary one."]);
  });

  it("refuses a command too long to run", () => {
    expect(validateScripts([draft({ command: "x".repeat(9000) })])?.[0]).toContain("at most");
  });
});

describe("nextScriptId and scriptsFromDrafts", () => {
  it("slugs the name and numbers a taken one", () => {
    expect(nextScriptId("Dev Server!", new Set())).toBe("dev-server");
    expect(nextScriptId("Dev", new Set(["dev", "dev-2"]))).toBe("dev-3");
    expect(nextScriptId("…", new Set())).toBe("script");
  });

  it("keeps saved ids, mints new ones and trims", () => {
    expect(
      scriptsFromDrafts([
        draft({ id: "dev", name: " Dev ", command: " pnpm dev " }),
        draft({ name: "Dev", command: "pnpm dev --host", primary: true }),
      ]),
    ).toEqual([
      { id: "dev", name: "Dev", command: "pnpm dev" },
      { id: "dev-2", name: "Dev", command: "pnpm dev --host", primary: true },
    ]);
  });
});

describe("runnableFromDetected", () => {
  const detected: DetectedScript = {
    id: "pkg::dev",
    name: "dev",
    packageName: "app",
    packageDir: "",
    command: "pnpm run dev",
    packageManager: "pnpm",
  };

  it("names a nested package's script with its directory", () => {
    expect(runnableFromDetected(detected)).toEqual({
      id: "pkg::dev",
      name: "dev",
      command: "pnpm run dev",
    });
    expect(
      runnableFromDetected({
        ...detected,
        id: "pkg:apps/web:dev",
        packageDir: "apps/web",
        command: "cd 'apps/web' && pnpm run dev",
      }).name,
    ).toBe("dev (apps/web)");
  });
});

describe("planRun", () => {
  const script = { id: "dev" };
  const devTab = (n: number, status: "running" | "exited") =>
    tab(n, { status, script: { id: "dev", name: "Dev" } });

  it("focuses the tab already running the script", () => {
    expect(planRun([tab(1), devTab(2, "running")], script)).toEqual({
      kind: "focus",
      terminalId: id(2),
    });
  });

  it("opens a fresh terminal when none runs it", () => {
    expect(planRun([tab(1)], script)).toEqual({ kind: "open", replace: null });
  });

  it("replaces a tab of the script that has exited", () => {
    expect(planRun([devTab(1, "exited"), tab(2)], script)).toEqual({
      kind: "open",
      replace: id(1),
    });
  });

  it("finds the running terminal of a script", () => {
    expect(runningTerminalOf([devTab(1, "exited"), devTab(2, "running")], "dev")).toBe(id(2));
    expect(runningTerminalOf([devTab(1, "exited")], "dev")).toBeNull();
  });
});

describe("hasUnwatchedScript", () => {
  const devTab = (n: number, status: "running" | "exited") =>
    tab(n, { status, script: { id: "dev", name: "Dev" } });

  it("holds for a running script behind a closed drawer", () => {
    expect(hasUnwatchedScript([devTab(1, "running")], id(1), false)).toBe(true);
  });

  it("holds for a running script in a tab not in front", () => {
    expect(hasUnwatchedScript([devTab(1, "running"), tab(2)], id(2), true)).toBe(true);
  });

  it("does not hold for the script in front of an open drawer, which its xterm watches", () => {
    expect(hasUnwatchedScript([devTab(1, "running"), tab(2)], id(1), true)).toBe(false);
  });

  it("ignores plain shells and scripts that have exited", () => {
    expect(hasUnwatchedScript([tab(1), devTab(2, "exited")], null, false)).toBe(false);
  });
});
