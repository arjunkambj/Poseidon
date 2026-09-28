import type { GitBranchList, GitCommitResult } from "@poseidon/contracts/git";
import type { GitStatus } from "@poseidon/contracts/rpc";
import { describe, expect, it } from "vitest";

import {
  availableActions,
  commitMessageDraft,
  commitSelection,
  gitStartOf,
  planGitAction,
  planWithoutCommit,
  pullRequestFromMessage,
  pullRequestTitleDraft,
  pushTargetOf,
  runGitSteps,
  stepsLabel,
  TURN_RUNNING_REASON,
  type GitStep,
  type GitStepCalls,
  type StepNotice,
} from "./git-actions";

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

const TRACKED = { upstream: "origin/poseidon/fix-login" };

describe("planGitAction", () => {
  it("commits only when something changed", () => {
    expect(planGitAction("commit", CHANGED, BRANCHES)).toEqual(["commit"]);
    expect(planGitAction("commit", CLEAN, BRANCHES)).toEqual([]);
  });

  it("pushes after a commit, and a clean branch only when it has no upstream or is ahead", () => {
    expect(planGitAction("commit-push", CHANGED, BRANCHES)).toEqual(["commit", "push"]);
    expect(planGitAction("commit-push", { ...CHANGED, ...TRACKED }, BRANCHES)).toEqual([
      "commit",
      "push",
    ]);
    // Never pushed: the push sets the upstream.
    expect(planGitAction("commit-push", CLEAN, BRANCHES)).toEqual(["push"]);
    expect(planGitAction("commit-push", { ...CLEAN, ...TRACKED, ahead: 2 }, BRANCHES)).toEqual([
      "push",
    ]);
    // Up to date with its upstream: nothing to do.
    expect(planGitAction("commit-push", { ...CLEAN, ...TRACKED }, BRANCHES)).toEqual([]);
  });

  it("adds the pull request last, and alone for a branch that is already pushed", () => {
    expect(planGitAction("commit-push-pr", CHANGED, BRANCHES)).toEqual(["commit", "push", "pr"]);
    expect(planGitAction("commit-push-pr", { ...CLEAN, ...TRACKED }, BRANCHES)).toEqual(["pr"]);
  });

  it("neither pushes nor opens a pull request without a remote", () => {
    expect(planGitAction("commit-push", CHANGED, NO_REMOTE)).toEqual(["commit"]);
    expect(planGitAction("commit-push-pr", CHANGED, NO_REMOTE)).toEqual(["commit"]);
    expect(planGitAction("commit-push-pr", CLEAN, NO_REMOTE)).toEqual([]);
  });

  it("picks the only remote when it is not origin, and none of several without origin", () => {
    const lone = { ...BRANCHES, remotes: ["fork"] };
    expect(planGitAction("commit-push", CLEAN, lone)).toEqual(["push"]);
    expect(pushTargetOf(CLEAN, lone)).toBe("fork/poseidon/fix-login");
    const several = { ...BRANCHES, remotes: ["fork", "team"] };
    expect(planGitAction("commit-push", CLEAN, several)).toEqual([]);
    expect(pushTargetOf(CLEAN, several)).toBeNull();
    expect(pushTargetOf({ ...CLEAN, ...TRACKED }, several)).toBe("origin/poseidon/fix-login");
  });
});

describe("planWithoutCommit", () => {
  it("keeps the push and the pull request when the user commits nothing", () => {
    expect(planWithoutCommit("commit-push-pr", CHANGED, BRANCHES)).toEqual(["push", "pr"]);
    expect(planWithoutCommit("commit-push-pr", { ...CHANGED, ...TRACKED }, BRANCHES)).toEqual([
      "pr",
    ]);
    expect(planWithoutCommit("commit-push", { ...CHANGED, ...TRACKED }, BRANCHES)).toEqual([]);
    expect(planWithoutCommit("commit", CHANGED, BRANCHES)).toEqual([]);
  });

  it("labels what is left to run", () => {
    expect(stepsLabel(["push", "pr"])).toBe("Push & create PR");
    expect(stepsLabel(["push"])).toBe("Push");
    expect(stepsLabel(["pr"])).toBe("Create PR");
    expect(stepsLabel([])).toBeNull();
  });
});

