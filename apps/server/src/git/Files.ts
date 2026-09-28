/**
 * `files.search`, `files.read` and `files.stat` behind the `Files` Tag. Search
 * walks tracked plus untracked-but-not-ignored paths via `git ls-files`, so
 * .gitignore is honored for free; a per-root cache keyed off `.git/index` mtime
 * keeps repeat queries warm (the composer hits this on every `#` keystroke).
 * Stat checks a batch of paths for existence under the root (`stat.ts`), and
 * `files.create` writes a new Markdown file there (`create.ts`).
 *
 * All four run in the thread's own root when the call names a thread (its
 * worktree, when it has one), and in the project's root otherwise.
 *
 * A project need not be a git repository, so a
 * workspace that is not one (or a machine with no usable `git`) falls back to
 * the ignore-aware filesystem walk in `walk.ts` rather than failing the RPC.
 */
import { statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import * as nodePath from "node:path";
import type { FileSearchResult } from "@poseidon/contracts/rpc";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PoseidonRpcError } from "@poseidon/contracts/rpc";

import { resolveWorkspaceRoot } from "../orchestration/workspaceRoot";
import { ReadModelStore } from "../persistence/ReadModels";
import { FileService, type WorkspaceScope } from "../rpc/services";
import { createWorkspaceFile } from "./create";
import { isRepository, run } from "./process";
import { readFileWindow } from "./read";
import { statWorkspacePaths } from "./stat";
import { walkWorkspace } from "./walk";

class FileServiceError extends Data.TaggedError("FileServiceError")<{
  readonly message: string;
}> {}

const toRpcError = (error: FileServiceError) =>
  new PoseidonRpcError({ code: "internal", message: error.message });

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
/** A cached file list stays warm for this long — typing bursts hit it. */
const CACHE_TTL_MS = 1500;

interface ListingEntry {
  readonly path: string;
  readonly name: string;
  readonly isDirectory: boolean;
}

interface ListingCacheEntry {
  readonly stamp: number;
  readonly indexMtimeMs: number;
  readonly entries: ReadonlyArray<ListingEntry>;
}

const matches = (entry: ListingEntry, query: string): number | null => {
  // Substring match on the path, weighted toward basename hits so the most
  // useful rows sort first — good enough for an @-composer.
  const path = entry.path.toLowerCase();
  const name = entry.name.toLowerCase();
  const q = query.toLowerCase();
  const nameHit = name.indexOf(q);
  if (nameHit >= 0) return nameHit;
  const pathHit = path.indexOf(q);
  return pathHit >= 0 ? 1000 + pathHit : null;
};

const entryFor = (path: string, isDirectory: boolean): ListingEntry => ({
  path,
  name: nodePath.basename(path),
  isDirectory,
});

/**
 * `git ls-files` yields blobs only, so the directories a user can also mention
 * are read back off the paths: every prefix of every listed file is a
 * directory that exists. Without this `isDirectory` would be structurally
 * false on every row and the files tab would have nothing to navigate.
 */
const withDirectories = (paths: ReadonlyArray<string>): ReadonlyArray<ListingEntry> => {
  const directories = new Set<string>();
  for (const path of paths) {
    let cut = path.lastIndexOf("/");
    while (cut > 0) {
      const directory = path.slice(0, cut);
      if (directories.has(directory)) break;
      directories.add(directory);
      cut = directory.lastIndexOf("/");
    }
  }
  return [
    ...paths.map((path) => entryFor(path, false)),
    ...[...directories].map((path) => entryFor(path, true)),
  ];
};

/** The fast path: everything git tracks or would track under `root`. */
const trackedEntries = (root: string) =>
  run(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).pipe(
    Effect.map((result) => withDirectories(result.stdout.split("\0").filter(Boolean))),
    Effect.mapError(
      (error) => new FileServiceError({ message: `git ls-files failed: ${error.message}` }),
    ),
  );

/** The fallback for a workspace git does not know about. */
const walkedEntries = (root: string) =>
  Effect.tryPromise({
    try: async () => (await walkWorkspace(root)).map((e) => entryFor(e.path, e.isDirectory)),
    catch: (error) =>
      new FileServiceError({ message: `cannot list the project: ${String(error)}` }),
  });

const indexMtime = (root: string): number => {
  try {
    return statSync(nodePath.join(root, ".git", "index")).mtimeMs;
  } catch {
    return 0;
  }
};

