import type { WorktreeSetupProgress } from "@poseidon/client-runtime/gitCommands";
import type { ThreadWorktree } from "@poseidon/contracts/git";
import type { ThreadId } from "@poseidon/contracts/ids";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  backgroundSummary,
  runBackgroundLane,
  runBackgroundLanes,
  serialized,
  type BackgroundLane,
  type BackgroundLaneSteps,
  type BackgroundOutcome,
} from "./background-start";

const T1 = "thread-1" as ThreadId;
const T2 = "thread-2" as ThreadId;
const T3 = "thread-3" as ThreadId;

const worktreeOf = (name: string): ThreadWorktree => ({
  path: `/home/me/.poseidon/worktrees/app/${name}`,
  branch: `poseidon/${name}`,
  baseBranch: "main",
});

const lane = (threadId: ThreadId, name?: string): BackgroundLane => ({
  threadId,
  settings: { model: "gpt-5" },
  ...(name === undefined ? {} : { worktree: { name, baseBranch: "main" } }),
});

const run = (over: Partial<WorktreeSetupProgress> = {}): WorktreeSetupProgress => ({
  output: "",
  exit: { code: 0 },
  skipped: false,
  ...over,
});

/** A promise the test settles by hand. */
const deferred = <A>() => {
  let resolve: (value: A) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<A>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};

/** Lets the callbacks of every promise settled so far run, however deep their chains. */
const flush = async () => {
  for (let tick = 0; tick < 50; tick++) {
    await Promise.resolve();
  }
};

/** Steps that log each call in order, answering from the overrides. */
const recorder = (over: Partial<BackgroundLaneSteps> = {}) => {
  const log: Array<string> = [];
  const steps: BackgroundLaneSteps = {
    createWorktree: async (request) => {
      log.push(`worktree ${request.name}`);
      return worktreeOf(request.name);
    },
    runSetup: async (worktree) => {
      log.push(`setup ${worktree.branch}`);
      return run();
    },
    createThread: async (created, worktree) => {
      log.push(`thread ${created.threadId}${worktree === undefined ? "" : ` ${worktree.branch}`}`);
      return null;
    },
    sendFirstTurn: async (threadId) => {
      log.push(`send ${threadId}`);
      return null;
    },
    parkDraft: (threadId) => {
      log.push(`park ${threadId}`);
    },
    discardWorktree: async (worktree) => {
      log.push(`discard ${worktree.branch}`);
    },
    ...over,
  };
  return { log, steps };
};

describe("runBackgroundLane without a worktree", () => {
  it("creates the thread, then sends", async () => {
    const { log, steps } = recorder();
    await expect(runBackgroundLane(lane(T1), steps)).resolves.toEqual({
      _tag: "started",
      threadId: T1,
    });
    expect(log).toEqual(["thread thread-1", "send thread-1"]);
  });

  it("fails with the refusal when the thread is not created, and sends nothing", async () => {
    const { log, steps } = recorder({ createThread: async () => "no model is configured" });
    await expect(runBackgroundLane(lane(T1), steps)).resolves.toEqual({
      _tag: "failed",
      reason: "no model is configured",
    });
    expect(log).toEqual([]);
  });

  it("parks the draft when the first send fails", async () => {
    const { log, steps } = recorder({ sendFirstTurn: async () => "harness is not signed in" });
    await expect(runBackgroundLane(lane(T1), steps)).resolves.toEqual({
      _tag: "parked",
      threadId: T1,
      reason: "harness is not signed in",
    });
    expect(log).toEqual(["thread thread-1", "park thread-1"]);
  });

  it("reads a rejected send as a failed one", async () => {
    const { steps } = recorder({
      sendFirstTurn: () => Promise.reject(new Error("socket closed")),
    });
    await expect(runBackgroundLane(lane(T1), steps)).resolves.toMatchObject({
      _tag: "parked",
      reason: "socket closed",
    });
  });
});

