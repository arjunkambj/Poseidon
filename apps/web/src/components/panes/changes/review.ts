/**
 * How the Changes pane reads a review, with no React in the way.
 *
 * The list is an overview first: every file starts as one closed row, and the
 * user opens what they want to read. What they open or close is kept per
 * thread and per path (`ChangesReview` in `@/state/ui`), so it outlives the
 * comparison it was made in. These are the rules over that record; the pane
 * only renders them.
 */

import type { GitDiffFile } from "@poseidon/contracts/rpc";

import type { ChangesReview } from "@/state/ui";

/**
 * Whether `path` is open: the user's own choice for it, else closed. Nothing
 * opens on its own — every open file hands its patch to the two-worker
 * highlight pool, and the pane loads no patch the user did not ask to read.
 */
export const isOpen = (review: ChangesReview, path: string): boolean => review.open[path] ?? false;

/** The review with every path in `paths` opened or closed, as if each were clicked. */
export const withOpen = (
  review: ChangesReview,
  paths: ReadonlyArray<string>,
  open: boolean,
): ChangesReview => {
  const next = { ...review.open };
  for (const path of paths) {
    next[path] = open;
  }
  return { ...review, open: next };
};

/**
 * Whether the summary line's toggle collapses: every file that has a patch to
 * show is open. Anything less and it expands, so one click always opens the
 * lot — the same way a mixed selection's checkbox checks everything first.
 */
export const everyFileOpen = (
  review: ChangesReview,
  files: ReadonlyArray<Pick<GitDiffFile, "path" | "diff">>,
): boolean => {
  const expandable = files.filter((file) => file.diff !== "");
  return expandable.length > 0 && expandable.every((file) => isOpen(review, file.path));
};

/**
 * A cheap fingerprint of one patch — FNV-1a over its text, with the length
 * beside it — for the viewed marks. It only has to notice that a file's patch
 * moved since it was marked, not resist anyone, so a 32-bit hash is plenty.
 */
export const patchHash = (patch: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < patch.length; index += 1) {
    hash ^= patch.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${patch.length.toString(36)}.${(hash >>> 0).toString(36)}`;
};

/** Whether `path` is marked viewed for the patch it has now; a mark on an older patch has lapsed. */
export const isViewed = (review: ChangesReview, path: string, hash: string): boolean =>
  review.viewed[path] === hash;

/**
 * The review with `path` marked viewed against `hash`, or unmarked for `null`.
 * Marking also closes the file — a file read is a file done with — while
 * unmarking leaves it as it is.
 */
export const withViewed = (
  review: ChangesReview,
  path: string,
  hash: string | null,
): ChangesReview => {
  if (hash === null) {
    const viewed = { ...review.viewed };
    delete viewed[path];
    return { ...review, viewed };
  }
  return {
    open: { ...review.open, [path]: false },
    viewed: { ...review.viewed, [path]: hash },
  };
};

/** How many of `files` are viewed as they are now. */
export const viewedCount = (
  review: ChangesReview,
  files: ReadonlyArray<{ readonly path: string; readonly hash: string }>,
): number => files.filter((file) => isViewed(review, file.path, file.hash)).length;

/**
 * The file "Next unviewed" (`changes.nextUnviewed`) moves to, as an index: the
 * first file after `cursor` not viewed as it is now, wrapping round to the
 * top, and the cursor's own file last. `null` once every file is viewed.
 * `cursor` is `-1` for none, which starts from the first file.
 */
export const nextUnviewed = (
  files: ReadonlyArray<{ readonly path: string; readonly hash: string }>,
  review: ChangesReview,
  cursor: number,
): number | null => {
  for (let step = 1; step <= files.length; step += 1) {
    const index = (Math.max(cursor, -1) + step + files.length) % files.length;
    const file = files[index];
    if (file !== undefined && !isViewed(review, file.path, file.hash)) {
      return index;
    }
  }
  return null;
};

/**
 * How far off an edge a position may sit and still count as parked there, in
 * px — a header at the top, or a change the keys last moved to.
 */
export const EDGE = 2;

/**
 * The file `changes.nextFile` (`direction` 1) or `previousFile` (-1) moves to,
 * as an index, or `null` past either end.
 *
 * `tops` is each file's top edge against the list's visible top, in px, and
 * `viewHeight` how much of the list shows. `cursor` is the file the keys last
 * moved to (or the one last clicked), `-1` for none. While that file's header
 * is still on screen the keys step from it — at the end of the list the last
 * files cannot scroll to the top, and stepping by position there would never
 * get past the first of them. Once the user has scrolled it away, the keys go
 * by what shows: the next header at or below the top edge, or the last one
 * above it, which is the start of the file being read.
 */
export const stepFile = (
  tops: ReadonlyArray<number>,
  viewHeight: number,
  cursor: number,
  direction: 1 | -1,
): number | null => {
  const cursorTop = cursor < 0 ? undefined : tops[cursor];
  const parked = cursorTop !== undefined && cursorTop >= -EDGE && cursorTop < viewHeight;
  const target = parked
    ? cursor + direction
    : direction === 1
      ? tops.findIndex((top) => top >= -EDGE)
      : tops.findLastIndex((top) => top < -EDGE);
  return target >= 0 && target < tops.length ? target : null;
};

/**
 * Whether a row has nothing to open only because whitespace is ignored: with
 * `-w` the server sends a plain edit whose every change was whitespace with an
 * empty patch (a rename or a binary edit keeps its own), so the row says so
 * instead of reading as an edit that changed nothing.
 */
export const isWhitespaceOnly = (
  file: Pick<GitDiffFile, "kind" | "oldPath" | "diff">,
  ignoreWhitespace: boolean,
): boolean =>
  ignoreWhitespace && file.kind === "edit" && file.oldPath === undefined && file.diff === "";
