/**
 * The changes pane's selection rules: which comparison each scope and each
 * turn asks the server for, and which turn shows when none, or a gone one, is
 * picked.
 */

import { describe, expect, it } from "vitest";
import { makeCheckpointId, makeProjectId, makeThreadId, makeTurnId } from "@poseidon/contracts/ids";
import type { CheckpointSummary } from "@poseidon/contracts/orchestration";

import { branchBaseFor, checkpointLabel, diffRangeFor, pickTurn, turnRange } from "./selection";

const checkpoint = (ref: string, createdAt = "2026-01-01T09:30:00.000Z"): CheckpointSummary => ({
  checkpointId: makeCheckpointId(),
  turnId: makeTurnId(),
  ref,
  createdAt,
});

describe("changes pane selection", () => {
  it("diffs a turn from the checkpoint before it to its own, in the thread's root", () => {
    // The thread rides along so the server diffs its worktree, when it has one.
    const scope = { projectId: makeProjectId(), threadId: makeThreadId() };
    const first = checkpoint("refs/poseidon/checkpoints/t/1");
    const second = checkpoint("refs/poseidon/checkpoints/t/2");
    const turn = (previous: CheckpointSummary | undefined, shown: CheckpointSummary) =>
      diffRangeFor(scope, { scope: "turn", ...turnRange(previous, shown) });

    // The first turn has nothing before it, so it starts from HEAD — `from`
    // omitted, the server's default.
    expect(turn(undefined, first)).toEqual({ ...scope, to: first.ref });
    expect(turn(undefined, first)).not.toHaveProperty("from");
    // Every later turn starts where the one before it left off.
    expect(turn(first, second)).toEqual({ ...scope, from: first.ref, to: second.ref });
  });

  it("asks for a merge-base diff for Branch vs base, and nothing without a base", () => {
    const scope = { projectId: makeProjectId(), threadId: makeThreadId() };
    expect(diffRangeFor(scope, { scope: "branch", mergeBase: "origin/main" })).toEqual({
      ...scope,
      mergeBase: "origin/main",
    });
    expect(diffRangeFor(scope, { scope: "branch", mergeBase: null })).toBeNull();
  });

  it("diffs the working tree against HEAD for Uncommitted", () => {
    const scope = { projectId: makeProjectId(), threadId: makeThreadId() };
    const range = diffRangeFor(scope, { scope: "uncommitted" });
    expect(range).toEqual(scope);
    expect(range).not.toHaveProperty("from");
    expect(range).not.toHaveProperty("to");
    expect(range).not.toHaveProperty("mergeBase");
  });

  it("asks git to ignore whitespace only when the option is on", () => {
    const scope = { projectId: makeProjectId(), threadId: makeThreadId() };
    // Off: the same range, and so the same cached answer, as without the option.
    expect(diffRangeFor(scope, { scope: "uncommitted" }, false)).toEqual(scope);
    expect(diffRangeFor(scope, { scope: "uncommitted" }, false)).not.toHaveProperty(
      "ignoreWhitespace",
    );
    expect(diffRangeFor(scope, { scope: "uncommitted" }, true)).toEqual({
      ...scope,
      ignoreWhitespace: true,
    });
    expect(diffRangeFor(scope, { scope: "branch", mergeBase: "main" }, true)).toEqual({
      ...scope,
      mergeBase: "main",
      ignoreWhitespace: true,
    });
    expect(diffRangeFor(scope, { scope: "turn", from: null, to: "refs/x" }, true)).toEqual({
      ...scope,
      to: "refs/x",
      ignoreWhitespace: true,
    });
    // No base for Branch stays nothing to compare, whatever the option.
    expect(diffRangeFor(scope, { scope: "branch", mergeBase: null }, true)).toBeNull();
  });

  it("compares a worktree thread with its own base, else the default branch", () => {
    expect(branchBaseFor("origin/release", "main")).toBe("origin/release");
    expect(branchBaseFor(undefined, "main")).toBe("main");
    // The list has not answered yet, and a list that failed.
    expect(branchBaseFor(undefined, undefined)).toBeUndefined();
    expect(branchBaseFor(undefined, null)).toBeNull();
    // A recorded base does not wait for the list.
    expect(branchBaseFor("main", undefined)).toBe("main");
  });

  it("shows the picked turn while it exists, else the latest", () => {
    const first = checkpoint("refs/poseidon/checkpoints/t/1");
    const second = checkpoint("refs/poseidon/checkpoints/t/2");
    // Nothing picked follows the latest turn.
    expect(pickTurn([first, second], null)).toBe(1);
    expect(pickTurn([first, second], first.ref)).toBe(0);
    // A pruned ref never reaches git: the latest turn stands in.
    expect(pickTurn([first, second], "refs/poseidon/checkpoints/t/9")).toBe(1);
    // No checkpoints, no turn.
    expect(pickTurn([], null)).toBe(-1);
  });

  it("labels a checkpoint by its turn number, and survives a bad timestamp", () => {
    expect(checkpointLabel(checkpoint("refs/a"), 0)).toMatch(/^Turn 1 · /);
    expect(checkpointLabel(checkpoint("refs/a", "not a date"), 2)).toBe("Turn 3");
  });
});
