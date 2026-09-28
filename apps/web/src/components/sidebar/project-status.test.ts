import { describe, expect, it } from "vitest";

import type { ThreadSummary } from "@poseidon/contracts/orchestration";
import { AlertTriangle, Bell, ClipboardCheck, SpinnerOrbit, SpinnerWave } from "@honeyicons/react";

import { projectStatusRollup } from "./project-status";

type Thread = Parameters<typeof projectStatusRollup>[0][number];

let next = 0;
const thread = (
  fields: Partial<Pick<ThreadSummary, "status" | "awaitingInput" | "awaiting" | "activity">> & {
    threadId?: string;
  } = {},
): Thread =>
  ({
    threadId: fields.threadId ?? `thread-${next++}`,
    status: fields.status ?? "idle",
    awaitingInput: fields.awaitingInput ?? false,
    awaiting: fields.awaiting,
    activity: fields.activity,
  }) as Thread;

const needsYou = () => thread({ status: "waiting", awaitingInput: true, awaiting: "approval" });
const planReady = () => thread({ status: "waiting", awaitingInput: true, awaiting: "plan" });
const working = () => thread({ status: "running", activity: "working" });
const thinking = () => thread({ status: "running", activity: "thinking" });
const failed = () => thread({ status: "error" });

describe("projectStatusRollup", () => {
  it("needs-you beats a plan, a running turn and an error", () => {
    const rollup = projectStatusRollup([failed(), working(), planReady(), needsYou()], null);
    expect(rollup?.mark.icon).toBe(Bell);
    expect(rollup?.mark.tone).toBe("text-permission");
    expect(rollup?.count).toBe(1);
    expect(rollup?.label).toBe("1 thread needs you");
  });

  it("a plan beats a running turn and an error", () => {
    const rollup = projectStatusRollup([failed(), working(), planReady()], null);
    expect(rollup?.mark.icon).toBe(ClipboardCheck);
    expect(rollup?.label).toBe("1 thread has a plan ready");
  });

  it("a running turn beats an error", () => {
    const rollup = projectStatusRollup([failed(), working()], null);
    expect(rollup?.mark.icon).toBe(SpinnerWave);
    expect(rollup?.label).toBe("1 thread working");
  });

  it("an error is reported when nothing else is", () => {
    const rollup = projectStatusRollup([thread(), failed()], null);
    expect(rollup?.mark.icon).toBe(AlertTriangle);
    expect(rollup?.mark.tone).toBe("text-destructive");
    expect(rollup?.label).toBe("1 thread failed");
  });

  it("counts only the winning tier", () => {
    const rollup = projectStatusRollup(
      [needsYou(), working(), needsYou(), failed(), needsYou()],
      null,
    );
    expect(rollup?.count).toBe(3);
    expect(rollup?.label).toBe("3 threads need you");
  });

  it("working and thinking share one tier, and the first one's mark shows", () => {
    const rollup = projectStatusRollup([thinking(), working()], null);
    expect(rollup?.mark.icon).toBe(SpinnerOrbit);
    expect(rollup?.count).toBe(2);
    expect(rollup?.label).toBe("2 threads working");
  });

  it("an approval pending while the turn still runs counts as needs-you", () => {
    const rollup = projectStatusRollup(
      [working(), thread({ status: "running", awaitingInput: true, awaiting: "approval" })],
      null,
    );
    expect(rollup?.mark.icon).toBe(Bell);
    expect(rollup?.label).toBe("1 thread needs you");
  });

  it("ignores the open thread, which stays listed with its own mark", () => {
    const open = thread({ threadId: "open", status: "waiting", awaitingInput: true });
    expect(projectStatusRollup([open, working()], "open")?.label).toBe("1 thread working");
    expect(projectStatusRollup([open], "open")).toBeNull();
  });

  it("ignores archived and deleted threads", () => {
    expect(
      projectStatusRollup(
        [
          thread({ status: "archived", awaitingInput: true, awaiting: "approval" }),
          thread({ status: "deleted", awaitingInput: true }),
        ],
        null,
      ),
    ).toBeNull();
  });

  it("reports nothing when every thread is idle, or there are none", () => {
    expect(projectStatusRollup([thread(), thread()], null)).toBeNull();
    expect(projectStatusRollup([], null)).toBeNull();
  });

  it("uses plural labels for more than one thread", () => {
    expect(projectStatusRollup([planReady(), planReady()], null)?.label).toBe(
      "2 threads have a plan ready",
    );
    expect(projectStatusRollup([failed(), failed()], null)?.label).toBe("2 threads failed");
  });
});
