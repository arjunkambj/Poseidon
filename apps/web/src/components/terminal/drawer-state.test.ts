import fixture from "@poseidon/contracts/fixtures/rpc/terminal-summary.json";
import type { TerminalId } from "@poseidon/contracts/ids";
import type { TerminalSummary } from "@poseidon/contracts/terminal";
import { describe, expect, it } from "vitest";

import {
  emptyDrawerState,
  handOverDrawerState,
  nextTitle,
  reduceDrawer,
  type DrawerState,
} from "./drawer-state";

const id = (n: number) => `0199c0de-0012-7000-8000-00000000000${n}` as TerminalId;

const summary = (
  n: number,
  over: Partial<Pick<TerminalSummary, "status" | "exitCode" | "script">> = {},
): TerminalSummary => ({
  ...(fixture as TerminalSummary),
  terminalId: id(n),
  title: `Terminal ${n}`,
  ...over,
});

const tab = (n: number, over: Partial<DrawerState["tabs"][number]> = {}) => ({
  terminalId: id(n),
  title: `Terminal ${n}`,
  status: "running" as const,
  exitCode: null,
  script: null,
  ...over,
});

const withTabs = (ns: ReadonlyArray<number>, active: number | null): DrawerState => ({
  tabs: ns.map((n) => tab(n)),
  activeId: active === null ? null : id(active),
});

describe("reduceDrawer synced", () => {
  it("takes the server's order and keeps the active tab", () => {
    const state = reduceDrawer(withTabs([2, 1], 2), {
      type: "synced",
      terminals: [summary(1), summary(2), summary(3)],
    });
    expect(state.tabs.map((entry) => entry.terminalId)).toEqual([id(1), id(2), id(3)]);
    expect(state.activeId).toBe(id(2));
  });

  it("activates the last tab when the active one is no longer listed", () => {
    const state = reduceDrawer(withTabs([1, 2], 2), {
      type: "synced",
      terminals: [summary(1), summary(3)],
    });
    expect(state.tabs.map((entry) => entry.terminalId)).toEqual([id(1), id(3)]);
    expect(state.activeId).toBe(id(3));
  });

  it("activates the last tab on a first listing", () => {
    const state = reduceDrawer(emptyDrawerState, {
      type: "synced",
      terminals: [summary(1), summary(2)],
    });
    expect(state.activeId).toBe(id(2));
  });

  it("empties to no active tab", () => {
    expect(reduceDrawer(withTabs([1], 1), { type: "synced", terminals: [] })).toEqual(
      emptyDrawerState,
    );
  });

  it("carries the listed status and exit code", () => {
    const state = reduceDrawer(emptyDrawerState, {
      type: "synced",
      terminals: [summary(1, { status: "exited", exitCode: 2 })],
    });
    expect(state.tabs[0]).toEqual(tab(1, { status: "exited", exitCode: 2 }));
  });

  it("carries the script a terminal runs, and null for a shell", () => {
    const script = { id: "dev", name: "Dev server" };
    const state = reduceDrawer(emptyDrawerState, {
      type: "synced",
      terminals: [summary(1, { script }), summary(2)],
    });
    expect(state.tabs.map((entry) => entry.script)).toEqual([script, null]);
  });

  it("does not undo an exit seen after the listing was taken", () => {
    const exited = reduceDrawer(withTabs([1], 1), {
      type: "exited",
      terminalId: id(1),
      exitCode: 0,
    });
    const state = reduceDrawer(exited, { type: "synced", terminals: [summary(1)] });
    expect(state.tabs[0]).toEqual(tab(1, { status: "exited", exitCode: 0 }));
  });
});

describe("reduceDrawer opened", () => {
  it("appends the new terminal and activates it", () => {
    const state = reduceDrawer(withTabs([1], 1), { type: "opened", terminal: summary(2) });
    expect(state.tabs.map((entry) => entry.terminalId)).toEqual([id(1), id(2)]);
    expect(state.activeId).toBe(id(2));
  });

  it("replaces a terminal the listing already brought in", () => {
    const state = reduceDrawer(withTabs([1, 2], 1), { type: "opened", terminal: summary(2) });
    expect(state.tabs).toHaveLength(2);
    expect(state.activeId).toBe(id(2));
  });
});

