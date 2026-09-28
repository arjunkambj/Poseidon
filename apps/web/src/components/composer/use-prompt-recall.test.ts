import { describe, expect, it } from "vitest";

import type { RecallCursor, RecalledPrompt } from "@/components/composer/prompt-history";
import { recallKeyStep, type RecallKeyEvent } from "@/components/composer/use-prompt-recall";

const HISTORY: ReadonlyArray<RecalledPrompt> = [
  { text: "run the tests again", references: [{ kind: "skill", name: "test" }] },
  { text: "first line\nsecond line", references: [] },
  { text: "hello", references: [] },
];

/** A textarea as recall reads it: its value and a caret at `caret` (default: the end). */
const press = (
  key: string,
  value: string,
  options: { caret?: number; modifiers?: Partial<RecallKeyEvent>; composing?: boolean } = {},
): RecallKeyEvent => {
  const caret = options.caret ?? value.length;
  return {
    key,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...options.modifiers,
    nativeEvent: { isComposing: options.composing ?? false },
    currentTarget: { value, selectionStart: caret, selectionEnd: caret },
  };
};

/**
 * Drives the steps the way the hook applies them: the composer shows the
 * step's prompt (or empties) with the caret at the end. An arrow recall does
 * not take is the textarea's, modelled here as the caret moving to the first
 * line (ArrowUp) or the end (ArrowDown).
 */
const composer = () => {
  let value = "";
  let caret = 0;
  let cursor: RecallCursor = null;
  return {
    get value() {
      return value;
    },
    type(next: string) {
      value = next;
      caret = next.length;
    },
    key(key: string, triggerOpen = false): boolean {
      const step = recallKeyStep(press(key, value, { caret }), cursor, HISTORY, triggerOpen);
      if (step === null) {
        caret = key === "ArrowUp" ? 0 : value.length;
        return false;
      }
      cursor = step.cursor;
      value = step.prompt?.text ?? "";
      caret = value.length;
      return true;
    },
  };
};

describe("prompt recall in the composer", () => {
  it("walks newest to oldest with ArrowUp and back to empty with ArrowDown", () => {
    const c = composer();
    expect(c.key("ArrowUp")).toBe(true);
    expect(c.value).toBe("run the tests again");
    expect(c.key("ArrowUp")).toBe(true);
    expect(c.value).toBe("first line\nsecond line");
    // The caret sits at the end of a multi-line recall: the first ArrowUp
    // moves it to the first line, the next one goes further back.
    expect(c.key("ArrowUp")).toBe(false);
    expect(c.key("ArrowUp")).toBe(true);
    expect(c.value).toBe("hello");
    // The oldest still takes the key and stays put.
    expect(c.key("ArrowUp")).toBe(true);
    expect(c.value).toBe("hello");
    expect(c.key("ArrowDown")).toBe(true);
    expect(c.value).toBe("first line\nsecond line");
    expect(c.key("ArrowDown")).toBe(true);
    expect(c.key("ArrowDown")).toBe(true);
    expect(c.value).toBe("");
    // Back at empty, ArrowDown is the textarea's again.
    expect(c.key("ArrowDown")).toBe(false);
  });

  it("leaves ArrowUp alone once the composer has text", () => {
    const c = composer();
    c.type("x");
    expect(c.key("ArrowUp")).toBe(false);
    expect(c.value).toBe("x");
  });

  it("turns an edited recall into an ordinary draft", () => {
    const c = composer();
    c.key("ArrowUp");
    c.type("run the tests again please");
    expect(c.key("ArrowUp")).toBe(false);
    expect(c.key("ArrowDown")).toBe(false);
    expect(c.value).toBe("run the tests again please");
  });

  it("gives the arrows to an open trigger menu", () => {
    const c = composer();
    expect(c.key("ArrowUp", true)).toBe(false);
    expect(c.value).toBe("");
  });

  it("moves the caret inside a multi-line recall until it reaches the edge line", () => {
    const text = "first line\nsecond line";
    const cursor: RecallCursor = { index: 1, text };
    // Caret on the second line: ArrowUp moves the caret, not the history.
    expect(recallKeyStep(press("ArrowUp", text), cursor, HISTORY, false)).toBeNull();
    // Caret on the first line: ArrowUp goes to the older prompt.
    expect(recallKeyStep(press("ArrowUp", text, { caret: 3 }), cursor, HISTORY, false)).toEqual({
      cursor: { index: 2, text: "hello" },
      prompt: HISTORY[2],
    });
    // Caret on the first line: ArrowDown moves the caret first.
    expect(
      recallKeyStep(press("ArrowDown", text, { caret: 3 }), cursor, HISTORY, false),
    ).toBeNull();
  });

  it("ignores modified arrows, IME composition and other keys", () => {
    for (const modifiers of [
      { shiftKey: true },
      { metaKey: true },
      { ctrlKey: true },
      { altKey: true },
    ]) {
      expect(recallKeyStep(press("ArrowUp", "", { modifiers }), null, HISTORY, false)).toBeNull();
    }
    expect(
      recallKeyStep(press("ArrowUp", "", { composing: true }), null, HISTORY, false),
    ).toBeNull();
    expect(recallKeyStep(press("ArrowLeft", ""), null, HISTORY, false)).toBeNull();
  });

  it("restores the references with the text", () => {
    const step = recallKeyStep(press("ArrowUp", ""), null, HISTORY, false);
    expect(step?.prompt?.references).toEqual([{ kind: "skill", name: "test" }]);
  });
});
