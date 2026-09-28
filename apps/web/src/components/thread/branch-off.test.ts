import type { ThreadWorktree } from "@poseidon/contracts/git";
import { makeItemId, makeThreadId, makeTurnId } from "@poseidon/contracts/ids";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";

import {
  branchOffCreateFields,
  branchOffHere,
  forkBlockedReason,
  threadForkBlockedReason,
  threadTurnInFlight,
  planHandoffTurnId,
  forkTitle,
  inNewWorktree,
  sendFirstMessage,
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

  it("blocks the whole thread while it runs or the server is out of reach", () => {
    expect(threadForkBlockedReason({ connected: true, running: false })).toBeNull();
    expect(threadForkBlockedReason({ connected: true, running: true })).toBe("Still running");
    expect(threadForkBlockedReason({ connected: false, running: false })).toBe("Offline");
  });

  it("counts a turn paused on an approval or a question as still in flight", () => {
    expect(threadTurnInFlight({ status: "running" })).toBe(true);
    expect(threadTurnInFlight({ status: "waiting", awaiting: "approval" })).toBe(true);
    expect(threadTurnInFlight({ status: "waiting", awaiting: "question" })).toBe(true);
    // A proposed plan waits after its turn has settled.
    expect(threadTurnInFlight({ status: "waiting", awaiting: "plan" })).toBe(false);
    expect(threadTurnInFlight({ status: "idle" })).toBe(false);
  });
});

describe("what the new thread is created with", () => {
  const settings: ThreadSettings = {
    model: "poolside/laguna-s-2.1-free",
    runtimeMode: "auto-accept-edits",
    interactionMode: "plan",
  };
  const threadId = makeThreadId();

  it("names a fork's source and message, and leaves the settings to the server", () => {
    const throughItemId = makeItemId();
    expect(branchOffCreateFields({ key: "k", threadId, throughItemId }, settings)).toEqual({
      fork: { threadId, throughItemId },
    });
    expect(branchOffCreateFields({ key: "k", threadId }, settings)).toEqual({
      fork: { threadId },
    });
  });

  it("starts a plan's thread clean, on the source's harness and model, out of plan mode", () => {
    const request = {
      key: "k",
      threadId,
      plan: { markdown: "# Plan", handoffTurnId: makeTurnId() },
    };
    expect(branchOffCreateFields(request, settings)).toEqual({
      settings: { ...settings, interactionMode: "default" },
    });
  });
});

describe("a branch-off's first message", () => {
  const receipt = (status: "accepted" | "rejected", reason?: string) =>
    Exit.succeed({ status, ...(reason === undefined ? {} : { reason }), lastSequence: 0 } as never);

  it("leaves the composer alone when the message goes through", async () => {
    const kept: Array<string> = [];
    const reported: Array<string> = [];
    await expect(
      sendFirstMessage(
        async () => receipt("accepted"),
        "1. Write the test",
        (text) => kept.push(text),
        (message) => reported.push(message),
      ),
    ).resolves.toBe(true);
    expect(kept).toEqual([]);
    expect(reported).toEqual([]);
  });

  it("keeps a refused or unsent plan in the composer and says why", async () => {
    const kept: Array<string> = [];
    const reported: Array<string> = [];
    const keep = (text: string) => kept.push(text);
    const report = (message: string) => reported.push(message);
    await expect(
      sendFirstMessage(async () => receipt("rejected", "thread is archived"), "plan", keep, report),
    ).resolves.toBe(false);
    await sendFirstMessage(async () => Exit.fail("socket closed"), "plan", keep, report);
    expect(kept).toEqual(["plan", "plan"]);
    expect(reported).toEqual(["thread is archived", "Could not reach the server"]);
  });
});

describe("which plan Implement in new thread hands off", () => {
  it("answers the pending plan from its timeline record, and nothing older", () => {
    const pending = makeTurnId();
    const older = makeTurnId();
    expect(planHandoffTurnId(pending, pending)).toBe(pending);
    expect(planHandoffTurnId(older, pending)).toBeUndefined();
    expect(planHandoffTurnId(pending, null)).toBeUndefined();
    expect(planHandoffTurnId(undefined, pending)).toBeUndefined();
  });
});
