import { describe, expect, it } from "vitest";

import { type StepClock, tickStepClock } from "./use-step-ended-at";

const start = (id: string | undefined, running: boolean): StepClock => ({
  id,
  running,
  endedAt: undefined,
});

describe("tickStepClock", () => {
  it("stamps the moment a watched step stops running", () => {
    const clock = tickStepClock(start("a", true), "a", false, 4_000);
    expect(clock).toEqual({ id: "a", running: false, endedAt: 4_000 });
  });

  it("returns the same clock while nothing changes, so no render follows", () => {
    const running = start("a", true);
    expect(tickStepClock(running, "a", true, 1_000)).toBe(running);
    const ended = tickStepClock(running, "a", false, 4_000);
    expect(tickStepClock(ended, "a", false, 9_000)).toBe(ended);
  });

  it("has no end for a step first seen already finished", () => {
    expect(tickStepClock(start("a", false), "a", false, 4_000).endedAt).toBeUndefined();
    expect(tickStepClock(start("a", true), "b", false, 4_000)).toEqual(start("b", false));
  });

  it("starts over when the newest step changes", () => {
    const ended = tickStepClock(start("a", true), "a", false, 4_000);
    expect(tickStepClock(ended, "b", true, 5_000)).toEqual(start("b", true));
    expect(tickStepClock(ended, undefined, false, 5_000)).toEqual(start(undefined, false));
  });
});
