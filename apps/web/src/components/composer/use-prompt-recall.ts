/**
 * ArrowUp and ArrowDown recall in the composer: the React half of
 * `prompt-history`.
 *
 * The cursor lives in component state, not in the per-thread draft atom: the
 * composer remounts on every thread switch, so recall starts over there, and a
 * draft that survived the switch is an ordinary draft — `recallStep` sees no
 * cursor and leaves a non-empty composer's arrows alone.
 *
 * Only a bare arrow recalls. A modifier makes it a selection or a keymap chord
 * (thread and file navigation use arrow chords), and during IME composition
 * the arrows belong to the candidate list.
 */

import type { ItemSnapshot, TurnReference } from "@poseidon/contracts/runtime";
import * as React from "react";

import {
  caretLines,
  recallStep,
  sentPrompts,
  type RecallCursor,
  type RecallStep,
  type RecalledPrompt,
} from "@/components/composer/prompt-history";

/** The parts of a textarea keydown recall reads. */
export interface RecallKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly nativeEvent: { readonly isComposing: boolean };
  readonly currentTarget: {
    readonly value: string;
    readonly selectionStart: number | null;
    readonly selectionEnd: number | null;
  };
}

/**
 * What a keydown does to recall, or `null` when the key is not recall's. The
 * draft is read from the textarea itself, so the step sees what is on screen.
 */
export const recallKeyStep = (
  event: RecallKeyEvent,
  cursor: RecallCursor,
  history: ReadonlyArray<RecalledPrompt>,
  triggerOpen: boolean,
): RecallStep | null => {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
    return null;
  }
  if (
    event.shiftKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.nativeEvent.isComposing
  ) {
    return null;
  }
  const { value, selectionStart, selectionEnd } = event.currentTarget;
  const start = selectionStart ?? value.length;
  const lines = caretLines(value, start, selectionEnd ?? start);
  return recallStep({
    key: event.key,
    cursor,
    history,
    draftText: value,
    caretOnFirstLine: lines.first,
    caretOnLastLine: lines.last,
    triggerOpen,
  });
};

export interface PromptRecall {
  /** `true` when recall took the key and the caller should stop there. */
  readonly onKeyDown: (event: RecallKeyEvent & { preventDefault(): void }) => boolean;
}

export function usePromptRecall({
  items,
  setText,
  setMentions,
  setReferences,
  textareaRef,
  triggerOpen,
}: {
  readonly items: ReadonlyArray<ItemSnapshot>;
  readonly setText: (text: string) => void;
  readonly setMentions: (mentions: ReadonlyArray<string>) => void;
  readonly setReferences: (references: ReadonlyArray<TurnReference>) => void;
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  readonly triggerOpen: boolean;
}): PromptRecall {
  const history = React.useMemo(() => sentPrompts(items), [items]);
  const [cursor, setCursor] = React.useState<RecallCursor>(null);

  const onKeyDown: PromptRecall["onKeyDown"] = (event) => {
    const step = recallKeyStep(event, cursor, history, triggerOpen);
    if (step === null) {
      return false;
    }
    event.preventDefault();
    if (step.cursor === cursor) {
      // Already at the oldest prompt: the key is taken, nothing changes.
      return true;
    }
    setCursor(step.cursor);
    const text = step.prompt?.text ?? "";
    setText(text);
    setReferences(step.prompt?.references ?? []);
    setMentions([]);
    // After React has written the value, so the caret lands past the text
    // rather than wherever the old value left it.
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(text.length, text.length));
    return true;
  };

  return { onKeyDown };
}
