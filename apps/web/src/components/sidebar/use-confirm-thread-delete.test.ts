import { describe, expect, it } from "vitest";

import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { requestThreadDelete } from "./use-confirm-thread-delete";

const thread = (id: string, worktreePath?: string): ThreadSummary =>
  ({
    threadId: id as ThreadId,
    projectId: "project-a" as ProjectId,
    title: `Thread ${id}`,
    status: "idle",
    awaitingInput: false,
    createdAt: "2026-09-28T10:00:00Z",
    updatedAt: "2026-09-28T10:00:00Z",
    ...(worktreePath === undefined
      ? {}
      : { worktree: { path: worktreePath, branch: `poseidon/${id}` } }),
  }) as ThreadSummary;

const run = (confirm: boolean, targets: ReadonlyArray<ThreadSummary>, threads = targets) => {
  const log: Array<string> = [];
  const deleted = requestThreadDelete({
    confirm,
    targets,
    threads,
    openDialog: () => log.push("dialog"),
    remove: (target, removeWorktree) =>
      log.push(`delete ${target.threadId}${removeWorktree ? " +worktree" : ""}`),
  });
  return { deleted, log };
};

describe("requestThreadDelete", () => {
  it("opens the confirmation and deletes nothing while the setting asks first", () => {
    expect(run(true, [thread("t1", "/wt/a")])).toEqual({ deleted: false, log: ["dialog"] });
  });

  it("deletes at once when the setting is off, removing the worktree as the dialog would", () => {
    expect(run(false, [thread("t1", "/wt/a"), thread("t2")])).toEqual({
      deleted: true,
      log: ["delete t1 +worktree", "delete t2"],
    });
  });

  it("keeps a worktree another thread still works in", () => {
    const sibling = thread("t9", "/wt/a");
    const target = thread("t1", "/wt/a");
    expect(run(false, [target], [target, sibling]).log).toEqual(["delete t1"]);
  });

  it("removes a worktree shared only among the deleted threads once, by the last", () => {
    const first = thread("t1", "/wt/a");
    const second = thread("t2", "/wt/a");
    expect(run(false, [first, second]).log).toEqual(["delete t1", "delete t2 +worktree"]);
  });
});
