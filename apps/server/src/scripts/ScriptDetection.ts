/**
 * `scripts.detect` behind the `ScriptDetection` Tag: the package.json scripts
 * of a workspace root and of the monorepo packages it declares, each with the
 * command that runs it from the root.
 *
 * The root is the thread's own when the call names a live thread of the
 * project (its worktree), the project's otherwise — the same resolution
 * `files.*` and `editors.open` make. Every read stays inside that root: a
 * workspace directory, or a package.json, whose real path leaves it is
 * skipped, so a symlinked package cannot pull a file from elsewhere into the
 * list. Detection reads a handful of small files and runs on every call; the
 * client asks only when the Run menu opens.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import * as nodePath from "node:path";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import type { DetectedScript } from "@poseidon/contracts/scripts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveWorkspaceRoot } from "../orchestration/workspaceRoot";
import { ReadModelStore } from "../persistence/ReadModels";
import type { WorkspaceScope } from "../rpc/services";
import {
  detectedScripts,
  expandPatterns,
  type FoundPackage,
  LOCKFILES,
  MAX_PACKAGES,
  packageManagerOf,
  workspacePatterns,
} from "./detect";

/** A package.json or pnpm-workspace.yaml larger than this is not read. */
const MAX_FILE_BYTES = 1024 * 1024;
/** Directory entries a wildcard lists before it stops looking. */
const MAX_DIR_ENTRIES = 2000;

export class ScriptDetection extends Context.Service<
  ScriptDetection,
  {
    readonly detect: (
      scope: WorkspaceScope,
    ) => Effect.Effect<ReadonlyArray<DetectedScript>, PoseidonRpcError>;
  }
>()("server/scripts/ScriptDetection") {
  /** Finds nothing anywhere: for a server graph that does not need scripts. */
  static readonly empty = Layer.succeed(
    ScriptDetection,
    ScriptDetection.of({ detect: () => Effect.succeed([]) }),
  );
}

/** Whether the real path `target` is `realRoot` or lies under it. */
const inside = (realRoot: string, target: string): boolean => {
  const relative = nodePath.relative(realRoot, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${nodePath.sep}`) &&
      !nodePath.isAbsolute(relative))
  );
};

/** `root/relative` by its real path when that stays inside the root, else null. */
const contained = async (realRoot: string, relative: string): Promise<string | null> => {
  try {
    const target = await realpath(nodePath.join(realRoot, relative));
    return inside(realRoot, target) ? target : null;
  } catch {
    return null;
  }
};

/** A small file inside the root as text, or null when missing, too big or outside. */
const readContained = async (realRoot: string, relative: string): Promise<string | null> => {
  const target = await contained(realRoot, relative);
  if (target === null) return null;
  try {
    const info = await stat(target);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await readFile(target, "utf8");
  } catch {
    return null;
  }
};

/** A package.json parsed, or null when it is missing or not JSON. */
const readPackageJson = async (realRoot: string, dir: string): Promise<unknown> => {
  const text = await readContained(realRoot, nodePath.join(dir, "package.json"));
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

/** The subdirectory names of a directory inside the root; none when it leaves it. */
const listDirIn = (realRoot: string) => async (dir: string) => {
  const target = await contained(realRoot, dir);
  if (target === null) return [];
  try {
    const entries = await readdir(target, { withFileTypes: true });
    return entries
      .slice(0, MAX_DIR_ENTRIES)
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

const present = async (realRoot: string, name: string) =>
  (await contained(realRoot, name)) === null ? null : name;

/** Every script the workspace at `root` declares. A root that is gone lists none. */
const detectWorkspaceScripts = async (root: string): Promise<ReadonlyArray<DetectedScript>> => {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return [];
  }
  const rootPackageJson = await readPackageJson(realRoot, "");
  const pnpmYaml = await readContained(realRoot, "pnpm-workspace.yaml");
  if (rootPackageJson === null && pnpmYaml === null) return [];

  const lockfiles = new Set(
    (await Promise.all(LOCKFILES.map((name) => present(realRoot, name)))).filter(
      (name): name is string => name !== null,
    ),
  );
  const field =
    typeof rootPackageJson === "object" && rootPackageJson !== null
      ? (rootPackageJson as Record<string, unknown>)["packageManager"]
      : undefined;
  const packageManager = packageManagerOf(field, lockfiles);

  const packages: Array<FoundPackage> =
    rootPackageJson === null ? [] : [{ dir: "", packageJson: rootPackageJson }];
  const dirs = await expandPatterns(
    workspacePatterns(pnpmYaml, rootPackageJson),
    listDirIn(realRoot),
  );
  for (const dir of dirs) {
    if (packages.length >= MAX_PACKAGES) break;
    const packageJson = await readPackageJson(realRoot, dir);
    if (packageJson !== null) packages.push({ dir, packageJson });
  }
  return detectedScripts(packageManager, packages);
};

export const layer = Layer.effect(
  ScriptDetection,
  Effect.gen(function* () {
    const readModels = yield* ReadModelStore;
    return ScriptDetection.of({
      detect: (scope) =>
        Effect.gen(function* () {
          const root = yield* resolveWorkspaceRoot(
            readModels,
            scope.projectId,
            scope.threadId,
          ).pipe(
            Effect.mapError(
              () => new PoseidonRpcError({ code: "internal", message: "project lookup failed" }),
            ),
          );
          if (root === null) {
            return yield* new PoseidonRpcError({ code: "not-found", message: "unknown project" });
          }
          return yield* Effect.promise(() => detectWorkspaceScripts(root));
        }),
    });
  }),
);
