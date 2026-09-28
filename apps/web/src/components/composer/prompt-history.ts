/**
 * Recalling a sent prompt into the composer, as values.
 *
 * Re-sending or tweaking something already said is common — "run it again",
 * the same question with one word changed — and retyping it, or scrolling the
 * timeline to copy it, is friction a terminal user never has: ArrowUp in an
 * empty prompt brings the last command back. The composer does the same with
 * the thread's own `user_message` rows, so the history is exactly what the
 * thread sent, survives a reload, and needs no store of its own.
 *
 * What a row can give back is its text and its `@`/`$` references. It carries
 * no `mentions` — a `#path` token simply stays in the text — and its
 * attachments are server-staged references, while the composer holds browser
 * Files, so neither is rebuilt here.
 *
 * ArrowUp is the textarea's own key for moving the caret up a line, so recall
 * takes it only where the textarea would do nothing useful: in an empty
 * composer, or with the caret already on the first line of a prompt it
 * recalled. Once the user edits a recalled prompt it is an ordinary draft —
 * the cursor remembers the text it put there, and any difference makes it
 * stale — so the arrows go back to moving the caret. An open trigger menu owns
 * the arrows for its highlight and always comes first.
 */

import type { ItemSnapshot, TurnReference } from "@poseidon/contracts/runtime";

/** A prompt the thread sent, as the composer can restore it. */
export interface RecalledPrompt {
  readonly text: string;
  readonly references: ReadonlyArray<TurnReference>;
}

/**
 * The thread's sent prompts, newest first. Rows without text are skipped, and
 * a prompt sent several times in a row appears once, so ArrowUp never lands on
 * the same text twice.
 */
export const sentPrompts = (items: ReadonlyArray<ItemSnapshot>): ReadonlyArray<RecalledPrompt> => {
  const prompts: Array<RecalledPrompt> = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined || item.kind !== "user_message" || !item.text) {
      continue;
    }
    if (prompts.at(-1)?.text === item.text) {
      continue;
    }
    prompts.push({ text: item.text, references: item.references ?? [] });
  }
  return prompts;
};

/**
 * Where recall stands: the history index on show and the text it put in the
 * composer, or `null` when nothing recalled is on show.
 */
export type RecallCursor = { readonly index: number; readonly text: string } | null;

export interface RecallStepInput {
  readonly key: "ArrowUp" | "ArrowDown";
  readonly cursor: RecallCursor;
  readonly history: ReadonlyArray<RecalledPrompt>;
  /** The composer's text as it is now. */
  readonly draftText: string;
  readonly caretOnFirstLine: boolean;
  readonly caretOnLastLine: boolean;
  /** A trigger menu (`/`, `#`, `@` or `$`) is open and owns the arrows. */
  readonly triggerOpen: boolean;
}

export interface RecallStep {
  readonly cursor: RecallCursor;
  /** The prompt to put in the composer; `null` empties it. */
  readonly prompt: RecalledPrompt | null;
}

/**
 * The cursor if the composer still shows what it recalled, else `null`. A
 * prompt sent mid-walk — a queued message draining — shifts every index, so
 * the recalled text is looked up again rather than dropping the walk.
 */
const liveCursor = (
  cursor: RecallCursor,
  history: ReadonlyArray<RecalledPrompt>,
  draftText: string,
): RecallCursor => {
  if (cursor === null || cursor.text !== draftText) {
    return null;
  }
  if (history[cursor.index]?.text === cursor.text) {
    return cursor;
  }
  const index = history.findIndex((prompt) => prompt.text === cursor.text);
  return index === -1 ? null : { index, text: cursor.text };
};

/**
 * What an arrow press does to recall, or `null` when the key is not recall's
 * and the textarea should have it. At the oldest prompt ArrowUp is still
 * consumed — so the caret does not jump to the start — but the step returns
 * the same cursor object, which the caller can compare to skip the rewrite.
 */
export const recallStep = (input: RecallStepInput): RecallStep | null => {
  if (input.triggerOpen) {
    return null;
  }
  const { history } = input;
  const live = liveCursor(input.cursor, history, input.draftText);
  if (input.key === "ArrowUp") {
    if (live === null) {
      const newest = history[0];
      if (input.draftText !== "" || newest === undefined) {
        return null;
      }
      return { cursor: { index: 0, text: newest.text }, prompt: newest };
    }
    if (!input.caretOnFirstLine) {
      return null;
    }
    const older = history[live.index + 1];
    if (older === undefined) {
      return { cursor: live, prompt: history[live.index] ?? null };
    }
    return { cursor: { index: live.index + 1, text: older.text }, prompt: older };
  }
  if (live === null || !input.caretOnLastLine) {
    return null;
  }
  const newer = history[live.index - 1];
  if (newer === undefined) {
    return { cursor: null, prompt: null };
  }
  return { cursor: { index: live.index - 1, text: newer.text }, prompt: newer };
};

/**
 * Whether the selection sits on the first line (no newline before its start)
 * and on the last line (no newline at or after its end) of `value`.
 */
export const caretLines = (
  value: string,
  selectionStart: number,
  selectionEnd: number,
): { readonly first: boolean; readonly last: boolean } => ({
  first: !value.slice(0, selectionStart).includes("\n"),
  last: !value.slice(selectionEnd).includes("\n"),
});
