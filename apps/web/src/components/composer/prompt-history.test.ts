import type { ItemKind } from "@poseidon/contracts/enums";
import type { ItemId } from "@poseidon/contracts/ids";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { describe, expect, it } from "vitest";

import {
  caretLines,
  recallStep,
  sentPrompts,
  type RecalledPrompt,
  type RecallCursor,
  type RecallStepInput,
} from "./prompt-history";

let sequence = 0;

const item = (kind: ItemKind, over: Partial<ItemSnapshot> = {}): ItemSnapshot => {
  sequence += 1;
  const itemId = `0189c3a4-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}` as ItemId;
  return { itemId, kind, status: "completed", ...over };
};

const sent = (text: string | undefined, over: Partial<ItemSnapshot> = {}) =>
  item("user_message", text === undefined ? over : { text, ...over });

const prompt = (text: string): RecalledPrompt => ({ text, references: [] });

/** Newest first, as `sentPrompts` returns it. */
const history = [prompt("third"), prompt("second\nline two"), prompt("first")];

const step = (over: Partial<RecallStepInput>) =>
  recallStep({
    key: "ArrowUp",
    cursor: null,
    history,
    draftText: "",
    caretOnFirstLine: true,
    caretOnLastLine: true,
    triggerOpen: false,
    ...over,
  });

describe("sentPrompts", () => {
  it("lists the thread's user messages newest first and ignores other rows", () => {
    const items = [
      sent("first"),
      item("assistant_message", { text: "a reply" }),
      sent("second"),
      item("command_execution", { command: { cmd: "ls" } }),
      sent("third"),
    ];
    expect(sentPrompts(items).map((entry) => entry.text)).toEqual(["third", "second", "first"]);
  });

  it("skips rows with empty or absent text", () => {
    const items = [sent("kept"), sent(""), sent(undefined)];
    expect(sentPrompts(items).map((entry) => entry.text)).toEqual(["kept"]);
  });

  it("collapses consecutive identical prompts but keeps repeats further apart", () => {
    const items = [sent("again"), sent("other"), sent("again"), sent("again")];
    expect(sentPrompts(items).map((entry) => entry.text)).toEqual(["again", "other", "again"]);
  });

  it("carries the skill and plugin references, defaulting to none", () => {
    const references = [{ kind: "skill", name: "review" }] as const;
    const [withRefs, without] = sentPrompts([sent("plain"), sent("use it", { references })]);
    expect(withRefs).toEqual({ text: "use it", references });
    expect(without).toEqual({ text: "plain", references: [] });
  });
});

describe("recallStep", () => {
  it("recalls the newest prompt with ArrowUp in an empty composer", () => {
    expect(step({})).toEqual({ cursor: { index: 0, text: "third" }, prompt: history[0] });
  });

  it("leaves ArrowUp to the textarea when the composer has text and nothing is recalled", () => {
    expect(step({ draftText: "typing" })).toBeNull();
    expect(step({ draftText: " " })).toBeNull();
  });

  it("does nothing with an empty history", () => {
    expect(step({ history: [] })).toBeNull();
  });

  it("never fires while a trigger menu is open", () => {
    expect(step({ triggerOpen: true })).toBeNull();
    const cursor: RecallCursor = { index: 0, text: "third" };
    expect(step({ key: "ArrowDown", cursor, draftText: "third", triggerOpen: true })).toBeNull();
  });

  it("needs the caret on the first line to walk past a multi-line recall", () => {
    const cursor: RecallCursor = { index: 1, text: "second\nline two" };
    const onRecall = { cursor, draftText: "second\nline two" };
    expect(step({ ...onRecall, caretOnFirstLine: false })).toBeNull();
    expect(step(onRecall)).toEqual({ cursor: { index: 2, text: "first" }, prompt: history[2] });
  });

  it("clamps at the oldest prompt, consuming the key without moving", () => {
    const cursor: RecallCursor = { index: 2, text: "first" };
    const result = step({ cursor, draftText: "first" });
    expect(result?.cursor).toBe(cursor);
    expect(result?.prompt).toBe(history[2]);
  });

  it("walks newer with ArrowDown and finally returns to an empty composer", () => {
    const middle: RecallCursor = { index: 1, text: "second\nline two" };
    const onMiddle = { key: "ArrowDown", cursor: middle, draftText: middle.text } as const;
    expect(step({ ...onMiddle, caretOnLastLine: false })).toBeNull();
    expect(step(onMiddle)).toEqual({ cursor: { index: 0, text: "third" }, prompt: history[0] });

    const newest: RecallCursor = { index: 0, text: "third" };
    expect(step({ key: "ArrowDown", cursor: newest, draftText: "third" })).toEqual({
      cursor: null,
      prompt: null,
    });
  });

  it("leaves ArrowDown alone with nothing recalled", () => {
    expect(step({ key: "ArrowDown" })).toBeNull();
  });

  it("treats an edited recall as a normal draft for both keys", () => {
    const cursor: RecallCursor = { index: 0, text: "third" };
    expect(step({ cursor, draftText: "third!" })).toBeNull();
    expect(step({ key: "ArrowDown", cursor, draftText: "third!" })).toBeNull();
  });

  it("treats a cursor whose history moved on as stale", () => {
    const cursor: RecallCursor = { index: 0, text: "third" };
    const moved = [prompt("fourth"), ...history];
    expect(step({ key: "ArrowDown", cursor, draftText: "third", history: moved })).toBeNull();
  });
});

describe("caretLines", () => {
  it("is both first and last on a single line", () => {
    expect(caretLines("one line", 3, 3)).toEqual({ first: true, last: true });
    expect(caretLines("", 0, 0)).toEqual({ first: true, last: true });
  });

  it("tells the first and last lines apart in multi-line text", () => {
    const value = "top\nmiddle\nbottom";
    expect(caretLines(value, 2, 2)).toEqual({ first: true, last: false });
    expect(caretLines(value, 6, 6)).toEqual({ first: false, last: false });
    expect(caretLines(value, value.length, value.length)).toEqual({ first: false, last: true });
    expect(caretLines(value, 3, 3)).toEqual({ first: true, last: false });
    expect(caretLines(value, 4, 4)).toEqual({ first: false, last: false });
  });

  it("reads a selection by its start for the first line and its end for the last", () => {
    const value = "top\nmiddle\nbottom";
    expect(caretLines(value, 0, value.length)).toEqual({ first: true, last: true });
    expect(caretLines(value, 5, value.length)).toEqual({ first: false, last: true });
    expect(caretLines(value, 0, 5)).toEqual({ first: true, last: false });
  });
});
