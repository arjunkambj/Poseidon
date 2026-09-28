/**
 * Marks along the right edge of the Changes list's scroller: where each change
 * sits in the whole list, the way an editor marks its scrollbar. An open file
 * marks each block of changed lines — green adds, red removes, grey both — and
 * any other file one mark at its header, coloured by what the file does
 * (`markerItems`). Clicking a mark scrolls there and parks the change keys on
 * it (`jumpTo` from `useChangeNavigation`).
 *
 * The track lets the pointer through everywhere but on a mark, and sits just
 * inside a scrollbar that takes up room. The marks are for the pointer: the
 * change keys reach the same places from the keyboard. Nothing shows while the
 * list fits without scrolling.
 */

import type { GitDiffFile } from "@poseidon/contracts/rpc";
import type * as React from "react";

import { cn } from "@/lib/utils";

import { type ChangeKind, markerItems, markerLayout } from "./change-blocks";
import type { ReviewLayout } from "./use-review-layout";

const KIND_CLASS: Record<ChangeKind, string> = {
  added: "bg-added",
  removed: "bg-removed",
  mixed: "bg-muted-foreground",
};

const KIND_LABEL: Record<ChangeKind, string> = {
  added: "an addition",
  removed: "a removal",
  mixed: "a change",
};

export function ChangeMarkers({
  layout,
  files,
  open,
  onJump,
}: {
  layout: ReviewLayout;
  files: ReadonlyArray<GitDiffFile>;
  /** Whether each file, by index, is open. */
  open: ReadonlyArray<boolean>;
  onJump: (target: number) => void;
}) {
  if (layout.contentHeight <= layout.viewHeight + 1) {
    return null;
  }
  const markers = markerLayout(
    markerItems(layout.sections, files, open),
    layout.contentHeight,
    layout.viewHeight,
  );
  return (
    <div
      // Computed: just inside a scrollbar that takes up room.
      style={{ "--marker-right": `${layout.scrollbar}px` } as React.CSSProperties}
      className="pointer-events-none absolute inset-y-0 right-(--marker-right) z-20 w-1"
    >
      {markers.map((marker) => (
        <button
          key={`${marker.target}-${marker.kind}`}
          type="button"
          tabIndex={-1}
          aria-label={`Scroll to ${KIND_LABEL[marker.kind]}`}
          className={cn(
            "pointer-events-auto absolute inset-x-0 top-(--marker-top) h-(--marker-height) cursor-pointer rounded-full opacity-70 hover:opacity-100",
            KIND_CLASS[marker.kind],
          )}
          // Computed: where the change sits in the whole list, as a share of the track.
          style={
            {
              "--marker-top": `${marker.top}%`,
              "--marker-height": `${marker.height}%`,
            } as React.CSSProperties
          }
          onClick={() => onJump(marker.target)}
        />
      ))}
    </div>
  );
}
