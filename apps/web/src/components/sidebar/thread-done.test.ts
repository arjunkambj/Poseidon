import { describe, expect, it } from "vitest";

import {
  canMarkDone,
  lastActivityOf,
  markDoneBlockedReason,
  selectionDoneBlockedReason,
  threadIsDone,
  type DoneCandidate,
} from "./thread-done";

const DAY = 86_400_000;
const at = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-09-01T00:00:00.000Z");

const thread = (fields: Partial<DoneCandidate> = {}): DoneCandidate => ({
  status: "idle",
  updatedAt: at(T0),
  lastActivityAt: at(T0),
  ...fields,
});

const off = { now: T0 + DAY, pinned: false };

describe("threadIsDone", () => {
  it("is done while the mark is at least as new as the last activity", () => {
    expect(threadIsDone(thread({ doneAt: at(T0) }), off)).toBe(true);
    expect(threadIsDone(thread({ doneAt: at(T0 + 1) }), off)).toBe(true);
  });

  it("comes back once there is newer activity than the mark", () => {
    expect(threadIsDone(thread({ doneAt: at(T0 - 1) }), off)).toBe(false);
  });

  it("is not done without a mark while the setting is off", () => {
    expect(threadIsDone(thread(), { ...off, now: T0 + 400 * DAY })).toBe(false);
    expect(threadIsDone(thread(), { ...off, now: T0 + 400 * DAY, autoDoneAfterDays: null })).toBe(
      false,
    );
  });

  it("moves a thread idle for the chosen days", () => {
    const context = { pinned: false, autoDoneAfterDays: 3 };
    expect(threadIsDone(thread(), { ...context, now: T0 + 3 * DAY - 1 })).toBe(false);
    expect(threadIsDone(thread(), { ...context, now: T0 + 3 * DAY })).toBe(true);
  });

  it("never puts a pinned thread in Done", () => {
    expect(threadIsDone(thread({ doneAt: at(T0) }), { ...off, pinned: true })).toBe(false);
    expect(threadIsDone(thread(), { now: T0 + 30 * DAY, autoDoneAfterDays: 1, pinned: true })).toBe(
      false,
    );
  });

  it("never puts an archived, running or waiting thread in Done", () => {
    for (const status of ["archived", "running", "waiting", "deleted"] as const) {
      expect(threadIsDone(thread({ status, doneAt: at(T0) }), off)).toBe(false);
    }
    expect(threadIsDone(thread({ status: "error", doneAt: at(T0) }), off)).toBe(true);
  });

  it("falls back to updatedAt for a summary without lastActivityAt", () => {
    const old = thread({ lastActivityAt: undefined, updatedAt: at(T0 + DAY) });
    expect(lastActivityOf(old)).toBe(at(T0 + DAY));
    expect(threadIsDone({ ...old, doneAt: at(T0) }, off)).toBe(false);
    expect(threadIsDone({ ...old, doneAt: at(T0 + DAY) }, off)).toBe(true);
    expect(threadIsDone(old, { now: T0 + 2 * DAY, autoDoneAfterDays: 1, pinned: false })).toBe(
      true,
    );
  });
});

describe("canMarkDone", () => {
  it("offers the mark only where it would show", () => {
    expect(canMarkDone(thread(), false)).toBe(true);
    expect(canMarkDone(thread(), true)).toBe(false);
    expect(canMarkDone(thread({ status: "running" }), false)).toBe(false);
    expect(canMarkDone(thread({ status: "archived" }), false)).toBe(false);
  });
});

describe("why Mark done does not apply", () => {
  it("names the reason for one thread", () => {
    expect(markDoneBlockedReason(thread(), false)).toBeNull();
    expect(markDoneBlockedReason(thread(), true)).toBe("Pinned");
    expect(markDoneBlockedReason(thread({ status: "running" }), false)).toBe("Running");
    expect(markDoneBlockedReason(thread({ status: "waiting" }), false)).toBe("Waiting");
    expect(markDoneBlockedReason(thread({ status: "archived" }), false)).toBe("Archived");
  });

  it("blocks a selection only when no picked thread would move", () => {
    const idle = thread();
    const busy = thread({ status: "running" });
    const finished = thread({ doneAt: at(T0) });
    const doneOnly = (each: DoneCandidate) => each === finished;
    const none = () => false;
    expect(selectionDoneBlockedReason([busy, idle], doneOnly, none)).toBeNull();
    expect(selectionDoneBlockedReason([busy, idle], doneOnly, (each) => each === idle)).toBe(
      "Pinned, running and waiting threads stay active",
    );
    expect(selectionDoneBlockedReason([busy, finished], doneOnly, none)).toContain("stay active");
    // Every one done already: the bar offers Mark active instead.
    expect(selectionDoneBlockedReason([finished], doneOnly, none)).toBeNull();
    expect(selectionDoneBlockedReason([], doneOnly, none)).toBeNull();
  });
});
