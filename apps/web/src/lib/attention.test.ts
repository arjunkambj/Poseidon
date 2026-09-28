import { describe, expect, it } from "vitest";

import type { ThreadId } from "@poseidon/contracts/ids";
import { DEFAULT_NOTIFICATION_SETTINGS } from "@poseidon/contracts/settings";
import { AlertTriangle, Bell, Check, ClipboardCheck } from "@honeyicons/react";

import {
  type AttentionThread,
  anyRunning,
  attentionOf,
  busyThreads,
  eventEnabled,
  eventMark,
  needsYouCount,
  nextAttentionThread,
  shouldAlert,
  snapshotOf,
  transitions,
} from "./attention";

const thread = (
  id: string,
  status: AttentionThread["status"],
  awaiting?: "approval" | "question" | "plan",
): AttentionThread => ({
  threadId: id as ThreadId,
  title: `Thread ${id}`,
  status,
  awaitingInput: awaiting !== undefined,
  ...(awaiting === undefined ? {} : { awaiting }),
});

const kinds = (
  prev: ReadonlyArray<AttentionThread>,
  next: ReadonlyArray<AttentionThread>,
): ReadonlyArray<string> =>
  transitions(snapshotOf(prev), next).map((event) => `${event.threadId}:${event.kind}`);

describe("attentionOf", () => {
  it("reads awaiting, else falls back to an approval for waiting or awaitingInput", () => {
    expect(attentionOf(thread("a", "waiting", "plan"))).toBe("plan");
    expect(attentionOf({ status: "waiting", awaitingInput: false })).toBe("approval");
    expect(attentionOf({ status: "running", awaitingInput: true })).toBe("approval");
    expect(attentionOf(thread("a", "running"))).toBeNull();
  });
});

describe("transitions", () => {
  it("emits nothing for the first snapshot, which only seeds the baseline", () => {
    expect(transitions(null, [thread("a", "error"), thread("b", "waiting", "approval")])).toEqual(
      [],
    );
  });

  it("emits nothing when the same list is replayed", () => {
    const list = [thread("a", "error"), thread("b", "waiting", "approval"), thread("c", "idle")];
    expect(kinds(list, list)).toEqual([]);
  });

  it("a running thread going idle finished", () => {
    expect(kinds([thread("a", "running")], [thread("a", "idle")])).toEqual(["a:finished"]);
    const [event] = transitions(snapshotOf([thread("a", "running")]), [thread("a", "idle")]);
    expect(event).toEqual({
      threadId: "a",
      title: "Thread a",
      kind: "finished",
      attention: null,
    });
  });

  it("a running thread going to error failed", () => {
    expect(kinds([thread("a", "running")], [thread("a", "error")])).toEqual(["a:failed"]);
  });

  it("an approval appearing needs you once, and not again while it stays", () => {
    const running = [thread("a", "running")];
    const waiting = [thread("a", "waiting", "approval")];
    expect(kinds(running, waiting)).toEqual(["a:needsYou"]);
    expect(kinds(waiting, waiting)).toEqual([]);
    // The second of two approvals: the server keeps `running` with one open.
    expect(kinds(waiting, [thread("a", "running", "approval")])).toEqual([]);
  });

  it("a second approval after the first resolved needs you again", () => {
    const resolved = [thread("a", "running")];
    expect(kinds(resolved, [thread("a", "running", "approval")])).toEqual(["a:needsYou"]);
  });

  it("a ready plan at the end of a turn needs you rather than finishing", () => {
    const events = transitions(snapshotOf([thread("a", "running")]), [thread("a", "idle", "plan")]);
    expect(events.map((event) => [event.kind, event.attention])).toEqual([["needsYou", "plan"]]);
  });

  it("ignores archived and deleted threads and threads the baseline has not seen", () => {
    expect(kinds([thread("a", "running")], [thread("a", "archived")])).toEqual([]);
    expect(kinds([thread("a", "running")], [thread("a", "deleted")])).toEqual([]);
    expect(kinds([], [thread("new", "error")])).toEqual([]);
  });
});

