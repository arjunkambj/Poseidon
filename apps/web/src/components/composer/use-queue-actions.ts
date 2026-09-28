/**
 * What the queued-message strip can do to a row: move it, remove it, steer it
 * into the running turn, or take it back into the composer to edit.
 *
 * Every action goes through the server; nothing is removed locally. A row
 * leaves the strip when `thread.message.dequeued` lands, so the strip never
 * disagrees with the server about what is still going to be sent.
 *
 * "Steer now" and "Edit" are two commands, not one, and the order matters. The
 * removal goes first: the server drains the queue on every `turn.completed`,
 * so a message steered while still queued could be sent twice — once into the
 * running turn, once as the next turn. A refused removal means the drain
 * already took it, and nothing else happens. A refused steer puts the message
 * back with `thread.turn.start` `queued: true` — at the end of the queue, not
 * where it was, since there is no atomic "steer this queued message" command.
 * A steer that got no answer is not re-sent blind — the server may have taken
 * it — and neither is a message the queue would not take back: both go into
 * the composer, after whatever is there, so the text is never lost.
 *
 * Queued attachments are server-staged paths; the composer holds browser
 * `File`s. "Edit" cannot bring images back, so a message with any is not
 * offered for editing rather than losing them on the way.
 */

import { useAtomSet } from "@effect/atom-react";
import { makeCommandId } from "@poseidon/contracts/ids";
import type { ItemId, ThreadId } from "@poseidon/contracts/ids";
import type { Command, CommandReceipt, QueuedMessage } from "@poseidon/contracts/orchestration";
import type { TurnReference } from "@poseidon/contracts/runtime";
import * as React from "react";

import { useClientRuntime } from "@/lib/client-runtime";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";
import { useKeybindingDispatch } from "@/lib/shortcuts";
import { noteLocalSend } from "@/state/local-sends";
import { type ComposerDraft, useComposerDraft } from "@/state/ui";

export type QueueDispatch = (command: Command) => Promise<CommandReceipt>;

const base = () => ({ commandId: makeCommandId(), createdAt: new Date().toISOString() });

/** The message's payload, as both `thread.turn.steer` and `thread.turn.start` take it. */
const payload = (threadId: ThreadId, message: QueuedMessage) => ({
  threadId,
  text: message.text,
  attachments: [...message.attachments],
  mentions: [...message.mentions],
  ...(message.references?.length ? { references: [...message.references] } : {}),
});

/** The error line for one dispatch, or null when the server took it. */
const outcome = (dispatch: QueueDispatch, command: Command, rejection: string) =>
  dispatch(command).then(
    (receipt) => receiptError(receipt, rejection),
    () => DISPATCH_UNREACHABLE,
  );

const removeCommand = (threadId: ThreadId, queuedMessageId: ItemId): Command => ({
  ...base(),
  type: "thread.queue.remove",
  threadId,
  queuedMessageId,
});

/** Take `message` off the queue; the error line, or null. */
const removeQueued = (
  dispatch: QueueDispatch,
  threadId: ThreadId,
  message: QueuedMessage,
): Promise<string | null> =>
  outcome(
    dispatch,
    removeCommand(threadId, message.queuedMessageId),
    "the server rejected the removal",
  );

/**
 * Remove, then steer, then re-queue if the steer was refused. `beforeSteer`
 * runs just before the steer goes out (the local-send note: the message row
 * can arrive before the receipt). `keep` takes the message into the composer
 * when it can neither be steered nor safely put back on the queue.
 */
export const steerQueued = async (
  dispatch: QueueDispatch,
  threadId: ThreadId,
  message: QueuedMessage,
  beforeSteer: () => void,
  keep: (message: QueuedMessage) => void,
): Promise<string | null> => {
  const removed = await removeQueued(dispatch, threadId, message);
  if (removed !== null) {
    return removed;
  }
  beforeSteer();
  // Not `outcome`: a refused steer and an unanswered one are handled apart.
  const steered = await dispatch({
    ...base(),
    type: "thread.turn.steer",
    ...payload(threadId, message),
  }).then(
    (receipt) => ({ reached: true, error: receiptError(receipt, "the server rejected the steer") }),
    () => ({ reached: false, error: DISPATCH_UNREACHABLE }),
  );
  if (steered.error === null) {
    return null;
  }
  if (!steered.reached) {
    keep(message);
    return "could not reach the server — the message is back in the composer";
  }
  const requeued = await outcome(
    dispatch,
    { ...base(), type: "thread.turn.start", ...payload(threadId, message), queued: true },
    "the server rejected putting it back",
  );
  if (requeued === null) {
    return `${steered.error} — it is back at the end of the queue`;
  }
  keep(message);
  return `${steered.error} — the message is back in the composer`;
};