describe("availableActions", () => {
  const available = (status: GitStatus, branches = BRANCHES, turnRunning = false) =>
    availableActions({ status, branches, turnRunning });

  it("offers everything for a changed branch with a remote", () => {
    expect(available(CHANGED)).toEqual({
      commit: null,
      "commit-push": null,
      "commit-push-pr": null,
    });
  });

  it("says why on a clean tree with nothing to push", () => {
    const upToDate = available({ ...CLEAN, ...TRACKED });
    expect(upToDate.commit).toBe("No changes to commit.");
    expect(upToDate["commit-push"]).toBe("No changes, and nothing to push.");
    // The branch is pushed; a pull request can still be opened for it.
    expect(upToDate["commit-push-pr"]).toBeNull();
  });

  it("refuses everything while a turn runs, and outside a repository", () => {
    for (const reason of Object.values(available(CHANGED, BRANCHES, true))) {
      expect(reason).toBe(TURN_RUNNING_REASON);
    }
    const repoless = available({ ...CLEAN, branch: null, isRepository: false });
    expect(repoless.commit).toBe("This folder is not a git repository.");
    expect(repoless["commit-push-pr"]).toBe("This folder is not a git repository.");
  });

  it("commits on a detached HEAD but does not push from one", () => {
    const detached = available({ ...CHANGED, branch: null }, { ...BRANCHES, current: null });
    expect(detached.commit).toBeNull();
    expect(detached["commit-push"]).toBe("HEAD is detached — switch to a branch to push.");
    expect(detached["commit-push-pr"]).toBe("HEAD is detached — switch to a branch to push.");
  });

  it("does not push without a remote, or while the branch is behind its upstream", () => {
    const orphan = available(CHANGED, NO_REMOTE);
    expect(orphan.commit).toBeNull();
    expect(orphan["commit-push"]).toBe("This repository has no remote to push to.");
    const behind = available({ ...CHANGED, ...TRACKED, behind: 1 });
    expect(behind.commit).toBeNull();
    expect(behind["commit-push"]).toBe(
      "The branch is behind origin/poseidon/fix-login — pull first.",
    );
  });

  it("does not open a pull request from the default branch", () => {
    const onMain = available({ ...CHANGED, branch: "main" }, { ...BRANCHES, current: "main" });
    expect(onMain["commit-push"]).toBeNull();
    expect(onMain["commit-push-pr"]).toMatch(/default branch, main/);
  });

  it("does not open a pull request when gh cannot, and says why", () => {
    const noGh = availableActions({
      status: CHANGED,
      branches: BRANCHES,
      turnRunning: false,
      pullRequestBlocker:
        "gh is not authenticated: run gh auth login in a terminal, then try again.",
    });
    expect(noGh.commit).toBeNull();
    expect(noGh["commit-push"]).toBeNull();
    expect(noGh["commit-push-pr"]).toMatch(/gh auth login/);
  });
});

describe("gitStartOf", () => {
  const start = (
    action: "commit" | "commit-push" | "commit-push-pr",
    status: GitStatus,
    dialogOpen = false,
    reason: string | null = null,
  ) => gitStartOf({ action, status, branches: BRANCHES, reason, dialogOpen });

  it("opens the commit dialog for anything that commits, else the pull request dialog or a run", () => {
    expect(start("commit-push", CHANGED)).toBe("commit-dialog");
    expect(start("commit-push-pr", { ...CLEAN, ...TRACKED })).toBe("pull-request-dialog");
    expect(start("commit-push", { ...CLEAN, ...TRACKED, ahead: 2 })).toBe("run");
  });

  it("does nothing while the action cannot run", () => {
    expect(start("commit", CHANGED, false, TURN_RUNNING_REASON)).toBe("ignore");
  });

  // Mod+Alt+C or Mod+Alt+P pressed in the commit dialog's message box must not
  // reopen it: a fresh dialog would drop the typed message and the unticked files.
  it("does nothing while a dialog is already up", () => {
    expect(start("commit", CHANGED, true)).toBe("ignore");
    expect(start("commit-push", CHANGED, true)).toBe("ignore");
  });
});

