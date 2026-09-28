import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  makeKeepAwake,
  parseBadge,
  parseBusyCount,
  parseNotify,
  releaseWhenPageGone,
} from "./attention";

describe("parseNotify", () => {
  it("accepts a thread notice and caps its text", () => {
    expect(parseNotify({ threadId: "thr_1-a", title: "Done", body: "Finished" })).toEqual({
      threadId: "thr_1-a",
      title: "Done",
      body: "Finished",
    });
    const long = parseNotify({ threadId: "t", title: "x".repeat(500), body: "y".repeat(500) });
    expect(long?.title.length).toBe(120);
    expect(long?.body.length).toBe(240);
    expect(long?.title.endsWith("…")).toBe(true);
    expect(parseNotify({ threadId: "t", title: "No body" })?.body).toBe("");
  });

  it("rejects anything not shaped like one", () => {
    for (const payload of [
      null,
      undefined,
      "t",
      42,
      {},
      { threadId: "t" },
      { threadId: "t", title: "" },
      { threadId: "t", title: "  " },
      { threadId: "t", title: 3 },
      { threadId: "t", title: "ok", body: 7 },
      { threadId: "../etc", title: "ok" },
      { threadId: "a b", title: "ok" },
      { threadId: "", title: "ok" },
      { threadId: 5, title: "ok" },
    ]) {
      expect(parseNotify(payload)).toBeNull();
    }
  });
});

describe("parseBadge and parseBusyCount", () => {
  it("clamp to a non-negative integer", () => {
    for (const parse of [parseBadge, parseBusyCount]) {
      expect(parse(3)).toBe(3);
      expect(parse(2.7)).toBe(2);
      expect(parse(-4)).toBe(0);
      expect(parse(Number.NaN)).toBe(0);
      expect(parse(Number.POSITIVE_INFINITY)).toBe(0);
      expect(parse("3")).toBe(0);
      expect(parse(undefined)).toBe(0);
      expect(parse(1e9)).toBe(9_999);
    }
  });
});

const fakeBlocker = () => {
  const started = new Set<number>();
  const calls: Array<string> = [];
  let next = 0;
  return {
    calls,
    started,
    blocker: {
      start: () => {
        next += 1;
        started.add(next);
        calls.push(`start:${next}`);
        return next;
      },
      stop: (id: number) => {
        started.delete(id);
        calls.push(`stop:${id}`);
      },
      isStarted: (id: number) => started.has(id),
    },
  };
};

describe("makeKeepAwake", () => {
  it("starts one blocker however often it is asked, and reports holding", () => {
    const fake = fakeBlocker();
    const keepAwake = makeKeepAwake(fake.blocker);
    expect(keepAwake.holding()).toBe(false);
    expect(keepAwake.set(true)).toBe(true);
    expect(keepAwake.set(true)).toBe(true);
    expect(fake.calls).toEqual(["start:1"]);
    expect(keepAwake.holding()).toBe(true);
  });

  it("stops it once and is idempotent on release", () => {
    const fake = fakeBlocker();
    const keepAwake = makeKeepAwake(fake.blocker);
    expect(keepAwake.set(false)).toBe(false);
    keepAwake.set(true);
    expect(keepAwake.set(false)).toBe(false);
    expect(keepAwake.set(false)).toBe(false);
    expect(fake.calls).toEqual(["start:1", "stop:1"]);
    expect(fake.started.size).toBe(0);
  });

  it("starts a fresh blocker when the old one was stopped elsewhere", () => {
    const fake = fakeBlocker();
    const keepAwake = makeKeepAwake(fake.blocker);
    keepAwake.set(true);
    fake.started.clear();
    expect(keepAwake.holding()).toBe(false);
    expect(keepAwake.set(true)).toBe(true);
    expect(fake.calls).toEqual(["start:1", "start:2"]);
  });
});

describe("releaseWhenPageGone", () => {
  it("releases when the window's page is destroyed, once", () => {
    const contents = new EventEmitter();
    const release = vi.fn();
    releaseWhenPageGone(contents, release);
    contents.emit("destroyed");
    contents.emit("destroyed");
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases each time the renderer crashes", () => {
    const contents = new EventEmitter();
    const release = vi.fn();
    releaseWhenPageGone(contents, release);
    contents.emit("render-process-gone");
    contents.emit("render-process-gone");
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("lets a held keep-awake blocker go", () => {
    const fake = fakeBlocker();
    const keepAwake = makeKeepAwake(fake.blocker);
    keepAwake.set(true);
    const contents = new EventEmitter();
    releaseWhenPageGone(contents, () => keepAwake.set(false));
    contents.emit("destroyed");
    expect(keepAwake.holding()).toBe(false);
    expect(fake.calls).toEqual(["start:1", "stop:1"]);
  });
});