/** Remove, then hand the message to `fill` once the server has taken it off the queue. */
export const editQueued = async (
  dispatch: QueueDispatch,
  threadId: ThreadId,
  message: QueuedMessage,
  fill: (message: QueuedMessage) => void,
): Promise<string | null> => {
  const removed = await removeQueued(dispatch, threadId, message);
  if (removed === null) {
    fill(message);
  }
  return removed;
};

/** Whether a queued message can go back into the composer: images cannot. */
export const canEditQueued = (message: QueuedMessage): boolean => message.attachments.length === 0;

/** `next` after `current`, dropping entries `current` already has. */
const merged = <T>(
  current: ReadonlyArray<T>,
  next: ReadonlyArray<T>,
  key: (entry: T) => string,
): ReadonlyArray<T> => {
  const seen = new Set(current.map(key));
  return [...current, ...next.filter((entry) => !seen.has(key(entry)))];
};

/**
 * Each draft field with `message` added after what is already there — a blank
 * line between the texts, mentions and references merged — so taking a
 * message back never overwrites what the user typed. Its images cannot come
 * back. Per field, because the draft handle's setters are.
 */
export const appendQueued = {
  text: (text: string, message: QueuedMessage): string =>
    text === "" ? message.text : `${text}\n\n${message.text}`,
  mentions: (mentions: ReadonlyArray<string>, message: QueuedMessage): ReadonlyArray<string> =>
    merged(mentions, message.mentions, (path) => path),
  references: (
    references: ReadonlyArray<TurnReference>,
    message: QueuedMessage,
  ): ReadonlyArray<TurnReference> =>
    merged(
      references,
      message.references ?? [],
      (reference) => `${reference.kind}:${reference.name}`,
    ),
};

/** Whether "Edit" would overwrite something the user typed. */
export const draftHasContent = (draft: ComposerDraft): boolean =>
  draft.text !== "" ||
  draft.mentions.length > 0 ||
  draft.references.length > 0 ||
  draft.files.length > 0;

export interface QueueActions {
  /** The row with a command in flight; every row's controls are locked meanwhile. */
  readonly busy: ItemId | null;
  readonly error: string | null;
  readonly move: (message: QueuedMessage, toIndex: number) => void;
  readonly remove: (message: QueuedMessage) => void;
  readonly steer: (message: QueuedMessage) => void;
  /** Edits at once with an empty draft; otherwise waits for `confirmEdit`. */
  readonly edit: (message: QueuedMessage) => void;
  /** The message waiting on "Replace your draft?", or null. */
  readonly pendingEdit: QueuedMessage | null;
  readonly confirmEdit: () => void;
  readonly cancelEdit: () => void;
}

export function useQueueActions(threadId: ThreadId): QueueActions {
  const { dispatchAtom } = useClientRuntime();
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });
  const draft = useComposerDraft(threadId);
  const keybinding = useKeybindingDispatch();
  const [busy, setBusy] = React.useState<ItemId | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingEdit, setPendingEdit] = React.useState<QueuedMessage | null>(null);

  /** One action, with the rows locked until it settles. */
  const run = (message: QueuedMessage, action: () => Promise<string | null>) => {
    setBusy(message.queuedMessageId);
    setError(null);
    void action().then((line) => {
      setBusy(null);
      setError(line);
    });
  };

  const fill = (message: QueuedMessage) => {
    draft.setText(message.text);
    draft.setMentions([...message.mentions]);
    draft.setReferences([...(message.references ?? [])]);
    draft.setFiles([]);
    keybinding("composer.focus");
  };

  const runEdit = (message: QueuedMessage) =>
    run(message, () => editQueued(dispatch, threadId, message, fill));

  /** Put a message that could not be delivered after the draft, never over it. */
  const keep = (message: QueuedMessage) => {
    draft.setText((text) => appendQueued.text(text, message));
    draft.setMentions((mentions) => appendQueued.mentions(mentions, message));
    draft.setReferences((references) => appendQueued.references(references, message));
  };

  return {
    busy,
    error,
    move: (message, toIndex) =>
      run(message, () =>
        outcome(
          dispatch,
          {
            ...base(),
            type: "thread.queue.reorder",
            threadId,
            queuedMessageId: message.queuedMessageId,
            toIndex,
          },
          "the server rejected the move",
        ),
      ),
    remove: (message) => run(message, () => removeQueued(dispatch, threadId, message)),
    steer: (message) =>
      run(message, () =>
        steerQueued(dispatch, threadId, message, () => noteLocalSend(threadId), keep),
      ),
    edit: (message) => {
      if (!canEditQueued(message)) {
        return;
      }
      if (draftHasContent(draft)) {
        setPendingEdit(message);
        return;
      }
      runEdit(message);
    },
    pendingEdit,
    confirmEdit: () => {
      if (pendingEdit !== null) {
        runEdit(pendingEdit);
      }
      setPendingEdit(null);
    },
    cancelEdit: () => setPendingEdit(null),
  };
}
