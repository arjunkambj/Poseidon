/**
 * What the timeline keeps of the reader's place when they leave a thread, and
 * where it puts them back when the thread reopens. Pure; the store is
 * `state/timeline-positions.ts`.
 *
 * - A list at (or near) its end saves nothing: it reopens at its end and keeps
 *   following, as a thread always has.
 * - A list anchored on a message just sent saves nothing either: the reply is
 *   streaming under it, and the latest is what the reader came back for.
 * - Otherwise the first row on screen is saved with where its top sat, the
 *   same `{ rowId, offset }` a bulk fold change holds in place (`viewAnchors`).
 *
 * Restoring needs the saved row in today's projection. A row can be gone —
 * the live burst of a turn that settled since folds into its turn — and then
 * the list opens at its end, as it would with nothing saved.
 */

import type { TimelinePosition } from "@/state/timeline-positions";

import type { TimelineRow } from "./fold";
import type { SendAnchorMode, ViewAnchor } from "./send-anchor";

export interface PositionToSaveInput {
  /** The list sits at its end, or within the distance it keeps following from. */
  readonly atEnd: boolean;
  readonly mode: SendAnchorMode;
  /** The rows on screen, top first (`viewAnchors`). */
  readonly anchors: ReadonlyArray<ViewAnchor>;
}

/** The position to keep for a thread being left; null keeps none. */
export const positionToSave = ({
  atEnd,
  mode,
  anchors,
}: PositionToSaveInput): TimelinePosition | null => {
  if (atEnd || mode === "anchored") {
    return null;
  }
  const first = anchors[0];
  return first === undefined ? null : { rowKey: first.rowId, offset: first.offset };
};

/** Where a reopened list starts: the saved row's index and offset, if it is still there. */
export const restoreTarget = (
  rows: ReadonlyArray<TimelineRow>,
  saved: TimelinePosition | undefined,
): { readonly index: number; readonly offset: number } | undefined => {
  if (saved === undefined) {
    return undefined;
  }
  const index = rows.findIndex((row) => row.id === saved.rowKey);
  return index === -1 ? undefined : { index, offset: saved.offset };
};
