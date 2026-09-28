/**
 * Where the changes sit in the Changes pane's list, with no DOM in the way:
 * the rows `./diff-dom` reads off an open file grouped into change blocks,
 * where the change keys stop, and where each change marks the scrollbar
 * (`./change-markers`).
 *
 * Every position is in the list's content, in px from its top — the space
 * `scrollTop` counts in — so a block's top is also the scroll position that
 * brings it to the top of the view.
 */

import type { GitDiffFile } from "@poseidon/contracts/rpc";

import { EDGE } from "./review";

/** What a block of changed lines does: only adds, only removes, or both. */
export type ChangeKind = "added" | "removed" | "mixed";

/** One changed line as `@pierre/diffs` renders it. */
export interface ChangeRow {
  readonly top: number;
  readonly bottom: number;
  readonly type: "change-addition" | "change-deletion";
}

/** A run of changed lines with no unchanged line between them. */
export interface ChangeBlock {
  readonly top: number;
  readonly bottom: number;
  readonly kind: ChangeKind;
}

const ROW_KIND: Record<ChangeRow["type"], ChangeKind> = {
  "change-addition": "added",
  "change-deletion": "removed",
};

/**
 * `rows` grouped into blocks: rows that touch or overlap are one block, and
 * any gap — an unchanged line, a hunk separator — starts the next. Split view
 * renders a removed line and the line that replaced it side by side, at one
 * height, so the two columns fold into one `mixed` block. The rows may come
 * in any order; the blocks come top to bottom.
 */
export const changeBlocks = (rows: ReadonlyArray<ChangeRow>): ReadonlyArray<ChangeBlock> => {
  const sorted = [...rows].sort((a, b) => a.top - b.top);
  const blocks: Array<{ top: number; bottom: number; kind: ChangeKind }> = [];
  for (const row of sorted) {
    const last = blocks.at(-1);
    const kind = ROW_KIND[row.type];
    if (last !== undefined && row.top <= last.bottom + 1) {
      last.bottom = Math.max(last.bottom, row.bottom);
      if (last.kind !== kind) {
        last.kind = "mixed";
      }
    } else {
      blocks.push({ top: row.top, bottom: row.bottom, kind });
    }
  }
  return blocks;
};

/**
 * The stop `changes.nextChange` (`direction` 1) or `previousChange` (-1)
 * moves to, as an index into `tops`, or `null` past either end.
 *
 * `tops` is each stop's scroll position (`changeStops`), top to bottom, and
 * `position` where the keys stand. `parked` says the keys stand on a block
 * they moved to themselves, and the list has not moved since: then the next
 * stop is strictly past it — which also walks the last stops, which cannot
 * scroll to the top. Otherwise `position` is the top of the view, and the next
 * stop is the first at or below it, so a file just opened lands on its first
 * change; the previous one is the last above it.
 */
export const nextChangeTarget = (
  tops: ReadonlyArray<number>,
  position: number,
  direction: 1 | -1,
  parked: boolean,
): number | null => {
  const target =
    direction === 1
      ? tops.findIndex((top) => (parked ? top > position + EDGE : top >= position - EDGE))
      : tops.findLastIndex((top) => top < position - EDGE);
  return target === -1 ? null : target;
};

/** Where a file's changes sit, as `readSections` in `./diff-dom` reads them. */
export interface SectionChanges {
  readonly top: number;
  /** The file's sticky row: a change scrolled to the top would sit under it. */
  readonly header: number;
  readonly blocks: ReadonlyArray<ChangeBlock>;
}

/**
 * One place the change keys stop, at the scroll position that shows it:
 * a block of an open file, just under the file's sticky row, or a closed file
 * with a patch, at its header — stopping there `opens` it.
 */
export interface ChangeStop {
  /** The file's index. */
  readonly index: number;
  readonly top: number;
  readonly opens: boolean;
}

/**
 * Every stop in the list, top to bottom. `closed[i]` says file `i` has a
 * patch and is closed, so it is one stop of its own; an open file stops at
 * each of its blocks, and one with nothing rendered yet not at all.
 */
export const changeStops = (
  sections: ReadonlyArray<SectionChanges>,
  closed: ReadonlyArray<boolean>,
): ReadonlyArray<ChangeStop> =>
  sections.flatMap((section, index): ReadonlyArray<ChangeStop> =>
    closed[index] === true
      ? [{ index, top: section.top, opens: true }]
      : section.blocks.map((block) => ({ index, top: block.top - section.header, opens: false })),
  );

/** How a closed file shows on the scrollbar: by what the whole file does. */
export const fileChangeKind = (kind: GitDiffFile["kind"]): ChangeKind =>
  kind === "create" ? "added" : kind === "delete" ? "removed" : "mixed";

/** Something to mark on the scrollbar, in the list's px. */
export interface MarkerItem {
  readonly top: number;
  readonly height: number;
  readonly kind: ChangeKind;
  /** The scroll position a click on the mark moves to. */
  readonly target: number;
}

/**
 * What the scrollbar marks: one mark per block of an open file, and one at
 * the header of any other file, coloured by what the file does — so a closed
 * file, or an open one whose patch has not rendered, still shows where it is.
 * `open[i]` says file `i` is open.
 */
export const markerItems = (
  sections: ReadonlyArray<SectionChanges & { readonly bottom: number }>,
  files: ReadonlyArray<Pick<GitDiffFile, "kind">>,
  open: ReadonlyArray<boolean>,
): ReadonlyArray<MarkerItem> =>
  sections.flatMap((section, index): ReadonlyArray<MarkerItem> => {
    const file = files[index];
    if (file === undefined) {
      return [];
    }
    if (open[index] === true && section.blocks.length > 0) {
      return section.blocks.map((block) => ({
        top: block.top,
        height: block.bottom - block.top,
        kind: block.kind,
        target: block.top - section.header,
      }));
    }
    return [
      {
        top: section.top,
        height: section.header,
        kind: fileChangeKind(file.kind),
        target: section.top,
      },
    ];
  });

/** The least height a mark is drawn at, in px of the track, so a one-line change still shows. */
export const MARKER_MIN_HEIGHT = 3;

/**
 * `items` scaled onto a track `trackHeight` px tall standing for a list
 * `contentHeight` px tall: each mark's top and height as percentages of the
 * track (its `target` stays in px), at
 * least `MARKER_MIN_HEIGHT` px tall and kept inside the track. Nothing when
 * either height is not positive.
 */
export const markerLayout = (
  items: ReadonlyArray<MarkerItem>,
  contentHeight: number,
  trackHeight: number,
): ReadonlyArray<MarkerItem> => {
  if (contentHeight <= 0 || trackHeight <= 0) {
    return [];
  }
  const least = Math.min(100, (MARKER_MIN_HEIGHT / trackHeight) * 100);
  return items.map((item) => {
    const height = Math.min(100, Math.max(least, (item.height / contentHeight) * 100));
    const top = Math.min(100 - height, Math.max(0, (item.top / contentHeight) * 100));
    return { ...item, top, height };
  });
};
