/**
 * Sending an edited message (`@/state/message-edit`) from the composer.
 *
 * While an edit is open, a plain send (Enter or the Send button, no turn
 * running) asks first when there is a restore point, through
 * `./edit-resend-dialog`. Confirming uploads the attachments, as a normal send
 * does, and dispatches `thread.checkpoint.restore` for the point before the
 * original message with the draft as its `resend`: the server restores the
 * workspace and only then sends the text as a new turn, once. With no restore
 * point, the draft goes out through the normal send, and a steer or a queued
 * message is a normal send too; a normal send that went through ends the edit.
 *
 * Once the server has taken the restore, the draft is cleared and the edit
 * waits in the banner ("Restoring the workspace…") until the restore settles
 * (`editSettle`). Landed: the edit ends, the server has sent the text. Failed:
 * nothing was sent, so the text comes back to the composer with an error line
 * and the edit stays open to try again.
 */

import { useAtomSet } from "@effect/atom-react";
import type { ThreadDetailView } from "@poseidon/client-runtime/clientState";
import { makeCommandId, type ThreadId } from "@poseidon/contracts/ids";
import * as React from "react";

import { editCopy, editSettle, type EditCopy } from "@/components/composer/edit-resend";
import type { Attachments } from "@/components/composer/use-attachments";
import type { Draft } from "@/components/composer/use-send-draft";
import { useClientRuntime } from "@/lib/client-runtime";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";
import { noteLocalSend } from "@/state/local-sends";
import { type MessageEdit, useMessageEdit } from "@/state/message-edit";

export interface EditResend {
  readonly edit: MessageEdit | null;
  readonly copy: EditCopy | null;
  /** The server took the restore; the text goes out once it lands. */
  readonly restoring: boolean;
  /** Ends the edit and leaves the text in the composer. */
  readonly cancel: () => void;
  /** Takes over a send the edit owns; `false` means send it as usual. */
  readonly intercept: (draft: Draft) => boolean;
  /** For `useSendDraft`: clears the draft, and ends an edit a normal send answered. */
  readonly onSent: () => void;
  readonly dialog: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly pending: boolean;
    readonly error: string | null;
    readonly confirm: () => void;
  };
}

/** The edit without its restore in flight: back to editing. */
const editing = ({ sent: _sent, ...rest }: MessageEdit): MessageEdit => rest;

export function useEditResend({
  threadId,
  doc,
  attachments,
  setError,
  setText,
  clearTokens,
}: {
  readonly threadId: ThreadId;
  readonly doc: ThreadDetailView | null;
  readonly attachments: Attachments;
  readonly setError: (message: string | null) => void;
  readonly setText: React.Dispatch<React.SetStateAction<string>>;
  readonly clearTokens: () => void;
}): EditResend {
  const { edit, setEdit } = useMessageEdit(threadId);
  const dispatch = useAtomSet(useClientRuntime().dispatchAtom, { mode: "promise" });
  const [queued, setQueued] = React.useState<Draft | null>(null);
  const [pending, setPending] = React.useState(false);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const docRef = React.useRef(doc);
  docRef.current = doc;

  const copy = edit === null ? null : editCopy(edit.point, edit.steered);

  const intercept = (draft: Draft): boolean => {
    if (edit === null || edit.sent !== undefined || edit.point === null || draft.mode !== "start") {
      return false;
    }
    if (draft.text === "") {
      setError("an edited message needs some text");
      return true;
    }
    setDialogError(null);
    setQueued(draft);
    return true;
  };

  const confirm = () => {
    const point = edit?.point ?? null;
    if (queued === null || point === null || pending) {
      return;
    }
    setPending(true);
    setDialogError(null);
    // Read before the dispatch: the restore may settle before the receipt
    // comes back, and then the "after" would already be the "before".
    const before = {
      text: queued.text,
      restoresBefore: doc?.restores?.length ?? 0,
      failureBefore: doc?.restoreFailure ?? null,
    };
    void attachments
      .stage()
      .then((staged) =>
        dispatch({
          commandId: makeCommandId(),
          createdAt: new Date().toISOString(),
          type: "thread.checkpoint.restore",
          threadId,
          checkpointId: point.checkpoint.checkpointId,
          resend: {
            text: queued.text,
            attachments: staged.references,
            mentions: [...queued.mentions],
            ...(queued.references?.length ? { references: [...queued.references] } : {}),
          },
        }).then(
          (receipt) => {
            const rejected = receiptError(receipt, "the server rejected the restore");
            if (rejected !== null) {
              setDialogError(rejected);
              return;
            }
            const seenRestoring = (docRef.current?.restoring ?? null) !== null;
            setEdit((current) =>
              current === null
                ? null
                : {
                    ...current,
                    sent: { ...before, seenRestoring, acceptedAt: receipt.lastSequence },
                  },
            );
            clearTokens();
            attachments.clearStaged(staged.files);
            setQueued(null);
          },
          () => setDialogError(DISPATCH_UNREACHABLE),
        ),
      )
      .catch(() => setDialogError("the attachment could not be uploaded"))
      .finally(() => setPending(false));
  };

  // A new edit starts clean: an error from the last one is not about it.
  const itemId = edit?.itemId;
  const lastItemId = React.useRef(itemId);
  React.useEffect(() => {
    if (itemId !== undefined && itemId !== lastItemId.current) {
      setError(null);
    }
    lastItemId.current = itemId;
  }, [itemId, setError]);

  // Watch the restore the edit started until it settles.
  const sent = edit?.sent;
  const restoringNow = (doc?.restoring ?? null) !== null;
  const restoreCount = doc?.restores?.length ?? 0;
  const failure = doc?.restoreFailure ?? null;
  const sequence = doc?.snapshotSequence ?? 0;
  React.useEffect(() => {
    if (sent === undefined || edit === null || docRef.current === null) {
      return;
    }
    if (restoringNow && !sent.seenRestoring) {
      setEdit((current) =>
        current?.sent === undefined
          ? current
          : { ...current, sent: { ...current.sent, seenRestoring: true } },
      );
      return;
    }
    const settle = editSettle(sent, {
      sequence,
      restoring: restoringNow,
      restores: restoreCount,
      failure,
    });
    if (settle.kind === "landed") {
      // The server sends the edited text right after the restore lands.
      noteLocalSend(threadId);
      setEdit(null);
    } else if (settle.kind === "failed") {
      setEdit((current) => (current === null ? null : editing(current)));
      // Whatever was typed meanwhile stays, after the edited text.
      setText((typed) => (typed.trim() === "" ? sent.text : `${sent.text}\n\n${typed}`));
      setError(
        `the restore failed${settle.message === null ? "" : ` (${settle.message})`}, so nothing was sent; your edited message is back in the composer`,
      );
    }
  }, [
    sent,
    edit,
    sequence,
    restoringNow,
    restoreCount,
    failure,
    threadId,
    setEdit,
    setText,
    setError,
  ]);

  return {
    edit,
    copy,
    restoring: sent !== undefined,
    cancel: () => {
      setEdit(null);
      setError(null);
    },
    intercept,
    onSent: () => {
      clearTokens();
      setEdit((current) => (current?.sent === undefined ? null : current));
    },
    dialog: {
      open: queued !== null,
      onOpenChange: (open) => {
        if (!open && !pending) {
          setQueued(null);
        }
      },
      pending,
      error: dialogError,
      confirm,
    },
  };
}
