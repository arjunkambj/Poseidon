/**
 * The write behind `files.create`: a new Markdown file under a workspace
 * root, and nothing else. It is how a plan card saves its plan, so it holds
 * the path to the containment `files.read` and `files.stat` do and adds the
 * two rules a write needs on top:
 *
 * - **Only new files.** The file is opened with the exclusive-create flag, so
 *   an existing file — or a symlink sitting at the name — fails with
 *   `conflict` and is never touched, even when two saves race.
 * - **Only inside the root.** The path is relative, stays under the root
 *   lexically, and the deepest folder that already exists on its way must
 *   resolve (symlinks followed) inside the canonical root before any missing
 *   folder is made, so a linked folder cannot carry the write outside.
 *
 * Only `FILES_CREATE_EXTENSION` is written: this saves notes, not code.
 */
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { FILES_CREATE_EXTENSION, PoseidonRpcError } from "@poseidon/contracts/rpc";

const invalid = (message: string) => new PoseidonRpcError({ code: "invalid", message });

/** `path` strictly inside `base`, or equal to it when `allowSelf`. */
const inside = (base: string, path: string, allowSelf: boolean): boolean => {
  const relative = nodePath.relative(base, path);
  if (relative.length === 0) return allowSelf;
  return (
    relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative)
  );
};

/** The deepest ancestor of `absolute` (itself excluded) that exists, stopping at `root`. */
const deepestExisting = async (root: string, absolute: string): Promise<string> => {
  let current = nodePath.dirname(absolute);
  while (current !== root && inside(root, current, false)) {
    try {
      await lstat(current);
      return current;
    } catch {
      current = nodePath.dirname(current);
    }
  }
  return root;
};

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

/**
 * Writes `content` to `path` under `root` and answers the path it wrote,
 * relative and `/`-separated. Rejects with a `PoseidonRpcError`: `invalid`
 * for a path it will not write, `conflict` when the file exists, `internal`
 * when the disk refuses.
 */
export const createWorkspaceFile = async (
  root: string,
  path: string,
  content: string,
): Promise<{ readonly path: string }> => {
  if (nodePath.isAbsolute(path)) {
    throw invalid(`the path must be relative to the workspace: ${path}`);
  }
  if (nodePath.extname(path).toLowerCase() !== FILES_CREATE_EXTENSION) {
    throw invalid(`only ${FILES_CREATE_EXTENSION} files can be created: ${path}`);
  }
  const base = nodePath.resolve(root);
  const absolute = nodePath.resolve(base, path);
  if (!inside(base, absolute, false)) {
    throw invalid(`path escapes the workspace: ${path}`);
  }
  let realRoot: string;
  try {
    realRoot = await realpath(base);
  } catch {
    throw new PoseidonRpcError({ code: "internal", message: "cannot resolve the workspace" });
  }
  // The folder the write lands in must stay inside the root once links are
  // followed; checked before `mkdir` so a linked folder makes nothing outside.
  const existing = await deepestExisting(base, absolute);
  const realExisting = await realpath(existing).catch(() => null);
  if (realExisting === null || !inside(realRoot, realExisting, true)) {
    throw invalid(`path escapes the workspace: ${path}`);
  }
  try {
    await mkdir(nodePath.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      throw new PoseidonRpcError({ code: "conflict", message: `${path} already exists` });
    }
    if (code === "ENOTDIR" || code === "EISDIR") {
      throw invalid(`cannot create ${path}: a file is in the way`);
    }
    throw new PoseidonRpcError({ code: "internal", message: `cannot write ${path}` });
  }
  return { path: nodePath.relative(base, absolute).split(nodePath.sep).join("/") };
};
