/**
 * The file half of the client runtime: the atoms the dock's Files tab reads,
 * and the existence check the timeline's path links need.
 *
 * - `fileSearchAtom(query)` — `files.search` over the project's ignore-aware
 *   listing. The server already honours `.gitignore` (and falls back to a
 *   filesystem walk for a folder git does not track), so the renderer asks for
 *   matches and renders whatever comes back.
 * - `fileContentAtom(window)` — one `files.read` window. `offset`/`limit` are
 *   the contract's paging interface, which is how the pane reaches line 20,000
 *   of a file the server would otherwise truncate at its byte cap.
 * - `fileStatAtom(batch)` — `files.stat` over a set of candidate paths, to
 *   learn which exist inside the workspace. The key is the sorted, deduplicated
 *   set, so one message's candidates make one call whatever order they were
 *   found in, and asking again for the same set reads the cached answer —
 *   for five minutes after its last reader, so a timeline row that scrolls
 *   away and back does not ask again. The key's `revision` names the state
 *   of the workspace, so once files may have been created or removed the
 *   caller asks anew rather than reading an answer that no longer holds.
 * - `statFiles(registry, batch)` — the same question as a one-shot call that
 *   resolves with its own `Exit`, for a caller that caches its own answers.
 *
 * The shapes mirror `gitAtoms` on purpose, for the same two reasons:
 *
 * 1. Each atom is a **stream driven by the connection's status** rather than a
 *    one-shot effect, so a pane mounted while connected fetches immediately and
 *    a reconnect refetches by itself. Offline the stream stays silent and the
 *    atom stays `Initial`, which the pane pairs with the connection state and
 *    reports as "not connected" instead of "no files".
 * 2. A failed RPC is a **value** (`FileQuery`), not the atom's error channel. A
 *    bad path must not tear the stream down, or the next reconnect would have
 *    nothing left to refetch on.
 *
 * Additive on purpose: `makeFileAtoms` takes the `AtomRuntime` the app already
 * built, so these atoms share the one socket with everything else.
 */

import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import { FILES_STAT_MAX_PATHS } from "@poseidon/contracts/rpc";
import type { FileContent, FileSearchResult, FileStat } from "@poseidon/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Atom from "effect/unstable/reactivity/Atom";
import type * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";

import { Connection, ConnectionStateRef } from "./connection";
import { runOneShot } from "./oneShot";

/**
 * A file RPC's outcome as a value. `error` carries the server's message — "path
 * escapes the project root", "cannot read …" — so the pane can show what went
 * wrong and offer a retry instead of rendering an empty file that looks real.
 */
export type FileQuery<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "error"; readonly message: string };

const ok = <A>(value: A): FileQuery<A> => ({ _tag: "ok", value });
const failed = <A>(message: string): FileQuery<A> => ({ _tag: "error", message });

/**
 * One `files.search` call. `limit` omitted means the server's own default;
 * `threadId` searches that thread's own root (its worktree, when it has one)
 * instead of the project's.
 */
export interface FileSearchKey {
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId | undefined;
  readonly query: string;
  readonly limit?: number | undefined;
}

/** One `files.read` window: lines `[offset, offset + limit)` of `path`. */
export interface FileWindowKey {
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId | undefined;
  readonly path: string;
  readonly offset: number;
  readonly limit: number;
}

/** One `files.stat` batch: which of `paths` exist in the scope's root. */
export interface FileStatKey {
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId | undefined;
  readonly paths: ReadonlyArray<string>;
  /**
   * The caller's name for the state of the workspace it asks about. An answer
   * holds only while the files stay put: a new revision (a turn or a restore
   * settled, and files were created or removed) is a new question, where the
   * same one would read the cached answer.
   */
  readonly revision?: string | undefined;
}

/**
 * `Atom.family` keys have to be primitives, so each request shape becomes one
 * string. Both directions are a total round trip and a test pins that, because
 * the atom decodes the key back into the RPC payload it sends.
 */
export const encodeFileSearch = (key: FileSearchKey): string =>
  JSON.stringify([key.projectId, key.threadId ?? null, key.query, key.limit ?? null]);

export const decodeFileSearch = (encoded: string): FileSearchKey => {
  const [projectId, threadId, query, limit] = JSON.parse(encoded) as [
    ProjectId,
    ThreadId | null,
    string,
    number | null,
  ];
  return {
    projectId,
    ...(threadId === null ? {} : { threadId }),
    query,
    ...(limit === null ? {} : { limit }),
  };
};

export const encodeFileWindow = (key: FileWindowKey): string =>
  JSON.stringify([key.projectId, key.threadId ?? null, key.path, key.offset, key.limit]);

export const decodeFileWindow = (encoded: string): FileWindowKey => {
  const [projectId, threadId, path, offset, limit] = JSON.parse(encoded) as [
    ProjectId,
    ThreadId | null,
    string,
    number,
    number,
  ];
  return { projectId, ...(threadId === null ? {} : { threadId }), path, offset, limit };
};

/**
 * Unlike the other two keys this one normalizes: the paths are deduplicated
 * and sorted, so the same set of candidates is the same atom however it was
 * gathered. Decoding gives back that normalized set.
 */
export const encodeFileStat = (key: FileStatKey): string =>
  JSON.stringify([
    key.projectId,
    key.threadId ?? null,
    [...new Set(key.paths)].sort(),
    key.revision ?? null,
  ]);