describe("runBackgroundLane in a new worktree", () => {
  it("creates the worktree, runs setup, creates the thread in it, then sends", async () => {
    const { log, steps } = recorder();
    await expect(runBackgroundLane(lane(T1, "fix-gpt-5"), steps)).resolves.toEqual({
      _tag: "started",
      threadId: T1,
    });
    expect(log).toEqual([
      "worktree fix-gpt-5",
      "setup poseidon/fix-gpt-5",
      "thread thread-1 poseidon/fix-gpt-5",
      "send thread-1",
    ]);
  });

  it("fails with nothing to clean up when the worktree is not created", async () => {
    const { log, steps } = recorder({
      createWorktree: () => Promise.reject({ message: "not a git repository" }),
    });
    await expect(runBackgroundLane(lane(T1, "fix"), steps)).resolves.toEqual({
      _tag: "failed",
      reason: "not a git repository",
    });
    expect(log).toEqual([]);
  });

  it("still creates the thread after a failed setup, parking the draft instead of sending", async () => {
    const { log, steps } = recorder({ runSetup: async () => run({ exit: { code: 3 } }) });
    await expect(runBackgroundLane(lane(T1, "fix"), steps)).resolves.toEqual({
      _tag: "parked",
      threadId: T1,
      reason: "Setup script exited 3",
    });
    expect(log).toEqual(["worktree fix", "thread thread-1 poseidon/fix", "park thread-1"]);
  });

  it("parks with the stream's message when setup could not run", async () => {
    const { steps } = recorder({
      runSetup: () => Promise.reject({ message: "Setup stream broke off", output: "partial" }),
    });
    await expect(runBackgroundLane(lane(T1, "fix"), steps)).resolves.toEqual({
      _tag: "parked",
      threadId: T1,
      reason: "Setup stream broke off",
    });
  });

  it("discards the worktree when the thread is refused", async () => {
    const { log, steps } = recorder({ createThread: async () => "connector is disabled" });
    await expect(runBackgroundLane(lane(T1, "fix"), steps)).resolves.toEqual({
      _tag: "failed",
      reason: "connector is disabled",
    });
    expect(log).toEqual(["worktree fix", "setup poseidon/fix", "discard poseidon/fix"]);
  });

  it("discards the worktree when the thread is refused after a failed setup", async () => {
    const { log, steps } = recorder({
      runSetup: async () => run({ exit: { code: 1 } }),
      createThread: () => Promise.reject(new Error("connector is disabled")),
    });
    await expect(runBackgroundLane(lane(T1, "fix"), steps)).resolves.toEqual({
      _tag: "failed",
      reason: "connector is disabled",
    });
    expect(log).toEqual(["worktree fix", "discard poseidon/fix"]);
  });

  it("says so when the refused thread's worktree could not be removed", async () => {
    const { steps } = recorder({
      createThread: async () => "connector is disabled",
      discardWorktree: () => Promise.reject({ message: "locked" }),
    });
    await expect(runBackgroundLane(lane(T1, "fix"), steps)).resolves.toEqual({
      _tag: "failed",
      reason:
        "connector is disabled; its worktree at /home/me/.poseidon/worktrees/app/fix was not removed: locked",
    });
  });

  it("parks the draft when the first send fails", async () => {
    const { log, steps } = recorder({ sendFirstTurn: async () => "turn refused" });
    await expect(runBackgroundLane(lane(T1, "fix"), steps)).resolves.toEqual({
      _tag: "parked",
      threadId: T1,
      reason: "turn refused",
    });
    expect(log.slice(-2)).toEqual(["thread thread-1 poseidon/fix", "park thread-1"]);
  });
});

describe("runBackgroundLanes", () => {
  it("creates the worktrees one after another, even past a failed one", async () => {
    const creates = [
      deferred<ThreadWorktree>(),
      deferred<ThreadWorktree>(),
      deferred<ThreadWorktree>(),
    ];
    const { log, steps } = recorder({
      createWorktree: (request) => {
        log.push(`worktree ${request.name}`);
        return creates[log.filter((line) => line.startsWith("worktree")).length - 1]!.promise;
      },
    });
    const all = runBackgroundLanes([lane(T1, "a"), lane(T2, "b"), lane(T3, "c")], steps);

    await flush();
    expect(log).toEqual(["worktree a"]);
    creates[0]!.reject({ message: "branch is locked" });
    await flush();
    expect(log).toEqual(["worktree a", "worktree b"]);
    creates[1]!.resolve(worktreeOf("b"));
    await flush();
    expect(log).toContain("worktree c");
    creates[2]!.resolve(worktreeOf("c"));

    await expect(all).resolves.toEqual([
      { _tag: "failed", reason: "branch is locked" },
      { _tag: "started", threadId: T2 },
      { _tag: "started", threadId: T3 },
    ]);
  });

  it("overlaps setups, but issues the thread creates in lane order", async () => {
    const setups = new Map([
      ["poseidon/a", deferred<WorktreeSetupProgress>()],
      ["poseidon/b", deferred<WorktreeSetupProgress>()],
    ]);
    const { log, steps } = recorder({
      runSetup: (worktree) => {
        log.push(`setup ${worktree.branch}`);
        return setups.get(worktree.branch)!.promise;
      },
    });
    const all = runBackgroundLanes([lane(T1, "a"), lane(T2, "b")], steps);

    await flush();
    expect([...log].sort()).toEqual([
      "setup poseidon/a",
      "setup poseidon/b",
      "worktree a",
      "worktree b",
    ]);
    // The second lane's setup finishes first; its thread waits for the first's.
    setups.get("poseidon/b")!.resolve(run());
    await flush();
    expect(log.some((line) => line.startsWith("thread"))).toBe(false);
    setups.get("poseidon/a")!.resolve(run());
    await expect(all).resolves.toEqual([
      { _tag: "started", threadId: T1 },
      { _tag: "started", threadId: T2 },
    ]);
    const threads = log.filter((line) => line.startsWith("thread"));
    expect(threads).toEqual(["thread thread-1 poseidon/a", "thread thread-2 poseidon/b"]);
  });

  describe("with a setup that never ends", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("creates the later lanes' threads once the wait for the stuck lane runs out", async () => {
      vi.useFakeTimers();
      const stuck = deferred<WorktreeSetupProgress>();
      const { log, steps } = recorder({
        runSetup: (worktree) => {
          log.push(`setup ${worktree.branch}`);
          return worktree.branch === "poseidon/a" ? stuck.promise : Promise.resolve(run());
        },
      });
      const all = runBackgroundLanes([lane(T1, "a"), lane(T2, "b"), lane(T3, "c")], steps, 1_000);

      await flush();
      expect(log.some((line) => line.startsWith("thread"))).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
      // Lane b gave up on a; c then follows b as usual, without a wait of its own.
      expect(log.filter((line) => line.startsWith("send"))).toEqual([
        "send thread-2",
        "send thread-3",
      ]);

      stuck.resolve(run());
      await expect(all).resolves.toEqual([
        { _tag: "started", threadId: T1 },
        { _tag: "started", threadId: T2 },
        { _tag: "started", threadId: T3 },
      ]);
      expect(log.filter((line) => line.startsWith("thread"))).toEqual([
        "thread thread-2 poseidon/b",
        "thread thread-3 poseidon/c",
        "thread thread-1 poseidon/a",
      ]);
    });
  });

  it("does not hold a lane back behind one that ended without a thread", async () => {
    const { log, steps } = recorder({
      createWorktree: async (request) => {
        if (request.name === "a") {
          throw { message: "no" };
        }
        return worktreeOf(request.name);
      },
    });
    await expect(runBackgroundLanes([lane(T1, "a"), lane(T2, "b")], steps)).resolves.toEqual([
      { _tag: "failed", reason: "no" },
      { _tag: "started", threadId: T2 },
    ]);
    expect(log).toContain("send thread-2");
  });
});