const COMMIT: GitCommitResult = {
  sha: "abc1234def5678900000000000000000000000000",
  subject: "Fix the login",
  branch: "poseidon/fix-login",
};

/** Calls that answer from a script and log the order they ran in. */
const scripted = (fail: GitStep | null, log: Array<GitStep>): GitStepCalls => ({
  commit: async () => {
    log.push("commit");
    return fail === "commit"
      ? { ok: false, message: "Nothing to commit." }
      : { ok: true, value: COMMIT };
  },
  push: async () => {
    log.push("push");
    return fail === "push"
      ? { ok: false, message: "rejected: fetch first" }
      : { ok: true, value: { remote: "origin", branch: "poseidon/fix-login", setUpstream: true } };
  },
  pr: async () => {
    log.push("pr");
    return fail === "pr"
      ? { ok: false, message: "gh not available: install the GitHub CLI and run gh auth login" }
      : { ok: true, value: { url: "https://github.com/acme/app/pull/7", created: true } };
  },
});

describe("runGitSteps", () => {
  it("runs every step in order with one loading and one final notice each", async () => {
    const log: Array<GitStep> = [];
    const notices: Array<StepNotice> = [];
    const result = await runGitSteps(
      ["commit", "push", "pr"],
      scripted(null, log),
      (notice) => notices.push(notice),
      "origin/poseidon/fix-login",
    );
    expect(log).toEqual(["commit", "push", "pr"]);
    expect(notices).toEqual([
      { step: "commit", phase: "loading", message: "Committing…" },
      { step: "commit", phase: "success", message: "Committed abc1234" },
      { step: "push", phase: "loading", message: "Pushing to origin/poseidon/fix-login…" },
      {
        step: "push",
        phase: "success",
        message: "Pushed to origin/poseidon/fix-login and set it as the upstream",
      },
      { step: "pr", phase: "loading", message: "Creating pull request…" },
      {
        step: "pr",
        phase: "success",
        message: "Pull request created",
        url: "https://github.com/acme/app/pull/7",
      },
    ]);
    expect(result).toEqual({
      commit: COMMIT,
      push: { remote: "origin", branch: "poseidon/fix-login", setUpstream: true },
      pullRequest: { url: "https://github.com/acme/app/pull/7", created: true },
      failed: null,
    });
  });

  it("stops at a failed commit and never pushes", async () => {
    const log: Array<GitStep> = [];
    const notices: Array<StepNotice> = [];
    const result = await runGitSteps(["commit", "push", "pr"], scripted("commit", log), (notice) =>
      notices.push(notice),
    );
    expect(log).toEqual(["commit"]);
    expect(notices).toEqual([
      { step: "commit", phase: "loading", message: "Committing…" },
      { step: "commit", phase: "error", message: "Commit failed: Nothing to commit." },
    ]);
    expect(result).toEqual({ failed: "commit" });
  });

  it("stops at a failed push and keeps the commit it made", async () => {
    const log: Array<GitStep> = [];
    const notices: Array<StepNotice> = [];
    const result = await runGitSteps(["commit", "push", "pr"], scripted("push", log), (notice) =>
      notices.push(notice),
    );
    expect(log).toEqual(["commit", "push"]);
    expect(notices.at(-1)).toEqual({
      step: "push",
      phase: "error",
      message: "Push failed: rejected: fetch first",
    });
    expect(notices.filter((notice) => notice.step === "pr")).toEqual([]);
    expect(result).toEqual({ commit: COMMIT, failed: "push" });
  });

  it("shows the server's gh message when the pull request cannot be opened", async () => {
    const notices: Array<StepNotice> = [];
    const result = await runGitSteps(["pr"], scripted("pr", []), (notice) => notices.push(notice));
    expect(notices).toEqual([
      { step: "pr", phase: "loading", message: "Creating pull request…" },
      {
        step: "pr",
        phase: "error",
        message:
          "Pull request failed: gh not available: install the GitHub CLI and run gh auth login",
      },
    ]);
    expect(result).toEqual({ failed: "pr" });
  });

  it("reports an open pull request's link, and a push without a known target", async () => {
    const notices: Array<StepNotice> = [];
    const calls: GitStepCalls = {
      ...scripted(null, []),
      push: async () => ({
        ok: true,
        value: { remote: "origin", branch: "poseidon/fix-login", setUpstream: false },
      }),
      pr: async () => ({
        ok: true,
        value: { url: "https://github.com/acme/app/pull/3", created: false },
      }),
    };
    const result = await runGitSteps(["push", "pr"], calls, (notice) => notices.push(notice));
    expect(notices).toEqual([
      { step: "push", phase: "loading", message: "Pushing…" },
      { step: "push", phase: "success", message: "Pushed to origin/poseidon/fix-login" },
      { step: "pr", phase: "loading", message: "Creating pull request…" },
      {
        step: "pr",
        phase: "success",
        message: "Pull request already open",
        url: "https://github.com/acme/app/pull/3",
      },
    ]);
    expect(result.pullRequest?.url).toBe("https://github.com/acme/app/pull/3");
  });

  it("treats a call that throws as a failure of its step", async () => {
    const log: Array<GitStep> = [];
    const notices: Array<StepNotice> = [];
    const calls: GitStepCalls = {
      ...scripted(null, log),
      commit: () => Promise.reject(new Error("socket closed")),
    };
    const result = await runGitSteps(["commit", "push"], calls, (notice) => notices.push(notice));
    expect(log).toEqual([]);
    expect(notices.at(-1)).toEqual({
      step: "commit",
      phase: "error",
      message: "Commit failed: socket closed",
    });
    expect(result.failed).toBe("commit");
  });
});