export const layer = Layer.effect(
  FileService,
  Effect.gen(function* () {
    const readModels = yield* ReadModelStore;
    const cache = new Map<string, ListingCacheEntry>();

    /** The thread's root when the scope names one, the project's otherwise. */
    const workspaceRoot = (scope: WorkspaceScope) =>
      resolveWorkspaceRoot(readModels, scope.projectId, scope.threadId).pipe(
        Effect.mapError(
          (error) => new FileServiceError({ message: `project lookup failed: ${error.message}` }),
        ),
      );

    const listFiles = (root: string) =>
      Effect.gen(function* () {
        const cached = cache.get(root);
        const stamp = indexMtime(root);
        if (
          cached !== undefined &&
          cached.indexMtimeMs === stamp &&
          Date.now() - cached.stamp < CACHE_TTL_MS
        ) {
          return cached.entries;
        }
        // A plain folder — or a machine whose `git` cannot be spawned — is a
        // perfectly valid project, so the probe decides which listing runs
        // rather than letting `ls-files` exit 128 into an RPC error.
        const repo = yield* isRepository(root).pipe(Effect.catch(() => Effect.succeed(false)));
        const entries = repo ? yield* trackedEntries(root) : yield* walkedEntries(root);
        cache.set(root, { stamp: Date.now(), indexMtimeMs: stamp, entries });
        return entries;
      });

    const service = FileService.of({
      search: (scope, query, limit = DEFAULT_SEARCH_LIMIT) =>
        Effect.gen(function* () {
          const root = yield* workspaceRoot(scope);
          if (root === null || query.length === 0) return [];
          const entries = yield* listFiles(root);
          const scored: Array<{ entry: ListingEntry; score: number }> = [];
          for (const entry of entries) {
            const score = matches(entry, query);
            if (score !== null) scored.push({ entry, score });
          }
          // Equal-scoring files come before directories: `#` usually means a
          // file, and the containing directory would otherwise outrank it.
          scored.sort(
            (a, b) =>
              a.score - b.score ||
              Number(a.entry.isDirectory) - Number(b.entry.isDirectory) ||
              a.entry.path.localeCompare(b.entry.path),
          );
          const cap = Math.min(Math.max(limit, 1), MAX_SEARCH_LIMIT);
          return scored.slice(0, cap).map(({ entry }): FileSearchResult => ({
            path: entry.path,
            name: entry.name,
            isDirectory: entry.isDirectory,
          }));
        }).pipe(Effect.mapError(toRpcError)),

      read: (scope, path, offset = 0, limit) =>
        Effect.gen(function* () {
          const root = yield* workspaceRoot(scope);
          if (root === null) {
            return { path, text: "", totalLines: 0, truncated: false };
          }
          const absolute = nodePath.resolve(root, path);
          if (!absolute.startsWith(nodePath.resolve(root) + nodePath.sep)) {
            return yield* new FileServiceError({
              message: `path escapes the project root: ${path}`,
            });
          }
          // Lexical containment misses symlinks — a workspace link can point
          // at /etc or ~/.ssh and still resolve under the root string.
          // Compare canonical paths on both sides instead.
          const realRoot = yield* Effect.tryPromise({
            try: () => realpath(root),
            catch: () => new FileServiceError({ message: "cannot resolve the project root" }),
          });
          const realTarget = yield* Effect.tryPromise({
            try: () => realpath(absolute),
            catch: () => new FileServiceError({ message: `cannot read ${path}` }),
          });
          if (realTarget !== realRoot && !realTarget.startsWith(realRoot + nodePath.sep)) {
            return yield* new FileServiceError({
              message: `path escapes the project root: ${path}`,
            });
          }
          return yield* Effect.tryPromise({
            try: () => readFileWindow(realTarget, path, offset, limit),
            catch: () => new FileServiceError({ message: `cannot read ${path}` }),
          });
        }).pipe(Effect.mapError(toRpcError)),

      stat: (scope, paths) =>
        Effect.gen(function* () {
          const root = yield* workspaceRoot(scope);
          if (root === null || paths.length === 0) return [];
          // `statWorkspacePaths` settles every path on its own and never rejects.
          return yield* Effect.promise(() => statWorkspacePaths(root, paths));
        }).pipe(Effect.mapError(toRpcError)),

      create: (scope, path, content) =>
        Effect.gen(function* () {
          const root = yield* workspaceRoot(scope).pipe(Effect.mapError(toRpcError));
          if (root === null) {
            return yield* new PoseidonRpcError({
              code: "not-found",
              message: "the workspace is not known",
            });
          }
          // `createWorkspaceFile` rejects only with the error the client is to see.
          return yield* Effect.tryPromise({
            try: () => createWorkspaceFile(root, path, content),
            catch: (error) =>
              error instanceof PoseidonRpcError
                ? error
                : new PoseidonRpcError({ code: "internal", message: `cannot write ${path}` }),
          });
        }),
    });

    return service;
  }),
);
