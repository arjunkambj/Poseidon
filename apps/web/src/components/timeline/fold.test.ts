import type { ItemKind } from "@poseidon/contracts/enums";
import { type ItemId, makeTurnId } from "@poseidon/contracts/ids";
import type { ResolvedDecision } from "@poseidon/contracts/decisions";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { describe, expect, it } from "vitest";

import { uuidV7Millis } from "@poseidon/shared/ids";

import {
  ALL_FOLDS_OPEN,
  buildTimeline,
  type TimelineDecisionRow,
  type TimelineTurnFoldRow,
  type TimelineTurnSummaryRow,
  type TimelineWorkGroupRow,
  type TimelineWorkingRow,
} from "./fold";

let sequence = 0;

/** A deterministic UUIDv7 with a controllable millisecond prefix. */
const itemIdAt = (millis: number): ItemId => {
  sequence += 1;
  const hex = millis.toString(16).padStart(12, "0");
  const suffix = sequence.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${suffix}` as ItemId;
};

let millis = 1_700_000_000_000;

const item = (kind: ItemKind, over: Partial<ItemSnapshot> = {}): ItemSnapshot => {
  millis += 1_000;
  return { itemId: itemIdAt(millis), kind, status: "completed", ...over };
};

const workGroups = (rows: ReturnType<typeof buildTimeline>["rows"]) =>
  rows.filter((row): row is TimelineWorkGroupRow => row.kind === "work-group");

const summaries = (rows: ReturnType<typeof buildTimeline>["rows"]) =>
  rows.filter((row): row is TimelineTurnSummaryRow => row.kind === "turn-summary");

const edit = (path: string, diff: string, over: Partial<ItemSnapshot> = {}): ItemSnapshot =>
  item("file_change", { fileChange: { path, kind: "edit", diff }, ...over });

const folds = (rows: ReturnType<typeof buildTimeline>["rows"]) =>
  rows.filter((row): row is TimelineTurnFoldRow => row.kind === "turn-fold");

/** Row kinds, item rows by their item kind and decisions by their id. */
const labels = (rows: ReturnType<typeof buildTimeline>["rows"]) =>
  rows.map((row) =>
    row.kind === "item"
      ? row.item.kind
      : row.kind === "decision"
        ? `decision:${row.decision.id}`
        : row.kind,
  );

const open = { isFoldOpen: ALL_FOLDS_OPEN } as const;

describe("buildTimeline", () => {
  it("passes a lone message exchange through untouched", () => {
    const items = [
      item("user_message", { text: "hi" }),
      item("assistant_message", { text: "hello" }),
    ];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(rows.map((row) => row.kind)).toEqual(["item", "item"]);
  });

  it("folds a settled turn's work into one row before its answer", () => {
    const user = item("user_message");
    const items = [
      user,
      item("reasoning"),
      item("tool_call"),
      item("command_execution"),
      item("assistant_message"),
    ];
    const closed = buildTimeline(items, { turnActive: false }).rows;
    expect(labels(closed)).toEqual(["user_message", "turn-fold", "assistant_message"]);
    const [fold] = folds(closed);
    expect(fold.id).toBe(`turn-fold:${user.itemId}`);
    expect(fold.sentence).toBe("Ran 1 command, used 1 tool");

    const opened = buildTimeline(items, { turnActive: false, ...open }).rows;
    expect(labels(opened)).toEqual([
      "user_message",
      "turn-fold",
      "work-group",
      "assistant_message",
    ]);
    expect(workGroups(opened)[0].items).toHaveLength(3);
  });

  it("folds the live turn's work into a burst and appends a working row", () => {
    const items = [
      item("user_message"),
      item("tool_call"),
      item("assistant_message"),
      item("user_message"),
      item("tool_call"),
    ];
    const { rows } = buildTimeline(items, { turnActive: true });
    expect(labels(rows)).toEqual([
      "user_message",
      "turn-fold",
      "assistant_message",
      "user_message",
      "work-group",
      "working",
    ]);
  });

  it("splits an open fold's work around a row it keeps", () => {
    const items = [
      item("user_message"),
      item("tool_call"),
      item("context_compaction"),
      item("tool_call"),
      item("assistant_message"),
    ];
    const closed = buildTimeline(items, { turnActive: false }).rows;
    expect(labels(closed)).toEqual([
      "user_message",
      "turn-fold",
      "context_compaction",
      "assistant_message",
    ]);
    const opened = buildTimeline(items, { turnActive: false, ...open }).rows;
    expect(labels(opened)).toEqual([
      "user_message",
      "turn-fold",
      "work-group",
      "context_compaction",
      "work-group",
      "assistant_message",
    ]);
    expect(workGroups(opened).map((group) => group.items.length)).toEqual([1, 1]);
  });

  it("nests task children under the parent and keeps orphans at top level", () => {
    const task = item("task");
    const child = item("tool_call", { parentItemId: task.itemId });
    const orphan = item("tool_call", { parentItemId: itemIdAt(1) });
    const { rows, childrenByParent } = buildTimeline([task, child, orphan], {
      turnActive: false,
    });
    expect(childrenByParent.get(task.itemId)?.map((i) => i.itemId)).toEqual([child.itemId]);
    // task and orphan form one settled run; the child is not a top-level row
    expect(rows).toHaveLength(1);
    expect(workGroups(rows)[0].items.map((i) => i.itemId)).toEqual([task.itemId, orphan.itemId]);
  });

  it("derives the group's duration from the UUIDv7 item ids", () => {
    const items = [item("user_message"), item("tool_call"), item("tool_call")];
    const group = workGroups(buildTimeline(items, { turnActive: false, ...open }).rows)[0];
    expect(group.durationMs).toBe(1_000);
  });

  it("reports failures in the folded group and on the fold row", () => {
    const items = [
      item("user_message"),
      item("command_execution", { status: "failed" }),
      item("tool_call"),
    ];
    const { rows } = buildTimeline(items, { turnActive: false, ...open });
    expect(workGroups(rows)[0].failedCount).toBe(1);
    expect(folds(rows)[0].failedCount).toBe(1);
  });

  it("folds items that precede the first user message into work groups only", () => {
    const items = [item("reasoning"), item("tool_call"), item("assistant_message")];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(rows.map((row) => row.kind)).toEqual(["work-group", "item"]);
  });
});

describe("buildTimeline turn summaries", () => {
  it("ends a settled turn with one card of its files and line counts", () => {
    const turnId = makeTurnId();
    const user = item("user_message", { turnId });
    const items = [
      user,
      item("tool_call", { turnId }),
      edit("src/a.ts", "@@ -1,2 +1,3 @@\n-old\n+new\n+more", { turnId }),
      item("file_change", {
        turnId,
        fileChange: { path: "src/b.ts", kind: "create", diff: "+x" },
      }),
      item("assistant_message", { turnId }),
    ];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(labels(rows)).toEqual([
      "user_message",
      "turn-fold",
      "assistant_message",
      "turn-summary",
    ]);
    const [summary] = summaries(rows);
    expect(summaries(rows)).toHaveLength(1);
    expect(summary.id).toBe(`turn-summary:${user.itemId}`);
    expect(summary.turnId).toBe(turnId);
    expect(summary.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(summary.added).toBe(3);
    expect(summary.removed).toBe(1);
    // the time is the fold row's to say
    expect(folds(rows)[0].durationMs).toBe(4_000);
  });

  it("merges repeated paths into one entry", () => {
    const items = [
      item("user_message"),
      item("file_change", { fileChange: { path: "src/a.ts", kind: "create", diff: "+one" } }),
      edit("src/a.ts", "+two\n-one"),
      edit("src/a.ts", "+three", { status: "failed" }),
    ];
    const { rows } = buildTimeline(items, { turnActive: false });
    const [summary] = summaries(rows);
    expect(summary.files).toEqual([{ path: "src/a.ts", kind: "create", added: 3, removed: 1 }]);
    expect(folds(rows)[0].sentence).toBe("Created 1 file");
    expect(folds(rows)[0].failedCount).toBe(1);
  });

  it("counts file changes and time nested under a task", () => {
    const user = item("user_message");
    const task = item("task");
    const inner = item("task", { parentItemId: task.itemId });
    const change = edit("src/deep.ts", "+a\n+b", { parentItemId: inner.itemId });
    const { rows } = buildTimeline([user, task, inner, change], { turnActive: false });
    expect(summaries(rows)[0].files).toEqual([
      { path: "src/deep.ts", kind: "edit", added: 2, removed: 0 },
    ]);
    // the nested change is the turn's last item
    expect(folds(rows)[0].durationMs).toBe(3_000);
  });

  it("adds no card when the turn changed no files", () => {
    const items = [item("user_message"), item("command_execution"), item("assistant_message")];
    expect(summaries(buildTimeline(items, { turnActive: false }).rows)).toEqual([]);
  });

  it("leaves out turns without work, the live turn and a leading segment", () => {
    const plain = [item("user_message"), item("assistant_message")];
    expect(summaries(buildTimeline(plain, { turnActive: false }).rows)).toEqual([]);

    const live = [item("user_message"), edit("a.ts", "+a")];
    expect(summaries(buildTimeline(live, { turnActive: true }).rows)).toEqual([]);

    const leading = [edit("a.ts", "+a"), item("assistant_message")];
    expect(summaries(buildTimeline(leading, { turnActive: false }).rows)).toEqual([]);
  });

  it("names the checkpoint its turn left, and nothing for a turn without one", () => {
    const first = makeTurnId();
    const second = makeTurnId();
    const items = [
      item("user_message", { turnId: first }),
      edit("a.ts", "+a", { turnId: first }),
      item("user_message", { turnId: second }),
      edit("b.ts", "+b", { turnId: second }),
      // A turn from before turn ids were recorded.
      item("user_message"),
      edit("c.ts", "+c"),
    ];
    const checkpoints = [{ turnId: first, ref: "refs/poseidon/checkpoints/t/1" }];
    const rows = summaries(buildTimeline(items, { turnActive: false, checkpoints }).rows);
    expect(rows.map((summary) => summary.checkpointRef)).toEqual([
      "refs/poseidon/checkpoints/t/1",
      undefined,
      undefined,
    ]);
  });

  it("drops a duration the ids cannot measure", () => {
    const user = item("user_message");
    // two items in one millisecond: no measurable time
    const sameMs: ItemSnapshot = {
      itemId: itemIdAt(millis),
      kind: "tool_call",
      status: "completed",
    };
    const [fold] = folds(buildTimeline([user, sameMs], { turnActive: false }).rows);
    expect(fold.durationMs).toBeUndefined();
  });
});

describe("buildTimeline working row", () => {
  const working = (rows: ReturnType<typeof buildTimeline>["rows"]) =>
    rows.find((row): row is TimelineWorkingRow => row.kind === "working");

  it("starts the clock at the turn's own start when it is known", () => {
    const items = [item("user_message"), item("tool_call")];
    const { rows } = buildTimeline(items, { turnActive: true, turnStartedAt: 1_234 });
    expect(working(rows)?.startedAt).toBe(1_234);
  });

  it("falls back to the last user message before the turn id is filled in", () => {
    const first = item("user_message");
    const reply = item("assistant_message");
    const second = item("user_message");
    const { rows } = buildTimeline([first, reply, second, item("reasoning")], {
      turnActive: true,
    });
    expect(working(rows)?.startedAt).toBe(uuidV7Millis(second.itemId));
    expect(working(rows)?.startedAt).toBeGreaterThan(uuidV7Millis(first.itemId) ?? 0);
  });

  it("leaves the start unknown when nothing carries a time", () => {
    const { rows } = buildTimeline([item("assistant_message")], { turnActive: true });
    expect(working(rows)?.startedAt).toBeUndefined();
  });

  it("adds no working row once the turn has settled", () => {
    const { rows } = buildTimeline([item("user_message")], {
      turnActive: false,
      turnStartedAt: 1_234,
    });
    expect(working(rows)).toBeUndefined();
  });
});

describe("buildTimeline decisions", () => {
  const decision = (over: Partial<ResolvedDecision> = {}): ResolvedDecision => ({
    kind: "approval",
    id: "req-1",
    outcome: "allow-once",
    resolvedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });

  it("places a record right after the row holding its anchor", () => {
    const user = item("user_message");
    const reply = item("assistant_message");
    const { rows } = buildTimeline([user, reply, item("user_message")], {
      turnActive: true,
      decisions: [decision({ afterItemId: user.itemId })],
    });
    expect(labels(rows)).toEqual([
      "user_message",
      "decision:req-1",
      "assistant_message",
      "user_message",
      "working",
    ]);
    const row = rows[1] as TimelineDecisionRow;
    expect(row.id).toBe("decision:req-1");
    expect(row.decision.outcome).toBe("allow-once");
  });

  it("splits an open fold's work run into two groups around the record", () => {
    const first = item("tool_call");
    const items = [
      item("user_message"),
      item("reasoning"),
      first,
      item("command_execution"),
      item("tool_call"),
      item("assistant_message"),
    ];
    const options = { turnActive: false, decisions: [decision({ afterItemId: first.itemId })] };
    const { rows } = buildTimeline(items, { ...options, ...open });
    expect(labels(rows)).toEqual([
      "user_message",
      "turn-fold",
      "work-group",
      "decision:req-1",
      "work-group",
      "assistant_message",
    ]);
    expect(workGroups(rows).map((group) => group.items.length)).toEqual([2, 2]);
    // the record splits the groups but not the turn: one fold still covers it
    expect(folds(rows)).toHaveLength(1);
    // closed, the record stays in view where its anchor was
    expect(labels(buildTimeline(items, options).rows)).toEqual([
      "user_message",
      "turn-fold",
      "decision:req-1",
      "assistant_message",
    ]);
  });

  it("anchors a task child's record after the task", () => {
    const task = item("task");
    const child = item("tool_call", { parentItemId: task.itemId });
    const items = [item("user_message"), task, child, item("tool_call")];
    const options = { turnActive: false, decisions: [decision({ afterItemId: child.itemId })] };
    const { rows } = buildTimeline(items, { ...options, ...open });
    expect(labels(rows)).toEqual([
      "user_message",
      "turn-fold",
      "work-group",
      "decision:req-1",
      "work-group",
    ]);
    expect(workGroups(rows)[0].items.map((i) => i.itemId)).toEqual([task.itemId]);
    expect(labels(buildTimeline(items, options).rows)).toEqual([
      "user_message",
      "turn-fold",
      "decision:req-1",
    ]);
  });

  it("puts a record with an unknown or missing anchor at the end, before the working row", () => {
    const { rows } = buildTimeline([item("user_message"), item("tool_call")], {
      turnActive: true,
      decisions: [
        decision({ id: "req-1", afterItemId: itemIdAt(1) }),
        decision({ id: "req-2", kind: "question", outcome: "answered" }),
      ],
    });
    expect(labels(rows)).toEqual([
      "user_message",
      "work-group",
      "decision:req-1",
      "decision:req-2",
      "working",
    ]);
  });

  it("keeps row ids unique when two records share an id", () => {
    const user = item("user_message");
    const { rows } = buildTimeline([user], {
      turnActive: false,
      decisions: [
        decision({ kind: "plan", id: "turn-1", outcome: "revise", afterItemId: user.itemId }),
        decision({ kind: "plan", id: "turn-1", outcome: "accept", afterItemId: user.itemId }),
      ],
    });
    expect(rows.map((row) => row.id)).toEqual([
      user.itemId,
      "decision:turn-1",
      "decision:turn-1:2",
    ]);
  });

  it("leaves today's rows unchanged without decisions", () => {
    const items = [
      item("user_message"),
      item("tool_call"),
      item("assistant_message"),
      item("user_message"),
      item("reasoning"),
    ];
    for (const turnActive of [false, true]) {
      const plain = buildTimeline(items, { turnActive });
      expect(buildTimeline(items, { turnActive, decisions: [] })).toEqual(plain);
      expect(buildTimeline(items, { turnActive, decisions: undefined })).toEqual(plain);
    }
  });
});

describe("buildTimeline turn ends", () => {
  const ends = (rows: ReturnType<typeof buildTimeline>["rows"]) =>
    rows.flatMap((row) =>
      row.kind === "item" && row.turnEnd !== undefined ? [{ id: row.id, ...row.turnEnd }] : [],
    );
  const turnA = makeTurnId();
  const turnB = makeTurnId();

  it("marks the last assistant message of each settled turn only", () => {
    const userA = item("user_message", { turnId: turnA });
    const narration = item("assistant_message", { turnId: turnA });
    const tool = item("tool_call", { turnId: turnA });
    const answerA = item("assistant_message", { turnId: turnA });
    const userB = item("user_message", { turnId: turnB });
    const answerB = item("assistant_message", { turnId: turnB });
    const { rows } = buildTimeline([userA, narration, tool, answerA, userB, answerB], {
      turnActive: false,
    });
    expect(ends(rows)).toEqual([
      {
        id: answerA.itemId,
        turnId: turnA,
        durationMs: uuidV7Millis(answerA.itemId)! - uuidV7Millis(userA.itemId)!,
      },
      {
        id: answerB.itemId,
        turnId: turnB,
        durationMs: uuidV7Millis(answerB.itemId)! - uuidV7Millis(userB.itemId)!,
      },
    ]);
  });

  it("marks none in the live turn", () => {
    const userA = item("user_message", { turnId: turnA });
    const answerA = item("assistant_message", { turnId: turnA });
    const userB = item("user_message", { turnId: turnB });
    const interim = item("assistant_message", { turnId: turnB });
    const { rows } = buildTimeline([userA, answerA, userB, interim, item("tool_call")], {
      turnActive: true,
    });
    expect(ends(rows).map((end) => end.id)).toEqual([answerA.itemId]);
  });

  it("runs a turn's time on to when it ended, when that is known", () => {
    const user = item("user_message", { turnId: turnA });
    const tool = item("tool_call", { turnId: turnA });
    const answer = item("assistant_message", { turnId: turnA });
    const startedMs = uuidV7Millis(user.itemId)!;
    // The answer began 2s in and streamed for 5s more before the turn completed.
    const endedAt = new Map([[turnA, uuidV7Millis(answer.itemId)! + 5_000]]);
    const { rows } = buildTimeline([user, tool, answer], {
      turnActive: false,
      turnEndedAt: endedAt,
    });
    expect(ends(rows)[0]?.durationMs).toBe(7_000);
    expect(folds(rows)[0].durationMs).toBe(7_000);
    expect(uuidV7Millis(answer.itemId)! - startedMs).toBe(2_000);

    // A plain question and answer has a duration too, the answer's streaming time.
    const q = item("user_message", { turnId: turnB });
    const a = item("assistant_message", { turnId: turnB });
    const plain = buildTimeline([q, a], {
      turnActive: false,
      turnEndedAt: new Map([[turnB, uuidV7Millis(a.itemId)! + 3_000]]),
    });
    expect(ends(plain.rows)[0]?.durationMs).toBe(4_000);

    // An end recorded before the last item cannot shorten the span.
    const early = buildTimeline([user, tool, answer], {
      turnActive: false,
      turnEndedAt: new Map([[turnA, startedMs]]),
    });
    expect(ends(early.rows)[0]?.durationMs).toBe(2_000);
  });

  it("ends a steered turn at its last answer, timed from its first message", () => {
    const user = item("user_message", { turnId: turnA });
    const before = item("assistant_message", { turnId: turnA });
    const steer = item("user_message", { turnId: turnA });
    const answer = item("assistant_message", { turnId: turnA });
    const settled = buildTimeline([user, before, steer, answer], { turnActive: false });
    expect(ends(settled.rows)).toEqual([
      {
        id: answer.itemId,
        turnId: turnA,
        durationMs: uuidV7Millis(answer.itemId)! - uuidV7Millis(user.itemId)!,
      },
    ]);
    // Steered into the running turn: the answer before the steer is not the end either.
    expect(ends(buildTimeline([user, before, steer], { turnActive: true }).rows)).toEqual([]);
  });

  it("counts task children in the time and skips turns without an answer", () => {
    const user = item("user_message");
    const task = item("task");
    const answer = item("assistant_message");
    const late = item("tool_call", { parentItemId: task.itemId });
    const quiet = [item("user_message"), item("tool_call")];
    const { rows } = buildTimeline([user, task, answer, late, ...quiet], { turnActive: false });
    expect(ends(rows)).toEqual([
      {
        id: answer.itemId,
        turnId: undefined,
        durationMs: uuidV7Millis(late.itemId)! - uuidV7Millis(user.itemId)!,
      },
    ]);
  });

  it("gives an answer before the first user message no end", () => {
    const { rows } = buildTimeline([item("assistant_message"), item("tool_call")], {
      turnActive: false,
    });
    expect(ends(rows)).toEqual([]);
  });
});

describe("buildTimeline turn folds", () => {
  const turnId = makeTurnId();
  const decision: ResolvedDecision = {
    kind: "plan",
    id: "plan-1",
    outcome: "accept",
    resolvedAt: "2026-01-01T00:00:00.000Z",
  };

  /** A settled turn with every kind of row a turn holds, in the order a harness writes them. */
  const settledTurn = () => {
    const user = item("user_message", { turnId });
    const reasoning = item("reasoning", { turnId });
    const narration = item("assistant_message", { turnId, text: "Reading first." });
    const read = item("tool_call", {
      turnId,
      tool: { name: "read_file", input: { file_path: "src/a.ts" } },
    });
    const todo = item("todo", { turnId });
    const plan = item("plan", { turnId });
    const change = edit("src/a.ts", "+a", { turnId });
    const failed = item("command_execution", { turnId, status: "failed" });
    const error = item("error", { turnId, status: "failed" });
    const rerun = item("command_execution", { turnId });
    const answer = item("assistant_message", { turnId, text: "Done." });
    return {
      user,
      answer,
      items: [user, reasoning, narration, read, todo, plan, change, failed, error, rerun, answer],
      decisions: [{ ...decision, afterItemId: plan.itemId }],
    };
  };

  it("folds a settled turn into one row, keeps what matters in view, answer then card last", () => {
    const turn = settledTurn();
    const { rows } = buildTimeline(turn.items, {
      turnActive: false,
      decisions: turn.decisions,
    });
    expect(labels(rows)).toEqual([
      "user_message",
      "turn-fold",
      "todo",
      "plan",
      "decision:plan-1",
      "error",
      "assistant_message",
      "turn-summary",
    ]);
    const [fold] = folds(rows);
    expect(fold.sentence).toBe("Ran 2 commands, edited 1 file, read 1 file");
    expect(fold.failedCount).toBe(1);
    expect(fold.durationMs).toBe(
      uuidV7Millis(turn.answer.itemId)! - uuidV7Millis(turn.user.itemId)!,
    );
    const answer = rows.find((row) => row.id === turn.answer.itemId);
    expect(answer?.kind === "item" && answer.turnEnd?.turnId).toBe(turnId);
  });

  it("puts the hidden rows back in their order when the fold opens", () => {
    const turn = settledTurn();
    const fold = `turn-fold:${turn.user.itemId}`;
    const { rows } = buildTimeline(turn.items, {
      turnActive: false,
      decisions: turn.decisions,
      isFoldOpen: (rowId) => rowId === fold,
    });
    expect(labels(rows)).toEqual([
      "user_message",
      "turn-fold",
      "work-group",
      "assistant_message",
      "work-group",
      "todo",
      "plan",
      "decision:plan-1",
      "work-group",
      "error",
      "work-group",
      "assistant_message",
      "turn-summary",
    ]);
    // every item is on screen once, in the order it was written
    const shown = rows.flatMap((row) =>
      row.kind === "item" ? [row.item] : row.kind === "work-group" ? row.items : [],
    );
    expect(shown.map((i) => i.itemId)).toEqual(turn.items.map((i) => i.itemId));
    // another turn's fold being open changes nothing here
    const other = buildTimeline(turn.items, {
      turnActive: false,
      decisions: turn.decisions,
      isFoldOpen: (rowId) => rowId !== fold && rowId.startsWith("turn-fold:"),
    });
    expect(labels(other.rows)).toContain("todo");
    expect(workGroups(other.rows)).toEqual([]);
  });

  it("folds the live turn's work into bursts, then the working row", () => {
    const turn = settledTurn();
    const { rows } = buildTimeline(turn.items, {
      turnActive: true,
      decisions: turn.decisions,
    });
    expect(folds(rows)).toEqual([]);
    expect(summaries(rows)).toEqual([]);
    expect(labels(rows).join(" ")).toBe(
      "user_message work-group assistant_message work-group todo plan decision:plan-1 " +
        "work-group error work-group assistant_message working",
    );
  });

  it("keeps a steered message inside its turn: one fold, one card", () => {
    const user = item("user_message", { turnId });
    const steer = item("user_message", { turnId });
    const items = [
      user,
      item("tool_call", { turnId }),
      steer,
      edit("src/a.ts", "+a", { turnId }),
      item("assistant_message", { turnId }),
    ];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(labels(rows)).toEqual([
      "user_message",
      "turn-fold",
      "user_message",
      "assistant_message",
      "turn-summary",
    ]);
    expect(rows[2].id).toBe(steer.itemId);
    expect(folds(rows)[0].id).toBe(`turn-fold:${user.itemId}`);
    // only the steered message is marked, live and settled
    const steered = (built: ReturnType<typeof buildTimeline>) =>
      built.rows.filter((row) => row.kind === "item" && row.steered === true).map((row) => row.id);
    expect(steered(buildTimeline(items, { turnActive: false }))).toEqual([steer.itemId]);
    expect(steered(buildTimeline(items, { turnActive: true }))).toEqual([steer.itemId]);

    // without turn ids the second message opens a turn of its own, by position
    const untagged = [
      item("user_message"),
      item("tool_call"),
      item("user_message"),
      item("tool_call"),
      item("assistant_message"),
    ];
    expect(folds(buildTimeline(untagged, { turnActive: false }).rows)).toHaveLength(2);
  });

  it("folds everything of a turn with no answer and keeps its error in view", () => {
    const items = [
      item("user_message"),
      item("reasoning"),
      item("command_execution", { status: "failed" }),
      item("error", { status: "failed" }),
      item("tool_call"),
    ];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(labels(rows)).toEqual(["user_message", "turn-fold", "error"]);
    expect(folds(rows)[0].failedCount).toBe(1);
    expect(rows.some((row) => row.kind === "item" && row.turnEnd !== undefined)).toBe(false);
  });

  it("folds the narration of a turn that ended in work rather than calling it the answer", () => {
    const narration = item("assistant_message", { text: "Now let me run the tests." });
    const items = [
      item("user_message"),
      narration,
      item("command_execution"),
      item("command_execution", { status: "failed" }),
    ];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(labels(rows)).toEqual(["user_message", "turn-fold"]);
    expect(folds(rows)[0].failedCount).toBe(1);
    expect(rows.some((row) => row.kind === "item" && row.turnEnd !== undefined)).toBe(false);

    // opened, the narration is back in its place, before the commands
    const opened = buildTimeline(items, { turnActive: false, ...open }).rows;
    expect(labels(opened)).toEqual([
      "user_message",
      "turn-fold",
      "assistant_message",
      "work-group",
    ]);
    expect(opened.some((row) => row.kind === "item" && row.turnEnd !== undefined)).toBe(false);
  });

  it("folds an interrupted turn's narration and keeps its error in view", () => {
    const items = [
      item("user_message"),
      item("assistant_message", { text: "I'll look at the config." }),
      item("tool_call"),
      item("error", { status: "failed", text: "Interrupted" }),
    ];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(labels(rows)).toEqual(["user_message", "turn-fold", "error"]);
    expect(rows.some((row) => row.kind === "item" && row.turnEnd !== undefined)).toBe(false);
  });

  it("keeps a last message as the answer when only records and errors follow it", () => {
    const answer = item("assistant_message");
    const items = [item("user_message"), item("tool_call"), answer, item("todo"), item("error")];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(labels(rows)).toEqual([
      "user_message",
      "turn-fold",
      "assistant_message",
      "todo",
      "error",
    ]);
    const answerRow = rows.find((row) => row.id === answer.itemId);
    expect(answerRow?.kind === "item" && answerRow.turnEnd !== undefined).toBe(true);
  });

  it("gives a leading run without a user message work groups and no fold", () => {
    const items = [
      item("reasoning"),
      item("tool_call"),
      item("assistant_message"),
      item("user_message"),
      item("tool_call"),
      item("assistant_message"),
    ];
    const { rows } = buildTimeline(items, { turnActive: false });
    expect(labels(rows)).toEqual([
      "work-group",
      "assistant_message",
      "user_message",
      "turn-fold",
      "assistant_message",
    ]);
  });
});
