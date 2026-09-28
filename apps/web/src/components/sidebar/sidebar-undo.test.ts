import { describe, expect, it } from "vitest";

import {
  archiveUndoPlan,
  doneUndoEntry,
  makeUndoId,
  pushUndo,
  takeById,
  takeLatest,
  type UndoEntry,
  type UndoStack,
} from "./sidebar-undo";

const entry = (id: string): UndoEntry => ({ id, label: id, run: () => undefined });
const ids = (stack: UndoStack) => stack.map((item) => item.id);

describe("pushUndo", () => {
  it("puts the newest entry last", () => {
    const stack = pushUndo(pushUndo([], entry("a")), entry("b"));
    expect(ids(stack)).toEqual(["a", "b"]);
  });

  it("drops the oldest entries past the limit", () => {
    let stack: UndoStack = [];
    for (const id of ["a", "b", "c", "d"]) {
      stack = pushUndo(stack, entry(id), 3);
    }
    expect(ids(stack)).toEqual(["b", "c", "d"]);
  });
});

describe("takeLatest", () => {
  it("takes the newest entry first", () => {
    const [latest, rest] = takeLatest([entry("a"), entry("b")]);
    expect(latest?.id).toBe("b");
    expect(ids(rest)).toEqual(["a"]);
  });

  it("takes the one before once the newest is undone", () => {
    const [, rest] = takeLatest([entry("a"), entry("b")]);
    const [next, empty] = takeLatest(rest);
    expect(next?.id).toBe("a");
    expect(empty).toEqual([]);
  });

  it("takes nothing from an empty stack", () => {
    const stack: UndoStack = [];
    expect(takeLatest(stack)).toEqual([undefined, stack]);
  });
});

describe("takeById", () => {
  it("removes only that entry", () => {
    const [taken, rest] = takeById([entry("a"), entry("b"), entry("c")], "b");
    expect(taken?.id).toBe("b");
    expect(ids(rest)).toEqual(["a", "c"]);
  });

  it("takes nothing twice: an undone entry is gone for the key too", () => {
    const [, rest] = takeById([entry("a"), entry("b")], "b");
    expect(takeById(rest, "b")[0]).toBeUndefined();
    expect(takeLatest(rest)[0]?.id).toBe("a");
  });
});

describe("makeUndoId", () => {
  it("never repeats", () => {
    expect(makeUndoId()).not.toBe(makeUndoId());
  });
});

describe("archiveUndoPlan", () => {
  it("re-pins the archived threads that were pinned", () => {
    expect(archiveUndoPlan(["a", "b", "c"], ["c", "x", "a"], null).repin).toEqual(["a", "c"]);
  });

  it("reopens the open thread when it was archived", () => {
    expect(archiveUndoPlan(["a", "b"], [], "b").reopen).toBe("b");
    expect(archiveUndoPlan(["a", "b"], [], "z").reopen).toBeNull();
    expect(archiveUndoPlan(["a"], [], null).reopen).toBeNull();
  });
});

describe("doneUndoEntry", () => {
  const recorder = () => {
    const sent: Array<readonly [string, boolean]> = [];
    const send = (threadId: string, done: boolean) => {
      sent.push([threadId, done]);
      return Promise.resolve(true);
    };
    return { sent, send };
  };

  it("marks threads active again to undo marking them done", async () => {
    const { sent, send } = recorder();
    const entry = doneUndoEntry(["a", "b"], true, send, "undo-x");
    expect(entry.id).toBe("undo-x");
    expect(entry.label).toBe("Mark done");
    expect(sent).toEqual([]);
    await entry.run();
    expect(sent).toEqual([
      ["a", false],
      ["b", false],
    ]);
  });

  it("marks threads done again to undo marking them active", async () => {
    const { sent, send } = recorder();
    const entry = doneUndoEntry(["a"], false, send);
    expect(entry.label).toBe("Mark active");
    await entry.run();
    expect(sent).toEqual([["a", true]]);
  });
});
