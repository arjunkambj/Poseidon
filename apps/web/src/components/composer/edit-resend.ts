/**
 * Edit and resend, as data: what the composer's banner and the confirmation
 * say is undone, and whether a restore the edit started has settled.
 *
 * Sending an edited message restores the workspace to how it was before the
 * original (the same point "Restore to here" goes to, `restorePointBefore`),
 * then the server sends the edited text as a new turn. A message steered into
 * a running turn has only the checkpoint from before that turn, so its copy
 * says so. With no restore point (the thread's first turn, or a workspace
 * without git), nothing is restored and the text is simply sent.
 */

import type { RestorePoint } from "@/components/timeline/turn-checkpoints";

const STAYS =
  "and sends this as a new turn. The conversation above stays, and the agent still remembers it.";

/** The words for one edit: what sending does, and the caveat of a skipped turn. */
export interface EditCopy {
  /** The banner's line, and the confirmation's description. */
  readonly summary: string;
  /** Shown when the restore falls back past a turn with no checkpoint. */
  readonly skippedNote: string | null;
  /** Whether sending restores first, and so asks before it does. */
  readonly restores: boolean;
  /** Shown when the original carried attachments, which an edit does not resend. */
  readonly attachmentsNote: string | null;
}

/**
 * The original's attachments are not carried into the composer: an edit
 * resends only what the composer holds, so the user is told to add them again.
 */
const attachmentsNoteFor = (attachments: number): string | null =>
  attachments === 0
    ? null
    : attachments === 1
      ? "The original message's attachment is not sent again; attach it once more if this still needs it."
      : `The original message's ${attachments} attachments are not sent again; attach them once more if this still needs them.`;

export const editCopy = (
  point: RestorePoint | null,
  steered: boolean,
  attachments = 0,
): EditCopy => {
  const attachmentsNote = attachmentsNoteFor(attachments);
  if (point === null) {
    return {
      summary: "Editing a message. Files stay as they are; this is sent as a new turn.",
      skippedNote: null,
      restores: false,
      attachmentsNote,
    };
  }
  const before = steered ? "before the turn it joined" : "before it";
  return {
    summary: `Editing a message. Sending puts the workspace back to how it was ${before} (later turns' file changes are undone) ${STAYS}`,
    skippedNote: point.skipsTurns
      ? steered
        ? "The turn before the one it joined has no checkpoint, so this goes back to an earlier one and undoes that turn's changes too."
        : "The turn right before it has no checkpoint, so this goes back to an earlier one and undoes that turn's changes too."
      : null,
    restores: true,
    attachmentsNote,
  };
};

/**
 * What the thread looked like when the restore was accepted, and whether it
 * has been seen running since. A restore ends one of two ways: `restored`
 * adds an entry to the snapshot's `restores`, `restore.failed` clears
 * `restoring` without one (and leaves `restoreFailure`, while the
 * subscription that saw it lasts).
 *
 * `restoring` can come and go unseen — the thread was left, or the stream
 * reconnected, while git ran — and the fresh snapshot knows nothing of the
 * failure. `acceptedAt` covers that: a view at or past the work order's
 * sequence that is not restoring and has no new restore has settled failed.
 */
export interface EditInFlight {
  /** The edited text that rides on the restore: what comes back if it fails. */
  readonly text: string;
  readonly restoresBefore: number;
  /** The failure on screen at dispatch time, so a stale one is not read as this one's. */
  readonly failureBefore: unknown;
  readonly seenRestoring: boolean;
  /** The receipt's `lastSequence`: where the work order sits in the event log. */
  readonly acceptedAt: number;
}

export interface RestoreView {
  /** The view's `snapshotSequence`: the newest event it has folded. */
  readonly sequence: number;
  readonly restoring: boolean;
  readonly restores: number;
  readonly failure: { readonly message: string } | null;
}

export type EditSettle =
  | { readonly kind: "pending" }
  | { readonly kind: "landed" }
  | { readonly kind: "failed"; readonly message: string | null };

export const editSettle = (sent: EditInFlight, now: RestoreView): EditSettle => {
  if (now.restores > sent.restoresBefore) {
    return { kind: "landed" };
  }
  if (now.restoring) {
    return { kind: "pending" };
  }
  if (now.failure !== null && now.failure !== sent.failureBefore) {
    return { kind: "failed", message: now.failure.message };
  }
  return sent.seenRestoring || now.sequence >= sent.acceptedAt
    ? { kind: "failed", message: null }
    : { kind: "pending" };
};
