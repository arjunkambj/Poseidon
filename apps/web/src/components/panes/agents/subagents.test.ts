import { decodeItemId, type ItemId } from "@poseidon/contracts/ids";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { describe, expect, it } from "vitest";

import {
  agentsStripSummary,
  groupSubagents,
  type Subagent,
  subagentsOf,
} from "@/components/panes/agents/subagents";

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
let sequence = 0;

/** A UUIDv7 id minted `offsetMs` after T0. */
const idAt = (offsetMs: number): ItemId => {
  sequence += 1;
  const stamp = (T0 + offsetMs).toString(16).padStart(12, "0");
  const counter = (sequence & 0xfff).toString(16).padStart(3, "0");
  const node = sequence.toString(16).padStart(15, "0");
  return decodeItemId(
    `${stamp.slice(0, 8)}-${stamp.slice(8, 12)}-7${counter}-8${node.slice(0, 3)}-${node.slice(3)}`,
  );
};

const task = (
  offsetMs: number,
  status: ItemSnapshot["status"],
  fields: Partial<ItemSnapshot> = {},
): ItemSnapshot =>
  ({ itemId: idAt(offsetMs), kind: "task", status, text: "Explore", ...fields }) as ItemSnapshot;

const child = (offsetMs: number, parent: ItemSnapshot, kind: ItemSnapshot["kind"] = "tool_call") =>
  ({
    itemId: idAt(offsetMs),
    kind,
    status: "completed",
    parentItemId: parent.itemId,
  }) as ItemSnapshot;

/** The running turn's id, as `snapshot.currentTurnId` carries it. */
const LIVE = "0199c0de-0004-7000-8000-000000000002";
const EARLIER = "0199c0de-0004-7000-8000-000000000001";

const titles = (list: ReadonlyArray<Subagent>) => list.map((subagent) => subagent.title);

