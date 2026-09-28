import type { ThreadWorktree } from "@poseidon/contracts/git";
import { makeTurnId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "vitest";

import {
  branchOffHere,
  forkBlockedReason,
  forkTitle,
  inNewWorktree,
  type BranchOffActions,
} from "./branch-off";
import { startInWorktree } from "./start-in-worktree";

const SOURCE: ThreadWorktree = { path: "/wt/app/login", branch: "poseidon/login" };
const NEW: ThreadWorktree = { path: "/wt/app/login-fork", branch: "poseidon/login-fork" };

/** Actions that log each call in order; `accept` is what the create answers. */
const recorder = ({ accept = true, first = false } = {}) => {
  const log: Array<string> = [];
  const actions: BranchOffActions = {
    createThread: async (worktree) => {
      log.push(`create in ${worktree?.branch ?? "the project's folder"}`);
      return accept;
    },
    ...(first ? { sendFirst: () => log.push("send first") } : {}),
    open: () => log.push("open"),
  };
  return { log, actions };
};

describe("branching off in the source's workspace", () => {
  it("creates in the source's worktree, then opens the thread", async () => {
    const { log, actions } = recorder();
    await expect(branchOffHere(actions, SOURCE)).resolves.toBe(true);
    expect(log).toEqual(["create in poseidon/login", "open"]);
  });

  it("creates a local source's fork in the project's folder", async () => {
    const { log, actions } = recorder();
    await branchOffHere(actions, undefined);
    expect(log).toEqual(["create in the project's folder", "open"]);
  });

  it("sends a first message before opening, when there is one", async () => {
    const { log, actions } = recorder({ first: true });
    await branchOffHere(actions, undefined);
    expect(log).toEqual(["create in the project's folder", "send first", "open"]);
  });

  it("stays put when the create is refused", async () => {
    const { log, actions } = recorder({ accept: false, first: true });
    await expect(branchOffHere(actions, SOURCE)).resolves.toBe(false);
    expect(log).toEqual(["create in poseidon/login"]);
  });
});

describe("branching off into a new worktree", () => {
  const steps = (actions: BranchOffActions, log: Array<string>, setupCode = 0) => ({
    createWorktree: async () => {
      log.push("worktree");
      return NEW;
    },
    runSetup: async () => {
      log.push("setup");
      return { output: "", exit: { code: setupCode }, skipped: false };
    },
    ...inNewWorktree(actions),
  });

  it("cuts the worktree and runs its setup before the create, the first message and the opening", async () => {
    const { log, actions } = recorder({ first: true });
    await expect(startInWorktree(steps(actions, log))).resolves.toEqual({
      _tag: "started",
      worktree: NEW,
    });
    expect(log).toEqual([
      "worktree",
      "setup",
      "create in poseidon/login-fork",
      "send first",
      "open",
    ]);
  });

  it("stops before the thread exists when the setup fails", async () => {
    const { log, actions } = recorder();
    const outcome = await startInWorktree(steps(actions, log, 1));
    expect(outcome._tag).toBe("setup-failed");
    expect(log).toEqual(["worktree", "setup"]);
  });
});

describe("the fork's title and when a message can be forked from", () => {
  it("titles a fork after its source", () => {
    expect(forkTitle("Fix login")).toBe("Fix login (fork)");
  });

  it("allows a settled message, and says why not while offline or while its turn runs", () => {
    const [settled, running] = [makeTurnId(), makeTurnId()];
    expect(
      forkBlockedReason({ connected: true, runningTurnId: running, turnId: settled }),
    ).toBeNull();
    expect(forkBlockedReason({ connected: true, runningTurnId: null, turnId: settled })).toBeNull();
    expect(
      forkBlockedReason({ connected: true, runningTurnId: running, turnId: running }),
    ).toContain("still running");
    expect(forkBlockedReason({ connected: false, runningTurnId: null, turnId: settled })).toBe(
      "Not connected to the server.",
    );
  });
});
