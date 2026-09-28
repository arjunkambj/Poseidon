/**
 * Plan mode: what `turn/start` names for each turn, and the plan a recorded
 * plan turn hands over (`plan-accept`, `question`) becoming the plan row and
 * `turn.plan.proposed`.
 */

import { makeTurnId, type TurnId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "vitest";

import { recordedNotifications } from "../test/frames";
import { collaborationModeFor, makePlanTracker } from "./plans";
import type { PendingRuntimeEvent } from "./translate/pending";
import { makeTranslator } from "./translate/translator";

/** A recording's notifications, each turn under a turn id of its own. */
const byTurn = (scenario: string): ReadonlyArray<ReadonlyArray<PendingRuntimeEvent>> => {
  const translator = makeTranslator({ loginCommand: "codex login" });
  const turns: Array<Array<PendingRuntimeEvent>> = [[]];
  let turnId: TurnId = makeTurnId();
  for (const notification of recordedNotifications(scenario)) {
    turns.at(-1)!.push(...translator.translate(notification, { turnId, interrupted: false }));
    if (notification.method === "turn/completed") {
      turns.push([]);
      turnId = makeTurnId();
    }
  }
  return turns.filter((events) => events.length > 0);
};

describe("collaborationModeFor", () => {
  const base = { model: "gpt-6-astra", effort: undefined } as const;

  it("names plan for a plan turn, with the model and the built-in instructions", () => {
    expect(collaborationModeFor({ ...base, mode: "plan", carried: false })).toEqual({
      mode: "plan",
      settings: { model: "gpt-6-astra", reasoning_effort: null, developer_instructions: null },
    });
    expect(
      collaborationModeFor({ ...base, mode: "plan", carried: true, effort: "low" })?.settings
        .reasoning_effort,
    ).toBe("low");
  });

  it("names default on a thread that carries a mode, and nothing on one that never did", () => {
    expect(collaborationModeFor({ ...base, mode: "default", carried: false })).toBeUndefined();
    expect(collaborationModeFor({ ...base, mode: "default", carried: true })).toEqual({
      mode: "default",
      settings: { model: "gpt-6-astra", reasoning_effort: null, developer_instructions: null },
    });
  });
});

describe("makePlanTracker", () => {
  it("gives the last plan once, trimmed, and nothing for a blank one", () => {
    const tracker = makePlanTracker();
    tracker.completed("  ");
    expect(tracker.take()).toBeUndefined();
    tracker.completed("1. first\n");
    tracker.completed("1. second\n");
    expect(tracker.take()).toBe("1. second");
    expect(tracker.take()).toBeUndefined();
  });
});

describe("a recorded plan turn, translated", () => {
  it("settles the plan row and proposes its markdown just before the turn ends", () => {
    const [planTurn, implementTurn] = byTurn("plan-accept");
    const types = planTurn!.map((event) => event.type);
    expect(types.slice(-2)).toEqual(["turn.plan.proposed", "turn.completed"]);
    const row = planTurn!.flatMap((event) =>
      event.type === "item.completed" && event.payload.item.kind === "plan"
        ? [event.payload.item]
        : [],
    );
    expect(row).toHaveLength(1);
    const proposed = planTurn!.find((event) => event.type === "turn.plan.proposed");
    expect(proposed?.type === "turn.plan.proposed" && proposed.payload.planMarkdown).toBe(
      row[0]!.plan?.markdown.trim(),
    );
    expect(row[0]!.plan?.markdown).toContain("hello.txt");
    // The accepted plan's implementation proposes nothing.
    expect(implementTurn!.some((event) => event.type === "turn.plan.proposed")).toBe(false);
  });

  it("proposes no plan for a turn that did not end end_turn", () => {
    const translator = makeTranslator({ loginCommand: "codex login" });
    const turn = { turnId: makeTurnId(), interrupted: true };
    const plan = recordedNotifications("plan-accept").find(
      (notification) =>
        notification.method === "item/completed" &&
        (notification.params as { item: { type: string } }).item.type === "plan",
    )!;
    translator.translate(plan, turn);
    const events = translator.translate(
      { method: "turn/completed", params: { turn: { id: "t", status: "interrupted" } } },
      turn,
    );
    expect(events.map((event) => event.type)).toEqual(["turn.completed"]);
  });
});
