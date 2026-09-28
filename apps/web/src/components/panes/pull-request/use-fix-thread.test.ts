/**
 * A Fix menu thread's run with its effects stubbed: the context is read
 * first for checks and conflicts, the thread is created with a fresh id on
 * the source's worktree and settings, the prompt is its first turn, and a
 * refusal at any step stops the run with the server's words.
 */

import { describe, expect, it, vi } from "vitest";

import { makeThreadId, type ThreadId } from "@poseidon/contracts/ids";
import type { CommandReceipt } from "@poseidon/contracts/orchestration";
import type { PullRequestDetail } from "@poseidon/contracts/pullRequest";
import * as Exit from "effect/Exit";

import { fixTarget, runFixThread, settingsPatch, type FixThreadDeps } from "./use-fix-thread";

vi.mock("@/lib/use-create-thread", () => ({ useCreateThread: () => ({}) }));
vi.mock("@/state/hooks", () => ({ useDispatchCommand: () => {}, useThreadList: () => [] }));
vi.mock("@/lib/app-runtime", () => ({ describeExitError: () => "" }));
vi.mock("./pull-request-atoms", () => ({ usePullRequestAtoms: () => ({}) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));
vi.mock("sonner", () => ({ toast: {} }));

const pullRequest: PullRequestDetail = {
  number: 42,
  title: "Teach the parser about tabs",
  url: "https://github.com/o/r/pull/42",
  state: "open",
  isDraft: false,
  baseRefName: "main",
  headRefName: "tabs",
  headRefOid: "0123456789abcdef0123456789abcdef01234567",
  author: "ana",
  updatedAt: "2026-09-28T11:00:00Z",
  mergeable: "conflicting",
  reviewDecision: "changes-requested",
  checks: [],
  reviews: [],
  reviewThreads: [],
  comments: [],
  mergeMethods: { merge: true, squash: true, rebase: true },
};

const accepted = (): Exit.Exit<CommandReceipt, unknown> =>
  Exit.succeed({ status: "accepted" } as CommandReceipt);

const depsWith = (overrides: Partial<FixThreadDeps> = {}) => {
  const newId = makeThreadId();
  const mocks = {
    fixContext: vi.fn<FixThreadDeps["fixContext"]>(async () => ({
      ok: true,
      value: { checks: [], conflictFiles: ["src/a.ts"], base: "origin/main" },
    })),
    create: vi.fn<FixThreadDeps["create"]>(async () => true),
    send: vi.fn<FixThreadDeps["send"]>(async () => accepted()),
    open: vi.fn<(threadId: ThreadId) => void>(),
    newThreadId: () => newId,
    toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
  };
  const deps: FixThreadDeps = { ...mocks, ...overrides };
  return { deps, mocks, newId };
};

const worktree = { path: "/w/tabs", branch: "tabs", baseBranch: "main" };
const settings = {
  model: "sonnet",
  runtimeMode: "full-access",
  interactionMode: "default",
  effort: "high",
} as const;

describe("runFixThread", () => {
  it("reads the conflicts, starts a thread on the same worktree and sends them", async () => {
    const { deps, mocks, newId } = depsWith();
    const started = await runFixThread(deps, "conflicts", pullRequest, { settings, worktree });
    expect(started).toBe(newId);
    expect(mocks.fixContext).toHaveBeenCalledWith("conflicts");
    expect(mocks.create).toHaveBeenCalledWith(newId, {
      settings: settingsPatch(settings),
      worktree,
    });
    const [sentTo, text] = mocks.send.mock.calls[0] ?? [];
    expect(sentTo).toBe(newId);
    expect(text).toContain("Resolve the merge conflicts on pull request #42");
    expect(text).toContain("- src/a.ts");
    expect(mocks.open).toHaveBeenCalledWith(newId);
    expect(mocks.toast.success).toHaveBeenCalledWith(
      "Started a thread to resolve conflicts",
      mocks.toast.loading.mock.calls[0]?.[1],
    );
  });

  it("starts a local thread with no context read for review comments", async () => {
    const { deps, mocks, newId } = depsWith();
    await runFixThread(deps, "reviews", pullRequest, { settings });
    expect(mocks.fixContext).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith(newId, { settings: settingsPatch(settings) });
    expect(mocks.send.mock.calls[0]?.[1]).toContain("A reviewer requested changes.");
  });

  it("stops at a refused context read, creating nothing", async () => {
    const { deps, mocks } = depsWith({
      fixContext: async () => ({
        ok: false,
        message: "the branch's pull request is no longer #42",
      }),
    });
    expect(await runFixThread(deps, "checks", pullRequest, {})).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Fix failing checks failed: the branch's pull request is no longer #42",
      mocks.toast.loading.mock.calls[0]?.[1],
    );
  });

  it("leaves a rejected create to its own toast and sends nothing", async () => {
    const { deps, mocks } = depsWith({ create: async () => false });
    expect(await runFixThread(deps, "reviews", pullRequest, {})).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.toast.dismiss).toHaveBeenCalledWith(mocks.toast.loading.mock.calls[0]?.[1].id);
  });

  it("opens the thread but says so when its first message was rejected", async () => {
    const { deps, mocks, newId } = depsWith({
      send: async () =>
        Exit.succeed({ status: "rejected", reason: "the harness is not ready" } as CommandReceipt),
    });
    expect(await runFixThread(deps, "reviews", pullRequest, {})).toBeNull();
    expect(mocks.open).toHaveBeenCalledWith(newId);
    expect(mocks.toast.error.mock.calls[0]?.[0]).toContain("the harness is not ready");
  });

  it("names where the thread goes", () => {
    expect(fixTarget(worktree)).toBe("the worktree at /w/tabs");
    expect(fixTarget(undefined)).toBe("the project's folder");
  });
});
