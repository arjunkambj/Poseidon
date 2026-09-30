import { describe, expect, it } from "vitest";

import type { ConnectorInstanceId, ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { blankLatestThread, withCreateSeed } from "./use-create-thread";

const A = "project-a" as ProjectId;
const B = "project-b" as ProjectId;

const thread = (
  id: string,
  createdAt: string,
  overrides: Partial<ThreadSummary> = {},
): ThreadSummary =>
  ({
    threadId: id as ThreadId,
    projectId: A,
    title: "New thread",
    status: "idle",
    settings: { model: "m", runtimeMode: "approval-required", interactionMode: "default" },
    awaitingInput: false,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  }) as ThreadSummary;

describe("blankLatestThread", () => {
  it("returns the project's newest thread while nothing has been said in it", () => {
    const threads = [thread("t1", "2026-09-19T10:00:00Z"), thread("t2", "2026-09-19T11:00:00Z")];
    expect(blankLatestThread(threads, A)?.threadId).toBe("t2");
  });

  it("returns nothing once the newest thread has a message", () => {
    const threads = [
      thread("t1", "2026-09-19T10:00:00Z"),
      thread("t2", "2026-09-19T11:00:00Z", { preview: "hello" }),
    ];
    expect(blankLatestThread(threads, A)).toBeUndefined();
  });

  it("returns nothing while the newest thread is running its first turn", () => {
    const threads = [thread("t1", "2026-09-19T10:00:00Z", { status: "running" })];
    expect(blankLatestThread(threads, A)).toBeUndefined();
  });

  it("ignores other projects and archived threads", () => {
    const threads = [
      thread("t1", "2026-09-19T10:00:00Z", { preview: "hi" }),
      thread("t2", "2026-09-19T11:00:00Z", { status: "archived" }),
      thread("t3", "2026-09-19T12:00:00Z", { projectId: B }),
    ];
    expect(blankLatestThread(threads, A)).toBeUndefined();
    expect(blankLatestThread(threads, B)?.threadId).toBe("t3");
  });

  it("returns nothing for a project with no threads", () => {
    expect(blankLatestThread([], A)).toBeUndefined();
  });

  it("returns nothing when the blank thread is bound to another harness", () => {
    const here = "instance-here" as ConnectorInstanceId;
    const there = "instance-there" as ConnectorInstanceId;
    const bound = thread("t1", "2026-09-19T10:00:00Z", {
      settings: {
        model: "m",
        runtimeMode: "approval-required",
        interactionMode: "default",
        connectorInstanceId: there,
      },
    });
    expect(blankLatestThread([bound], A, here)).toBeUndefined();
    expect(blankLatestThread([bound], A, there)?.threadId).toBe("t1");
    // No preference yet, or a thread bound to none: handed back as before.
    expect(blankLatestThread([bound], A)?.threadId).toBe("t1");
    expect(blankLatestThread([thread("t2", "2026-09-19T11:00:00Z")], A, here)?.threadId).toBe("t2");
  });
});

describe("withCreateSeed", () => {
  const seed = { model: "m1", connectorInstanceId: "b" as ConnectorInstanceId };

  it("seeds a create that names no model or instance, keeping what it does name", () => {
    expect(withCreateSeed(undefined, seed)).toEqual(seed);
    expect(withCreateSeed({ effort: "high" }, seed)).toEqual({ ...seed, effort: "high" });
  });

  it("leaves a create that names its model or instance as it is", () => {
    expect(withCreateSeed({ model: "m9" }, seed)).toEqual({ model: "m9" });
    const own = { connectorInstanceId: "a" as ConnectorInstanceId };
    expect(withCreateSeed(own, seed)).toEqual(own);
    expect(withCreateSeed(undefined, undefined)).toBeUndefined();
  });
});
