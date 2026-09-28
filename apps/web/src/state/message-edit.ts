/**
 * The user message being edited in each thread's composer — presentation
 * state, in memory only.
 *
 * "Edit" under a user message puts its text in the composer and records the
 * edit here; sending it restores the workspace to before that message and
 * resends (`components/composer/use-edit-resend.ts`). Keyed by threadId and
 * `keepAlive`, like the composer's draft, so switching threads and back keeps
 * the edit, and a restore in flight is still watched when the thread is
 * opened again.
 *
 * `point` is where sending restores to, worked out when Edit was pressed from
 * the timeline's checkpoints — the same point that message's "Restore to
 * here" goes to — or `null` when there is none and the text is just sent.
 * `sent` is set once the server accepted the restore, until it settles.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ItemId, TurnId } from "@poseidon/contracts/ids";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

import type { EditInFlight } from "@/components/composer/edit-resend";
import type { RestorePoint } from "@/components/timeline/turn-checkpoints";

export interface MessageEdit {
  readonly itemId: ItemId;
  readonly turnId: TurnId | undefined;
  /** Steered into a running turn: the restore goes back to before that turn. */
  readonly steered: boolean;
  readonly text: string;
  readonly point: RestorePoint | null;
  /** How many attachments the original carried: none of them is resent. */
  readonly attachments?: number;
  readonly sent?: EditInFlight;
}

const messageEditAtom = Atom.keepAlive(Atom.make<Readonly<Record<string, MessageEdit>>>({}));

export interface MessageEditHandle {
  readonly edit: MessageEdit | null;
  /** Replace the edit, or end it with `null`. */
  readonly setEdit: (
    next: MessageEdit | null | ((current: MessageEdit | null) => MessageEdit | null),
  ) => void;
}

export const useMessageEdit = (threadId: string): MessageEditHandle => {
  const edit = useAtomValue(
    messageEditAtom,
    React.useCallback(
      (edits: Readonly<Record<string, MessageEdit>>) => edits[threadId] ?? null,
      [threadId],
    ),
  );
  const setEdits = useAtomSet(messageEditAtom);
  const setEdit = React.useCallback<MessageEditHandle["setEdit"]>(
    (next) =>
      setEdits((edits) => {
        const current = edits[threadId] ?? null;
        const value = typeof next === "function" ? next(current) : next;
        if (value === current) {
          return edits;
        }
        const rest = { ...edits };
        delete rest[threadId];
        return value === null ? rest : { ...rest, [threadId]: value };
      }),
    [setEdits, threadId],
  );
  return { edit, setEdit };
};
