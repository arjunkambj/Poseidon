/**
 * The turn's usage from the thread's running token total, against the
 * `resume` recording: its second process restates the first turn's total as
 * it resumes, before its own turn runs.
 */

import { makeTurnId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "vitest";

import { recordedNotifications } from "../../test/frames";
import { asRecord } from "./pending";
import { makeUsageTracker } from "./usage";

const usageUpdates = (launch: number) =>
  recordedNotifications("resume", launch)
    .filter((notification) => notification.method === "thread/tokenUsage/updated")
    .map((notification) => asRecord(notification.params));

const inputOf = (params: ReturnType<typeof usageUpdates>[number]) =>
  Number(asRecord(asRecord(params.tokenUsage).total).inputTokens);

describe("makeUsageTracker", () => {
  it("measures a fresh thread's first turn from nothing", () => {
    const [update] = usageUpdates(0);
    const tracker = makeUsageTracker();
    tracker.startTurn();
    const [usage, context] = tracker.update(update!, makeTurnId());
    expect(usage?.type === "usage.updated" && usage.payload.input + usage.payload.cacheRead).toBe(
      inputOf(update!),
    );
    expect(context?.type).toBe("context.updated");
  });

  it("measures a resumed thread's turn from the total the resume restated", () => {
    const [restated, turnUpdate] = usageUpdates(1);
    const tracker = makeUsageTracker();
    // Outside any turn: only the context, and the total is remembered.
    expect(tracker.update(restated!, null).map((event) => event.type)).toEqual(["context.updated"]);
    tracker.startTurn();
    const [usage] = tracker.update(turnUpdate!, makeTurnId());
    expect(usage?.type === "usage.updated" && usage.payload.input + usage.payload.cacheRead).toBe(
      inputOf(turnUpdate!) - inputOf(restated!),
    );
  });
});
