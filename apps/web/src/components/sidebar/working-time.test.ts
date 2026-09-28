import { describe, expect, it } from "vitest";

import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { formatWorkingDuration, recedes, workingLabel } from "./working-time";

type Thread = Parameters<typeof recedes>[0];

const thread = (
  fields: Partial<Pick<ThreadSummary, "status" | "awaitingInput" | "awaiting" | "activity">>,
): Thread => ({
  status: fields.status ?? "idle",
  awaitingInput: fields.awaitingInput ?? false,
  awaiting: fields.awaiting,
  activity: fields.activity,
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("formatWorkingDuration", () => {
  it.each([
    [0, "<1m"],
    [59_999, "<1m"],
    [60_000, "1m"],
    [59 * MINUTE + 59_000, "59m"],
    [HOUR, "1h 0m"],
    [2 * HOUR, "2h 0m"],
    [HOUR + 4 * MINUTE, "1h 4m"],
    [25 * HOUR + 3 * MINUTE, "25h 3m"],
    [-5_000, "<1m"],
    [Number.NaN, "<1m"],
  ])("%d ms reads as %s", (ms, label) => {
    expect(formatWorkingDuration(ms)).toBe(label);
  });
});

describe("recedes", () => {
  it("a background running or thinking thread recedes", () => {
    expect(recedes(thread({ status: "running", activity: "working" }), false)).toBe(true);
    expect(recedes(thread({ status: "running", activity: "thinking" }), false)).toBe(true);
    expect(recedes(thread({ status: "running" }), false)).toBe(true);
  });

  it("the open thread never recedes", () => {
    expect(recedes(thread({ status: "running", activity: "working" }), true)).toBe(false);
  });

  it("a running thread with an approval pending does not recede", () => {
    expect(
      recedes(thread({ status: "running", awaitingInput: true, awaiting: "approval" }), false),
    ).toBe(false);
  });

  it("a plan ready, an error or an idle thread does not recede", () => {
    expect(
      recedes(thread({ status: "waiting", awaitingInput: true, awaiting: "plan" }), false),
    ).toBe(false);
    expect(recedes(thread({ status: "error" }), false)).toBe(false);
    expect(recedes(thread({ status: "idle" }), false)).toBe(false);
  });
});

describe("workingLabel", () => {
  const now = Date.parse("2026-09-28T12:00:00.000Z");

  it("is null without runningSince", () => {
    expect(workingLabel({}, now)).toBeNull();
  });

  it("is null when runningSince does not parse", () => {
    expect(workingLabel({ runningSince: "not a date" }, now)).toBeNull();
  });

  it("formats the time since the turn was requested", () => {
    expect(workingLabel({ runningSince: "2026-09-28T10:56:00.000Z" }, now)).toBe("1h 4m");
    expect(workingLabel({ runningSince: "2026-09-28T11:57:30.000Z" }, now)).toBe("2m");
  });
});
