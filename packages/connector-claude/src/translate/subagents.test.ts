/**
 * The pieces a subagent's row is built from: how a task's state reads as a
 * row's status, the title a Task or Agent call gives its task, the hold that
 * keeps a subagent's messages until its task's row is open, and which `task_*`
 * messages are read at all. How the SDK's own messages become nested rows is
 * for the real CLI's recordings to prove, in `recordedFrames.test.ts` and
 * `recordedSession.test.ts` (`subagent`, `subagent-stop`).
 */

import { makeItemId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "vitest";

import { makeSubagents, settledTaskStatus, taskTitleOf, UNTITLED_TASK } from "./subagents";

describe("settledTaskStatus", () => {
  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["killed", "failed"],
    ["stopped", "failed"],
    ["running", null],
    ["pending", null],
    ["paused", null],
    [undefined, null],
  ] as const)("reads %s as %s", (status, settled) => {
    expect(settledTaskStatus(status)).toBe(settled);
  });
});

describe("taskTitleOf", () => {
  it("is the call's description", () => {
    expect(taskTitleOf({ description: "  List the files ", subagent_type: "Explore" })).toBe(
      "List the files",
    );
  });

  it("names the subagent's kind when there is no description", () => {
    expect(taskTitleOf({ description: "", subagent_type: "general-purpose" })).toBe(
      "general-purpose subagent",
    );
  });

  it("falls back to a plain title", () => {
    expect(taskTitleOf({})).toBe(UNTITLED_TASK);
  });
});

describe("the hold", () => {
  const first = { n: 1 };
  const second = { n: 2 };
  const other = { n: 3 };

  it("keeps each call's messages, in order, until its row is open", () => {
    const subagents = makeSubagents();
    subagents.hold("call-a", first);
    subagents.hold("call-b", other);
    subagents.hold("call-a", second);

    expect(subagents.takeReady(() => undefined)).toEqual([]);
    const open = new Set(["call-a"]);
    const rowOf = (id: string) =>
      open.has(id) ? { itemId: makeItemId(), kind: "task" } : undefined;
    expect(subagents.takeReady(rowOf)).toEqual([
      { toolUseId: "call-a", message: first },
      { toolUseId: "call-a", message: second },
    ]);
    // Taken once: the same call is not released twice.
    expect(subagents.takeReady(rowOf)).toEqual([]);
    expect(subagents.takeAll()).toEqual([other]);
  });

  it("lets go of everything at the end of the turn", () => {
    const subagents = makeSubagents();
    subagents.hold("call-a", first);
    subagents.hold("call-b", second);
    expect(subagents.takeAll()).toEqual([first, second]);
    expect(subagents.takeAll()).toEqual([]);
  });
});

describe("a task's start", () => {
  it("is announced once, with the call's title and model, under its parent task", () => {
    const subagents = makeSubagents();
    const itemId = makeItemId();
    const parent = makeItemId();
    const input = {
      description: "List the files",
      subagent_type: "general-purpose",
      model: "haiku",
    };
    expect(subagents.opened("call-a", itemId, input, parent)).toEqual([
      {
        type: "task.started",
        payload: {
          taskId: itemId,
          title: "List the files",
          status: "in_progress",
          parentItemId: parent,
          model: "haiku",
        },
      },
    ]);
    expect(subagents.opened("call-a", itemId, input, parent)).toEqual([]);
  });
});

describe("a task's lifecycle", () => {
  /** Never read: a call with no task row is refused before its message is. */
  const message = { n: 1 };

  it("reads nothing of a call whose row is not a task's, for the translator to keep unmapped", () => {
    // A background shell command's task_* messages name its Bash call.
    expect(makeSubagents().lifecycle("call-bash", message)).toBeNull();
  });
});

describe("the lifecycle of a call that is not a task", () => {
  // The shapes `steering` recorded for a foreground `sleep 5; echo one`.
  const started = {
    type: "system",
    subtype: "task_started",
    task_id: "b1",
    tool_use_id: "call-bash",
    task_type: "local_bash",
    is_backgrounded: false,
  };
  const notified = {
    type: "system",
    subtype: "task_notification",
    task_id: "b1",
    tool_use_id: "call-bash",
    status: "completed",
  };

  it("adds nothing for a foreground shell command, whose own result settles its row", () => {
    const subagents = makeSubagents();
    for (const message of [started, notified]) {
      expect(subagents.callOf(message)).toBe("call-bash");
      expect(subagents.lifecycle("call-bash", message)).toEqual([]);
    }
  });

  it("leaves a background command's messages unread", () => {
    const subagents = makeSubagents();
    const background = { ...started, is_backgrounded: true };
    expect(subagents.callOf(background)).toBe("call-bash");
    expect(subagents.lifecycle("call-bash", background)).toBeNull();
    expect(subagents.lifecycle("call-bash", notified)).toBeNull();
  });
});
