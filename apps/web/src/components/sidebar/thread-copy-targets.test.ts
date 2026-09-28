import { describe, expect, it } from "vitest";

import type { ThreadId } from "@poseidon/contracts/ids";

import { threadCopyTargets } from "./thread-copy-targets";

const threadId = "thread-1" as ThreadId;
const project = { workspaceRoot: "/code/app" };

describe("threadCopyTargets", () => {
  it("offers a local thread's project folder and its id, and no branch", () => {
    expect(threadCopyTargets({ threadId }, project)).toEqual([
      { label: "Workspace path", value: "/code/app", what: "path" },
      { label: "Thread ID", value: "thread-1", what: "thread ID" },
    ]);
  });

  it("offers a worktree thread's worktree and branch over the project's folder", () => {
    const worktree = { path: "/worktrees/app/fix", branch: "fix/login" };
    expect(threadCopyTargets({ threadId, worktree }, project)).toEqual([
      { label: "Workspace path", value: "/worktrees/app/fix", what: "path" },
      { label: "Branch", value: "fix/login", what: "branch" },
      { label: "Thread ID", value: "thread-1", what: "thread ID" },
    ]);
  });

  it("offers only the id for an orphan thread with no worktree", () => {
    expect(threadCopyTargets({ threadId }, undefined)).toEqual([
      { label: "Thread ID", value: "thread-1", what: "thread ID" },
    ]);
  });

  it("still names an orphan worktree thread's worktree", () => {
    const worktree = { path: "/worktrees/app/fix", branch: "fix/login" };
    expect(threadCopyTargets({ threadId, worktree }, undefined).map((t) => t.label)).toEqual([
      "Workspace path",
      "Branch",
      "Thread ID",
    ]);
  });
});
