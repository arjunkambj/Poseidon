import type { GitBranchList } from "@poseidon/contracts/git";
import type { GitStatus } from "@poseidon/contracts/rpc";
import { describe, expect, it } from "vitest";

import { TURN_RUNNING_REASON } from "./git-actions";
import { nextGitStep } from "./git-next-step";

const CHANGED: GitStatus = {
  branch: "poseidon/fix-login",
  upstream: null,
  ahead: 0,
  behind: 0,
  isRepository: true,
  files: [
    { path: "src/login.ts", status: "modified", staged: false },
    { path: "notes.txt", status: "untracked", staged: false },
  ],
};

const CLEAN: GitStatus = { ...CHANGED, files: [] };

const PUSHED: GitStatus = { ...CLEAN, upstream: "origin/poseidon/fix-login" };

const BRANCHES: GitBranchList = {
  isRepository: true,
  current: "poseidon/fix-login",
  defaultBranch: "main",
  remotes: ["origin"],
  branches: [
    { name: "main", kind: "local", isCurrent: false },
    { name: "poseidon/fix-login", kind: "local", isCurrent: true },
  ],
};

const NO_REMOTE: GitBranchList = { ...BRANCHES, remotes: [] };

const PR_URL = "https://github.com/acme/app/pull/7";

const step = (
  status: GitStatus,
  options: {
    readonly branches?: GitBranchList;
    readonly turnRunning?: boolean;
    readonly pullRequestUrl?: string | null;
  } = {},
) =>
  nextGitStep({
    status,
    branches: options.branches ?? BRANCHES,
    turnRunning: options.turnRunning ?? false,
    pullRequestUrl: options.pullRequestUrl ?? null,
  });

describe("nextGitStep", () => {
  it("commits a dirty tree, with the changed-file count as the badge", () => {
    expect(step(CHANGED)).toEqual({
      step: "commit",
      action: "commit",
      label: "Commit",
      badge: "2",
      reason: null,
    });
    // Changes come first even when a pull request is known.
    expect(step(CHANGED, { pullRequestUrl: PR_URL }).step).toBe("commit");
  });

  it("pushes a clean branch that is ahead, with the commits ahead as the badge", () => {
    expect(step({ ...PUSHED, ahead: 2 })).toEqual({
      step: "push",
      action: "commit-push",
      label: "Push",
      badge: "↑2",
      reason: null,
    });
  });

  it("pushes a clean branch with no upstream yet, without a badge", () => {
    expect(step(CLEAN)).toEqual({
      step: "push",
      action: "commit-push",
      label: "Push",
      badge: null,
      reason: null,
    });
  });

  it("falls back to a disabled Commit on a clean tree with no remote", () => {
    expect(step(CLEAN, { branches: NO_REMOTE })).toEqual({
      step: "commit",
      action: "commit",
      label: "Commit",
      badge: null,
      reason: "No changes to commit.",
    });
  });

  it("offers a pull request for a pushed feature branch with none known", () => {
    expect(step(PUSHED)).toEqual({
      step: "create-pr",
      action: "commit-push-pr",
      label: "Create PR",
      badge: null,
      reason: null,
    });
  });

  it("views the known pull request, even while a turn runs", () => {
    const view = {
      step: "view-pr",
      action: null,
      label: "View PR",
      badge: null,
      reason: null,
    };
    expect(step(PUSHED, { pullRequestUrl: PR_URL })).toEqual(view);
    expect(step(PUSHED, { pullRequestUrl: PR_URL, turnRunning: true })).toEqual(view);
  });

  it("offers nothing on a clean, pushed default branch", () => {
    const status: GitStatus = { ...CLEAN, branch: "main", upstream: "origin/main" };
    expect(step(status)).toMatchObject({
      step: "commit",
      badge: null,
      reason: "No changes to commit.",
    });
  });

  it("offers a push that is disabled until the branch pulls when it is also behind", () => {
    expect(step({ ...PUSHED, ahead: 1, behind: 3 })).toEqual({
      step: "push",
      action: "commit-push",
      label: "Push",
      badge: "↑1",
      reason: "The branch is behind origin/poseidon/fix-login — pull first.",
    });
  });

  it("disables the commit while a turn runs", () => {
    expect(step(CHANGED, { turnRunning: true })).toMatchObject({
      step: "commit",
      badge: "2",
      reason: TURN_RUNNING_REASON,
    });
  });

  it("does not push a detached HEAD", () => {
    expect(step({ ...CLEAN, branch: null })).toMatchObject({
      step: "commit",
      reason: "No changes to commit.",
    });
  });
});