describe("counts", () => {
  const list = [
    thread("a", "running"),
    thread("b", "waiting", "approval"),
    thread("c", "running", "question"),
    thread("d", "idle", "plan"),
    thread("e", "idle"),
    thread("f", "archived", "approval"),
    thread("g", "error"),
  ];

  it("needsYouCount counts open approvals, questions and plans", () => {
    expect(needsYouCount(list)).toBe(3);
    expect(needsYouCount([])).toBe(0);
  });

  it("busyThreads lists what a quit would interrupt", () => {
    expect(busyThreads(list).map((t) => t.threadId)).toEqual(["a", "b", "c", "d"]);
  });

  it("anyRunning is true while a turn runs", () => {
    expect(anyRunning(list)).toBe(true);
    expect(anyRunning([thread("e", "idle"), thread("b", "waiting", "approval")])).toBe(false);
  });
});

describe("shouldAlert", () => {
  const event = { threadId: "a" as ThreadId };
  it("stays quiet for the thread on screen in a focused window", () => {
    expect(shouldAlert(event, { openThreadId: "a", focused: true })).toBe("none");
  });
  it("posts a system notification when the window is not focused", () => {
    expect(shouldAlert(event, { openThreadId: "a", focused: false })).toBe("os");
    expect(shouldAlert(event, { openThreadId: null, focused: false })).toBe("os");
  });
  it("toasts another thread while the window is focused", () => {
    expect(shouldAlert(event, { openThreadId: "b", focused: true })).toBe("toast");
    expect(shouldAlert(event, { openThreadId: null, focused: true })).toBe("toast");
  });
});

describe("eventEnabled", () => {
  it("follows each setting", () => {
    const off = {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      finished: false,
      failed: false,
      needsYou: false,
    };
    for (const kind of ["finished", "failed", "needsYou"] as const) {
      expect(eventEnabled(kind, DEFAULT_NOTIFICATION_SETTINGS)).toBe(true);
      expect(eventEnabled(kind, off)).toBe(false);
      expect(eventEnabled(kind, { ...off, [kind]: true })).toBe(true);
    }
  });
});

describe("eventMark", () => {
  it("reuses the sidebar's marks, with its own for a finished thread", () => {
    expect(eventMark({ kind: "finished", attention: null }).icon).toBe(Check);
    expect(eventMark({ kind: "failed", attention: null })).toMatchObject({
      icon: AlertTriangle,
      tone: "text-destructive",
    });
    expect(eventMark({ kind: "needsYou", attention: "approval" })).toMatchObject({
      icon: Bell,
      label: "Needs you",
    });
    expect(eventMark({ kind: "needsYou", attention: "plan" })).toMatchObject({
      icon: ClipboardCheck,
      label: "Plan ready",
    });
  });
});

describe("nextAttentionThread", () => {
  const at = (
    id: string,
    updatedAt: string,
    status: AttentionThread["status"] = "idle",
    awaiting?: "approval" | "question" | "plan",
  ) => ({ ...thread(id, status, awaiting), updatedAt });
  const T1 = "2026-09-28T10:00:00.000Z";
  const T2 = "2026-09-28T11:00:00.000Z";
  const T3 = "2026-09-28T12:00:00.000Z";
  const EARLY = "2026-09-28T09:00:00.000Z";
  const target = (...args: Parameters<typeof nextAttentionThread>) =>
    nextAttentionThread(...args)?.threadId;

  it("prefers a thread that needs you over a fresher unread one", () => {
    const list = [at("u", T3), at("n", T1, "waiting", "approval")];
    expect(target(list, { u: EARLY }, null)).toBe("n");
  });

  it("picks the freshest of the threads that need you", () => {
    const list = [at("a", T1, "waiting", "approval"), at("b", T2, "idle", "plan")];
    expect(target(list, {}, null)).toBe("b");
  });

  it("skips the open thread and archived or deleted ones", () => {
    const list = [
      at("open", T3, "waiting", "question"),
      at("arch", T3, "archived", "approval"),
      at("del", T3, "deleted", "approval"),
      at("b", T1, "waiting", "approval"),
    ];
    expect(target(list, {}, "open")).toBe("b");
  });

  it("falls back to the freshest unread thread", () => {
    const list = [at("a", T1), at("b", T2), at("seen", T3)];
    expect(target(list, { a: EARLY, b: EARLY, seen: T3 }, null)).toBe("b");
  });

  it("is undefined when nothing needs you and nothing is unread", () => {
    const list = [at("a", T1, "running"), at("b", T2)];
    expect(target(list, { b: T2 }, null)).toBeUndefined();
    expect(target([], {}, null)).toBeUndefined();
  });
});
