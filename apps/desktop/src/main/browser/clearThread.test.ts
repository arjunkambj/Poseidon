import { describe, expect, it } from "vitest";

import { makeClearAll, makeClearStale, makeClearThread, threadsOnDisk } from "./clearThread";

const fakePartitions = (onDisk: ReadonlyArray<string>) => {
  const opened: Array<string> = [];
  const cleared: Array<string> = [];
  const clear = makeClearThread({
    partitionExists: (threadId) => onDisk.includes(threadId),
    fromPartition: (partition) => {
      opened.push(partition);
      return {
        clearStorageData: async () => {
          cleared.push(`${partition} storage`);
        },
        clearCache: async () => {
          cleared.push(`${partition} cache`);
        },
      };
    },
  });
  return { clear, opened, cleared };
};

const THREAD = "019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b";

describe("makeClearThread", () => {
  it("clears the storage and cache of the thread's own partition", async () => {
    const partitions = fakePartitions([THREAD]);
    await expect(partitions.clear(THREAD)).resolves.toBe(true);
    expect(partitions.opened).toEqual([`persist:thread-${THREAD}`]);
    expect(partitions.cleared).toEqual([
      `persist:thread-${THREAD} storage`,
      `persist:thread-${THREAD} cache`,
    ]);
  });

  it("rejects anything that is not a thread id before naming a partition", async () => {
    const partitions = fakePartitions([THREAD]);
    for (const bad of [
      undefined,
      null,
      42,
      "",
      "../../Default",
      "a/b",
      "thread id",
      `${THREAD}\n`,
      "x:y",
      "..",
      { threadId: THREAD },
    ]) {
      await expect(partitions.clear(bad)).rejects.toThrow("not a thread id");
    }
    expect(partitions.opened).toEqual([]);
  });

  it("does not create a partition that was never on disk just to clear it", async () => {
    const partitions = fakePartitions([]);
    await expect(partitions.clear(THREAD)).resolves.toBe(false);
    expect(partitions.opened).toEqual([]);
  });
});

describe("makeClearThread's disconnect", () => {
  it("cuts the thread's bridge connections, with or without a partition on disk", async () => {
    const cut: Array<string> = [];
    const options = {
      fromPartition: () => ({
        clearStorageData: async () => undefined,
        clearCache: async () => undefined,
      }),
      disconnect: (threadId: string) => cut.push(threadId),
    };
    await makeClearThread({ ...options, partitionExists: () => true })(THREAD);
    await makeClearThread({ ...options, partitionExists: () => false })(THREAD);
    await expect(
      makeClearThread({ ...options, partitionExists: () => true })("../x"),
    ).rejects.toThrow();
    expect(cut).toEqual([THREAD, THREAD]);
  });
});

describe("makeClearAll", () => {
  const OTHER = "019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5c";

  it("clears every thread partition on disk and nothing else", async () => {
    const cleared: Array<string> = [];
    const clearAll = makeClearAll({
      listPartitions: () => [`thread-${THREAD}`, `thread-${OTHER}`, "Default", "thread-../x"],
      partitionExists: () => true,
      fromPartition: (partition) => ({
        clearStorageData: async () => {
          cleared.push(partition);
        },
        clearCache: async () => undefined,
      }),
    });
    await expect(clearAll()).resolves.toBe(2);
    expect(cleared).toEqual([`persist:thread-${THREAD}`, `persist:thread-${OTHER}`]);
  });

  it("reads only thread directories with a thread id", () => {
    expect(threadsOnDisk([`thread-${THREAD}`, "thread-", "thread-../x", "other"])).toEqual([
      THREAD,
    ]);
  });
});

describe("makeClearStale", () => {
  const LIVE = "019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5d";
  const GONE = "019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5e";

  const setup = () => {
    const cleared: Array<string> = [];
    const cut: Array<string> = [];
    const clearStale = makeClearStale({
      listPartitions: () => [`thread-${LIVE}`, `thread-${GONE}`, "Default"],
      partitionExists: () => true,
      fromPartition: (partition) => ({
        clearStorageData: async () => {
          cleared.push(partition);
        },
        clearCache: async () => undefined,
      }),
      disconnect: (threadId) => cut.push(threadId),
    });
    return { clearStale, cleared, cut };
  };

  it("clears only the partitions of threads that no longer exist", async () => {
    const { clearStale, cleared, cut } = setup();
    await expect(clearStale([LIVE, "019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5f"])).resolves.toBe(1);
    expect(cleared).toEqual([`persist:thread-${GONE}`]);
    expect(cut).toEqual([GONE]);
  });

  it("never reads an empty or malformed list as every thread deleted", async () => {
    const { clearStale, cleared } = setup();
    for (const bad of [[], undefined, null, "x", [LIVE, 7], { 0: LIVE }]) {
      await expect(clearStale(bad)).rejects.toThrow("not a thread list");
    }
    expect(cleared).toEqual([]);
  });
});