describe("serialized", () => {
  it("runs tasks in the order handed in, one at a time, past a failure", async () => {
    const serial = serialized();
    const log: Array<string> = [];
    const first = deferred<string>();
    const a = serial(() => {
      log.push("a");
      return first.promise;
    });
    const b = serial(async () => {
      log.push("b");
      return "b";
    });
    await flush();
    expect(log).toEqual(["a"]);
    first.reject(new Error("a failed"));
    await expect(a).rejects.toThrow("a failed");
    await expect(b).resolves.toBe("b");
    expect(log).toEqual(["a", "b"]);
  });
});

describe("backgroundSummary", () => {
  const started = (threadId: ThreadId): BackgroundOutcome => ({ _tag: "started", threadId });

  it("names the project for one started thread", () => {
    expect(backgroundSummary("app", [started(T1)])).toEqual({
      title: "Started in app",
      tone: "success",
      openThreadId: T1,
    });
  });

  it("says a single parked thread was created, and why the message waits", () => {
    expect(
      backgroundSummary("app", [{ _tag: "parked", threadId: T1, reason: "Setup script exited 3" }]),
    ).toEqual({
      title: "Created a thread in app",
      description: "Setup script exited 3 — the message waits in the thread's composer",
      tone: "warning",
      openThreadId: T1,
    });
  });

  it("says a single lane could not start", () => {
    expect(backgroundSummary("app", [{ _tag: "failed", reason: "not a git repository" }])).toEqual({
      title: "Could not start in app",
      description: "not a git repository",
      tone: "error",
      openThreadId: null,
    });
  });

  it("counts every started thread of a fan-out", () => {
    expect(
      backgroundSummary("app", [started(T1), started(T2), started(T3)], ["A", "B", "C"]),
    ).toEqual({
      title: "Started 3 threads in app",
      description: "A, B, C",
      tone: "success",
      openThreadId: T1,
    });
    expect(backgroundSummary("app", [started(T1), started(T2)])).toEqual({
      title: "Started 2 threads in app",
      tone: "success",
      openThreadId: T1,
    });
  });

  it("counts the started ones and names each lane that did not start", () => {
    expect(
      backgroundSummary(
        "app",
        [
          { _tag: "failed", reason: "branch is locked" },
          { _tag: "parked", threadId: T2, reason: "turn refused" },
          started(T3),
        ],
        ["GPT-5", "Laguna", "Muse"],
      ),
    ).toEqual({
      title: "Started 1 of 3 threads in app",
      description:
        "GPT-5: branch is locked; Laguna: turn refused — the message waits in the thread's composer",
      tone: "warning",
      openThreadId: T3,
    });
  });

  it("opens the first parked thread when none started", () => {
    const summary = backgroundSummary(
      "app",
      [
        { _tag: "failed", reason: "no" },
        { _tag: "parked", threadId: T2, reason: "Setup script exited 1" },
      ],
      ["A", "B"],
    );
    expect(summary).toMatchObject({
      title: "Started 0 of 2 threads in app",
      tone: "warning",
      openThreadId: T2,
    });
  });

  it("says none of a fan-out could start", () => {
    expect(
      backgroundSummary(
        "app",
        [
          { _tag: "failed", reason: "no" },
          { _tag: "failed", reason: "no" },
        ],
        ["A", "B"],
      ),
    ).toMatchObject({
      title: "Could not start 2 threads in app",
      tone: "error",
      openThreadId: null,
    });
  });
});
