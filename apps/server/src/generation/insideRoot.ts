/**
 * Whether a file the prompt reads really sits inside the repository.
 *
 * A path joined onto the root can still lead out of it through a symbolic
 * link — a workspace link may point at /etc or ~/.ssh — and nothing outside
 * the repository may reach a third-party model. Both sides are compared as
 * canonical paths, as the file service does.
 */

import { realpathSync } from "node:fs";
import * as nodePath from "node:path";

/** The canonical path of `path` when it resolves inside `root`, else null. */
export const realPathInside = (root: string, path: string): string | null => {
  try {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(path);
    return realTarget === realRoot || realTarget.startsWith(realRoot + nodePath.sep)
      ? realTarget
      : null;
  } catch {
    return null;
  }
};
