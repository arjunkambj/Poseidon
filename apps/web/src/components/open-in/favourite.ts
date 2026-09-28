/**
 * Which detected app the "Open in" control and the file menus lead with, and
 * whether there is anything to show at all.
 *
 * The favourite is the stored `preferredEditor` when this machine has it and
 * it is an editor, else the first editor found; the file manager and the
 * terminal are listed in the menus but never become the button's main half.
 * An id this build does not know, or one not installed here, is treated as
 * unset rather than as an error.
 */

import type { DetectedEditor } from "@poseidon/contracts/editors";

/** The detected editors proper, in the server's order, without Finder and Terminal. */
export const editorsOnly = (
  editors: ReadonlyArray<DetectedEditor>,
): ReadonlyArray<DetectedEditor> => editors.filter((editor) => editor.kind === "editor");

export const pickFavourite = (
  editors: ReadonlyArray<DetectedEditor>,
  preferredId: string | null | undefined,
): DetectedEditor | null => {
  const candidates = editorsOnly(editors);
  return candidates.find((editor) => editor.id === preferredId) ?? candidates[0] ?? null;
};

/** The header control shows only when there is an editor to open, not just Finder. */
export const showOpenIn = (editors: ReadonlyArray<DetectedEditor>): boolean =>
  editorsOnly(editors).length > 0;

/**
 * A workspace-relative path made absolute under `root`, for "Copy path". The
 * separator follows the root's, so a Windows root keeps its backslashes; an
 * empty or `.` path is the root itself.
 */
export const absolutePath = (root: string, relative: string): string => {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.length > 1 ? root.replace(/[\\/]+$/, "") : root;
  const rest = relative
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join(separator);
  if (rest.length === 0) return base;
  return base.endsWith(separator) ? `${base}${rest}` : `${base}${separator}${rest}`;
};
