import { describe, expect, it } from "vitest";

import { makeThreadId } from "@poseidon/contracts/ids";

import { makeTurnQueue, threadCommandBase, threadDoneCommand } from "./thread-actions";

describe("threadCommandBase", () => {
  it("addresses the thread it was given", () => {
    const threadId = makeThreadId();
    expect(threadCommandBase(threadId).threadId).toBe(threadId);
  });

  it("mints a fresh command id on every call", () => {
    const threadId = makeThreadId();
    const first = threadCommandBase(threadId);
    const second = threadCommandBase(threadId);
    expect(first.commandId).not.toBe(second.commandId);
  });

  it("stamps an ISO creation time", () => {
    const { createdAt } = threadCommandBase(makeThreadId());
    expect(new Date(createdAt).toISOString()).toBe(createdAt);
  });
});

describe("threadDoneCommand", () => {
  it("marks done, or clears the mark", () => {
    const threadId = makeThreadId();
    expect(threadDoneCommand(threadId, true)).toMatchObject({ type: "thread.done.mark", threadId });
    expect(threadDoneCommand(threadId, false)).toMatchObject({
      type: "thread.done.clear",
      threadId,
    });
  });
});

describe("makeTurnQueue", () => {
  const deferred = <A>() => {
    let resolve!: (value: A) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<A>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it("starts each task only once the one before it has settled", async () => {
    const queue = makeTurnQueue();
    const log: Array<string> = [];
    const first = deferred<number>();
    const second = deferred<number>();
    const a = queue(() => {
      log.push("start 1");
      return first.promise;
    });
    const b = queue(() => {
      log.push("start 2");
      return second.promise;
    });
    await Promise.resolve();
    expect(log).toEqual(["start 1"]);
    first.resolve(1);
    await a;
    await Promise.resolve();
    expect(log).toEqual(["start 1", "start 2"]);
    second.resolve(2);
    expect(await b).toBe(2);
  });

  it("resolves every caller with its own task's result", async () => {
    const queue = makeTurnQueue();
    const results = await Promise.all([1, 2, 3].map((n) => queue(async () => n * 10)));
    expect(results).toEqual([10, 20, 30]);
  });

  it("keeps going after a task fails", async () => {
    const queue = makeTurnQueue();
    const failed = queue(() => Promise.reject(new Error("refused")));
    const next = queue(async () => "ran");
    await expect(failed).rejects.toThrow("refused");
    expect(await next).toBe("ran");
  });
});