describe("subagentsOf", () => {
  it("reads each task row's state, counting nested tasks too", () => {
    const done = task(0, "completed", { text: "Done one" });
    const failed = task(10, "failed", { text: "Failed one" });
    const running = task(20, "in_progress", { text: "Running one" });
    const nested = { ...task(30, "in_progress", { text: "Nested" }), parentItemId: running.itemId };
    const message = {
      itemId: idAt(40),
      kind: "assistant_message",
      status: "completed",
    } as ItemSnapshot;
    const list = subagentsOf([done, failed, running, nested, message], LIVE);
    expect(list.map((subagent) => [subagent.title, subagent.state])).toEqual([
      ["Done one", "done"],
      ["Failed one", "failed"],
      ["Running one", "working"],
      ["Nested", "working"],
    ]);
  });

  it("reads a task left running after its turn settled as failed", () => {
    const [subagent] = subagentsOf([task(0, "in_progress")], null);
    expect(subagent?.state).toBe("failed");
  });

  it("reads a task stranded by an earlier turn as failed while a newer turn runs", () => {
    const stranded = task(0, "in_progress", {
      text: "stranded",
      turnId: EARLIER,
    } as Partial<ItemSnapshot>);
    const current = task(10, "in_progress", {
      text: "current",
      turnId: LIVE,
    } as Partial<ItemSnapshot>);
    const unstamped = task(20, "in_progress", { text: "unstamped" });
    const list = subagentsOf([stranded, current, unstamped], LIVE);
    expect(list.map((subagent) => [subagent.title, subagent.state])).toEqual([
      ["stranded", "failed"],
      ["current", "working"],
      ["unstamped", "working"],
    ]);
  });

  it("falls back to a generic title when the row has no text", () => {
    const [subagent] = subagentsOf([task(0, "completed", { text: "" })], null);
    expect(subagent?.title).toBe("Subagent task");
  });

  it("takes the prompt from the call's input, trimmed, only when it is a string", () => {
    const withPrompt = task(0, "completed", {
      tool: { name: "Task", input: { prompt: "  Find the bug\n" } },
    });
    const noInput = task(10, "completed");
    const nonString = task(20, "completed", { tool: { name: "Task", input: { prompt: 42 } } });
    const blank = task(30, "completed", { tool: { name: "Task", input: { prompt: "   " } } });
    const list = subagentsOf([withPrompt, noInput, nonString, blank], null);
    expect(list.map((subagent) => subagent.prompt)).toEqual([
      "Find the bug",
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("keeps the last five direct children as recent rows, in item order", () => {
    const parent = task(0, "in_progress");
    const kids = Array.from({ length: 7 }, (_, index) => child(100 * (index + 1), parent));
    const nested = task(900, "completed");
    const nestedWithParent = { ...nested, parentItemId: kids[6]!.itemId };
    const grandchild = child(1_000, nestedWithParent);
    const [subagent] = subagentsOf([parent, ...kids, nestedWithParent, grandchild], LIVE);
    expect(subagent?.recent).toEqual(kids.slice(2));
  });

  it("reads progress from the task row's output when it has no rows of its own", () => {
    const progressOnly = task(0, "in_progress", {
      tool: { name: "agent", input: { prompt: "Scan" }, output: "Reading src/\nRunning tests" },
    });
    const withRows = task(10, "in_progress", {
      tool: { name: "Task", input: {}, output: "ignored" },
    });
    const kid = child(20, withRows);
    const list = subagentsOf([progressOnly, withRows, kid], LIVE);
    expect(list[0]?.progress).toBe("Reading src/\nRunning tests");
    expect(list[1]?.progress).toBeUndefined();
  });

  it("reads start from the id and a settled task's duration from its descendants' span", () => {
    const parent = task(1_000, "completed");
    const kid = child(3_000, parent);
    const nested = { ...task(4_000, "completed"), parentItemId: kid.itemId };
    const deep = child(9_000, nested);
    const running = task(10_000, "in_progress");
    const lone = task(20_000, "completed");
    const list = subagentsOf([parent, kid, nested, deep, running, lone], LIVE);
    expect(list.map((subagent) => subagent.startedAt)).toEqual([
      T0 + 1_000,
      T0 + 4_000,
      T0 + 10_000,
      T0 + 20_000,
    ]);
    expect(list[0]?.durationMs).toBe(8_000);
    expect(list[1]?.durationMs).toBe(5_000);
    // A working task has no duration yet; a lone settled row has no span.
    expect(list[2]?.durationMs).toBeUndefined();
    expect(list[3]?.durationMs).toBeUndefined();
  });
});

describe("groupSubagents", () => {
  it("groups by state, newest first", () => {
    const list = subagentsOf(
      [
        task(0, "completed", { text: "done-old" }),
        task(30, "completed", { text: "done-new" }),
        task(10, "failed", { text: "failed-old" }),
        task(40, "failed", { text: "failed-new" }),
        task(20, "in_progress", { text: "work-old" }),
        task(50, "in_progress", { text: "work-new" }),
      ],
      LIVE,
    );
    const groups = groupSubagents(list);
    expect(titles(groups.working)).toEqual(["work-new", "work-old"]);
    expect(titles(groups.done)).toEqual(["done-new", "done-old"]);
    expect(titles(groups.failed)).toEqual(["failed-new", "failed-old"]);
  });

  it("breaks a tie in start time by item order, later first", () => {
    const shared = T0 + 5;
    const stamp = shared.toString(16).padStart(12, "0");
    const at = (n: number) =>
      decodeItemId(`${stamp.slice(0, 8)}-${stamp.slice(8, 12)}-7${n}00-8000-00000000000${n}`);
    const list = subagentsOf(
      [
        { itemId: at(1), kind: "task", status: "completed", text: "first" } as ItemSnapshot,
        { itemId: at(2), kind: "task", status: "completed", text: "second" } as ItemSnapshot,
      ],
      null,
    );
    expect(titles(groupSubagents(list).done)).toEqual(["second", "first"]);
  });
});

describe("agentsStripSummary", () => {
  it("is null when no subagent is working", () => {
    expect(agentsStripSummary([], LIVE)).toBeNull();
    expect(agentsStripSummary([task(0, "completed"), task(10, "failed")], LIVE)).toBeNull();
    // A turn that settled leaves nothing working, whatever the rows say.
    expect(agentsStripSummary([task(0, "in_progress")], null)).toBeNull();
  });

  it("counts the working subagents and names the newest", () => {
    const summary = agentsStripSummary(
      [
        task(0, "in_progress", { text: "older" }),
        task(10, "completed", { text: "finished" }),
        task(20, "in_progress", { text: "newer" }),
      ],
      LIVE,
    );
    expect(summary?.count).toBe(2);
    expect(summary?.newest.title).toBe("newer");
  });

  it("leaves out a task stranded by an earlier turn", () => {
    const summary = agentsStripSummary(
      [
        task(0, "in_progress", { text: "current", turnId: LIVE } as Partial<ItemSnapshot>),
        task(10, "in_progress", { text: "stranded", turnId: EARLIER } as Partial<ItemSnapshot>),
      ],
      LIVE,
    );
    expect(summary?.count).toBe(1);
    expect(summary?.newest.title).toBe("current");
    expect(
      agentsStripSummary(
        [task(0, "in_progress", { turnId: EARLIER } as Partial<ItemSnapshot>)],
        LIVE,
      ),
    ).toBeNull();
  });
});