export const decodeFileStat = (encoded: string): FileStatKey => {
  const [projectId, threadId, paths, revision] = JSON.parse(encoded) as [
    ProjectId,
    ThreadId | null,
    ReadonlyArray<string>,
    string | null,
  ];
  return {
    projectId,
    ...(threadId === null ? {} : { threadId }),
    paths,
    ...(revision === null ? {} : { revision }),
  };
};

/** How long a `files.stat` answer outlives its last reader. */
const STAT_IDLE_TTL = "5 minutes";

/** `paths` in runs the contract accepts in one `files.stat` call. */
const statBatches = (paths: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> => {
  const batches: Array<ReadonlyArray<string>> = [];
  for (let start = 0; start < paths.length; start += FILES_STAT_MAX_PATHS) {
    batches.push(paths.slice(start, start + FILES_STAT_MAX_PATHS));
  }
  return batches;
};

export const makeFileAtoms = (runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>) => {
  /**
   * One tick per connected epoch: mount, and every reconnect after that. Kept
   * local rather than shared with `gitAtoms` so neither module has to import
   * the other — it is six lines and the two are independent surfaces.
   */
  const connectedEpochs = Effect.gen(function* () {
    const state = yield* ConnectionStateRef;
    return SubscriptionRef.changes(state).pipe(
      Stream.map((connection) => connection.status),
      // `markConnected` rewrites the same status with the server's boot id;
      // dedupe on the status alone so that is not a second fetch.
      Stream.changes,
      Stream.filter((status) => status === "connected"),
    );
  }).pipe(Stream.unwrap);

  const fileSearchByKeyAtom = Atom.family((encoded: string) =>
    runtime.atom(
      connectedEpochs.pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const key = decodeFileSearch(encoded);
            const client = yield* (yield* Connection).client;
            return yield* client["files.search"]({
              projectId: key.projectId,
              ...(key.threadId === undefined ? {} : { threadId: key.threadId }),
              query: key.query,
              ...(key.limit === undefined ? {} : { limit: key.limit }),
            });
          }).pipe(
            Effect.map(ok<ReadonlyArray<FileSearchResult>>),
            Effect.catch((error) =>
              Effect.succeed(failed<ReadonlyArray<FileSearchResult>>(error.message)),
            ),
          ),
        ),
      ),
    ),
  );

  const fileContentByKeyAtom = Atom.family((encoded: string) =>
    runtime.atom(
      connectedEpochs.pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const key = decodeFileWindow(encoded);
            const client = yield* (yield* Connection).client;
            return yield* client["files.read"]({
              projectId: key.projectId,
              ...(key.threadId === undefined ? {} : { threadId: key.threadId }),
              path: key.path,
              offset: key.offset,
              limit: key.limit,
            });
          }).pipe(
            Effect.map(ok<FileContent>),
            Effect.catch((error) => Effect.succeed(failed<FileContent>(error.message))),
          ),
        ),
      ),
    ),
  );

  /**
   * Which of `key.paths` exist. More candidates than one call carries is
   * several calls, in order; an empty set asks nothing.
   */
  const statAll = (key: Omit<FileStatKey, "revision">) =>
    Effect.gen(function* () {
      const client = yield* (yield* Connection).client;
      const answers = yield* Effect.forEach(statBatches(key.paths), (paths) =>
        client["files.stat"]({
          projectId: key.projectId,
          ...(key.threadId === undefined ? {} : { threadId: key.threadId }),
          paths,
        }),
      );
      return answers.flat();
    });

  const fileStatQuery = (encoded: string) =>
    runtime.atom(
      connectedEpochs.pipe(
        Stream.mapEffect(() =>
          statAll(decodeFileStat(encoded)).pipe(
            Effect.map(ok<ReadonlyArray<FileStat>>),
            Effect.catch((error) => Effect.succeed(failed<ReadonlyArray<FileStat>>(error.message))),
          ),
        ),
      ),
    );
  // Held for a while after its last reader goes: a message scrolled out of the
  // timeline and back reads the answer it had, instead of showing its paths
  // plain again until the same question is answered twice.
  const fileStatByKeyAtom = Atom.family((encoded: string) =>
    Atom.setIdleTTL(fileStatQuery(encoded), STAT_IDLE_TTL),
  );

  /** The pane's handles: one atom per request, shared across mounts. */
  const fileSearchAtom = (key: FileSearchKey) => fileSearchByKeyAtom(encodeFileSearch(key));
  const fileContentAtom = (key: FileWindowKey) => fileContentByKeyAtom(encodeFileWindow(key));
  const fileStatAtom = (key: FileStatKey) => fileStatByKeyAtom(encodeFileStat(key));

  /**
   * `files.stat` as a one-shot call (`./oneShot`) on `registry`, for a caller
   * that asks as it goes and keeps its own answers — the terminal's file
   * links, which learn their candidates only as the pointer moves.
   */
  const statFiles = (registry: AtomRegistry.AtomRegistry, key: Omit<FileStatKey, "revision">) =>
    runOneShot(runtime, registry, () => statAll(key));

  return { fileSearchAtom, fileContentAtom, fileStatAtom, statFiles };
};

export type FileAtoms = ReturnType<typeof makeFileAtoms>;