describe("commitMessageDraft", () => {
  it("counts the files while the thread still has the default title", () => {
    expect(commitMessageDraft("New thread", ["src/login.ts", "notes.txt"])).toBe(
      "Update 2 files\n\nChanged files:\n- src/login.ts\n- notes.txt",
    );
    expect(commitMessageDraft("  ", ["a.ts"])).toBe("Update 1 file\n\nChanged files:\n- a.ts");
  });

  it("uses a real title as the subject", () => {
    expect(commitMessageDraft(" Fix the login redirect ", ["src/login.ts"])).toBe(
      "Fix the login redirect\n\nChanged files:\n- src/login.ts",
    );
  });
});

describe("commitSelection", () => {
  const files = [
    { path: "src/login.ts", status: "modified", staged: false },
    { path: "notes.txt", status: "untracked", staged: false },
    { path: "README.md", status: "modified", staged: false },
  ] as const;

  it("sends no paths and drafts every file while all are checked", () => {
    const all = commitSelection("New thread", files, new Set());
    expect(all.paths).toBeUndefined();
    expect(all.message).toBe(
      "Update 3 files\n\nChanged files:\n- src/login.ts\n- notes.txt\n- README.md",
    );
  });

  it("drafts only the files still checked once one is unchecked", () => {
    const some = commitSelection("New thread", files, new Set(["notes.txt"]));
    expect(some.paths).toEqual(["src/login.ts", "README.md"]);
    expect(some.message).toBe("Update 2 files\n\nChanged files:\n- src/login.ts\n- README.md");
    expect(some.message).not.toContain("notes.txt");
  });
});

describe("pull request drafts", () => {
  it("takes the title and body from the commit message", () => {
    expect(pullRequestFromMessage("Fix the login\n\nChanged files:\n- a.ts\n")).toEqual({
      title: "Fix the login",
      body: "Changed files:\n- a.ts",
    });
    expect(pullRequestFromMessage("Only a subject")).toEqual({ title: "Only a subject", body: "" });
  });

  it("titles a pull request alone from the thread, else the branch", () => {
    expect(pullRequestTitleDraft("Fix the login", "poseidon/fix-login")).toBe("Fix the login");
    expect(pullRequestTitleDraft("New thread", "poseidon/fix-login")).toBe("poseidon/fix-login");
    expect(pullRequestTitleDraft("New thread", null)).toBe("");
  });
});
