/**
 * Finding one line of a file's rendered diff, for a link that names a line
 * (`./deep-link`).
 *
 * The diff renders into the open shadow root of its `diffs-container`, off
 * the main thread and some frames after the file opens, so the row is looked
 * for once a frame until it shows or `LINE_TRIES` frames have passed — a line
 * the diff does not show (outside every hunk) simply is not scrolled to. Each
 * row carries its line number (`data-line`) and kind (`data-line-type`); the
 * link's line is on the new side, so a deleted row never matches, and in a
 * split diff the old side's column (`code[data-deletions]`) is skipped.
 */

import { DIFFS_TAG_NAME } from "@pierre/diffs";

/** About two seconds of frames: long enough for a large diff to highlight. */
const LINE_TRIES = 120;

/** What `findDiffLine` reads: `Element.querySelector`, with the host's shadow root. */
export interface LineSearchRoot {
  querySelector(selector: string): { readonly shadowRoot: LineSearchRoot | null } | null;
}

/** A selector for the rows of `line` on the new side: not deleted, not in the old column. */
export const newSideRow = (line: number): string =>
  `code:not([data-deletions]) [data-line="${line}"]:not([data-line-type="change-deletion"])`;

/** The rendered row of `line` on the new side of the diff under `section`, or `null`. */
export const findDiffLine = <Row>(section: LineSearchRoot, line: number): Row | null => {
  const root = section.querySelector(DIFFS_TAG_NAME)?.shadowRoot ?? null;
  return (root?.querySelector(newSideRow(line)) as Row | null | undefined) ?? null;
};

export interface FrameClock {
  readonly request: (callback: () => void) => number;
  readonly cancel: (handle: number) => void;
}

const animationFrames: FrameClock = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * Calls `onFound` with the row of `line` once it has rendered, looking once a
 * frame for at most `tries` frames. Returns a cancel for an effect's cleanup.
 */
export const whenDiffLine = <Row>(
  section: LineSearchRoot,
  line: number,
  onFound: (row: Row) => void,
  clock: FrameClock = animationFrames,
  tries: number = LINE_TRIES,
): (() => void) => {
  let left = tries;
  let handle: number | null = null;
  const look = () => {
    handle = null;
    const row = findDiffLine<Row>(section, line);
    if (row !== null) {
      onFound(row);
      return;
    }
    left -= 1;
    if (left > 0) {
      handle = clock.request(look);
    }
  };
  look();
  return () => {
    if (handle !== null) {
      clock.cancel(handle);
    }
  };
};
