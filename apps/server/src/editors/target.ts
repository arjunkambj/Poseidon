/**
 * The path `editors.open` hands an app, held to the workspace root the way
 * `files.stat` holds a path (`../git/stat.ts`): lexically first, then through
 * every symlink, so a `..`, an absolute path elsewhere or a link out of the
 * root never reaches a launch. Unlike a stat, the root itself is a valid
 * target — opening the workspace is the common case.
 */
import { realpath, stat } from "node:fs/promises";
import * as nodePath from "node:path";

export type ResolvedTarget =
  | { readonly ok: true; readonly path: string; readonly isDirectory: boolean }
  | { readonly ok: false; readonly reason: "invalid" | "not-found" };

/** Whether `path` is `base` or lies under it. */
const inside = (base: string, path: string): boolean => {
  const relative = nodePath.relative(base, path);
  if (relative.length === 0) return true;
  const escapes = relative === ".." || relative.startsWith(`..${nodePath.sep}`);
  return !escapes && !nodePath.isAbsolute(relative);
};

const missing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * `relativePath` under `root` — the root itself when it is empty or omitted —
 * as the absolute, symlink-resolved path an app is started with.
 */
export const resolveTarget = async (
  root: string,
  relativePath?: string,
): Promise<ResolvedTarget> => {
  if (relativePath?.includes("\0") === true) return { ok: false, reason: "invalid" };
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { ok: false, reason: "not-found" };
  }
  const lexicalRoot = nodePath.resolve(root);
  const absolute = nodePath.resolve(lexicalRoot, relativePath ?? "");
  if (!inside(lexicalRoot, absolute) && !inside(realRoot, absolute)) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const target = await realpath(absolute);
    if (!inside(realRoot, target)) return { ok: false, reason: "invalid" };
    const info = await stat(target);
    return { ok: true, path: target, isDirectory: info.isDirectory() };
  } catch (error) {
    return { ok: false, reason: missing(error) ? "not-found" : "invalid" };
  }
};
