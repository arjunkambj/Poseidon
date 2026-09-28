/**
 * Typed workspace roots, checked before they become a `project.create` the
 * server can only answer with a rejection reason.
 *
 * This is deliberately shallow — the renderer cannot stat a directory, and
 * `@poseidon/shared/paths` is server-side (it is not on the renderer's import
 * list). It catches the mistakes that are visible in the string itself: a
 * relative path, and a `~` nothing will expand.
 */

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** Why this path cannot be a workspace root, or `null` when it looks usable. */
export const workspacePathProblem = (path: string): string | null => {
  const trimmed = path.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.startsWith("~")) {
    return "Use the full path — ~ is not expanded.";
  }
  if (!trimmed.startsWith("/") && !WINDOWS_ABSOLUTE.test(trimmed)) {
    return "Enter an absolute path, starting at the root of the disk.";
  }
  return null;
};

/**
 * The directory's own name — what a project is called unless the user renames
 * it. Trailing separators are ignored so `/Users/you/code/my-app/` still reads
 * `my-app`.
 */
export const projectNameFromPath = (path: string): string => {
  const segments = path
    .trim()
    .split(/[\\/]+/u)
    .filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? "";
};

/**
 * The project name once `picked` replaces `previousRoot` as the chosen
 * folder: the new folder's name, unless the user typed a name of their own —
 * one that is neither empty nor the old folder's name.
 */
export const nameAfterPick = (current: string, previousRoot: string, picked: string): string =>
  current.trim() === "" || current === projectNameFromPath(previousRoot)
    ? projectNameFromPath(picked)
    : current;