describe("reduceDrawer closed", () => {
  it("activates the tab after the closed one", () => {
    const state = reduceDrawer(withTabs([1, 2, 3], 2), { type: "closed", terminalId: id(2) });
    expect(state.tabs.map((entry) => entry.terminalId)).toEqual([id(1), id(3)]);
    expect(state.activeId).toBe(id(3));
  });

  it("activates the one before when the last tab closes", () => {
    const state = reduceDrawer(withTabs([1, 2, 3], 3), { type: "closed", terminalId: id(3) });
    expect(state.activeId).toBe(id(2));
  });

  it("keeps the active tab when another one closes", () => {
    const state = reduceDrawer(withTabs([1, 2, 3], 1), { type: "closed", terminalId: id(3) });
    expect(state.activeId).toBe(id(1));
  });

  it("leaves nothing active after the only tab closes", () => {
    expect(reduceDrawer(withTabs([1], 1), { type: "closed", terminalId: id(1) })).toEqual(
      emptyDrawerState,
    );
  });

  it("ignores a terminal it does not show", () => {
    const state = withTabs([1], 1);
    expect(reduceDrawer(state, { type: "closed", terminalId: id(9) })).toBe(state);
  });
});

describe("reduceDrawer exited and activated", () => {
  it("marks one tab exited with its code", () => {
    const state = reduceDrawer(withTabs([1, 2], 2), {
      type: "exited",
      terminalId: id(1),
      exitCode: null,
    });
    expect(state.tabs).toEqual([tab(1, { status: "exited", exitCode: null }), tab(2)]);
    expect(state.activeId).toBe(id(2));
  });

  it("activates a shown tab and ignores an unknown one", () => {
    const state = withTabs([1, 2], 2);
    expect(reduceDrawer(state, { type: "activated", terminalId: id(1) }).activeId).toBe(id(1));
    expect(reduceDrawer(state, { type: "activated", terminalId: id(9) })).toBe(state);
  });
});

describe("nextTitle", () => {
  it("starts at Terminal 1", () => {
    expect(nextTitle([])).toBe("Terminal 1");
  });

  it("takes the smallest free number", () => {
    expect(nextTitle([{ title: "Terminal 1" }, { title: "Terminal 3" }])).toBe("Terminal 2");
    expect(nextTitle([{ title: "Terminal 2" }, { title: "Terminal 1" }])).toBe("Terminal 3");
  });

  it("ignores titles of another shape", () => {
    expect(nextTitle([{ title: "build" }])).toBe("Terminal 1");
  });
});

describe("handOverDrawerState", () => {
  const project = "project:0199c0de-0001-7000-8000-000000000001";
  const thread = "0199c0de-0002-7000-8000-000000000001";

  it("moves the project's tabs to a fresh thread, the one in front still in front", () => {
    const states = { [project]: withTabs([1, 2, 3], 2) };
    expect(handOverDrawerState(states, project, thread)).toEqual({
      [thread]: withTabs([1, 2, 3], 2),
    });
  });

  it("puts them after the thread's own, keeping its tab in front", () => {
    const states = { [project]: withTabs([2, 3], 3), [thread]: withTabs([1], 1) };
    expect(handOverDrawerState(states, project, thread)).toEqual({
      [thread]: withTabs([1, 2, 3], 1),
    });
  });

  it("leaves every other owner alone, and changes nothing with nothing to move", () => {
    const other = "0199c0de-0002-7000-8000-000000000002";
    const states = { [project]: withTabs([1], 1), [other]: withTabs([4], 4) };
    expect(handOverDrawerState(states, project, thread)[other]).toBe(states[other]);
    const empty = { [other]: withTabs([4], 4) };
    expect(handOverDrawerState(empty, project, thread)).toBe(empty);
  });
});
