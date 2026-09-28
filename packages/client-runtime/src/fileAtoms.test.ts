/**
 * File atoms over a stubbed RPC client. The behaviours the files pane and the
 * timeline depend on and cannot get from the server: every family key
 * round-trips (the stat key normalized to its set of paths), a stat batch is
 * one call per contract-sized run and is cached by that set, a failed read
 * becomes a value instead of killing the atom, a reconnect refetches without
 * anyone asking, and a paged window sends the offset and limit it was asked
 * for rather than the server's defaults.
 */

import { describe, expect, it } from "@effect/vitest";
import { makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import { FILES_STAT_MAX_PATHS } from "@poseidon/contracts/rpc";
import type { FileContent, FileSearchResult, FileStat } from "@poseidon/contracts/rpc";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import type * as Atom from "effect/unstable/reactivity/Atom";

import { makeRuntime } from "./atoms";
import {
  decodeFileSearch,
  decodeFileStat,
  decodeFileWindow,
  encodeFileSearch,
  encodeFileStat,
  encodeFileWindow,
  makeFileAtoms,
  type FileQuery,
  type FileSearchKey,
  type FileStatKey,
  type FileWindowKey,
} from "./fileAtoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
  type PoseidonRpcClient,
} from "./connection";

const CONNECTED: ConnectionState = { status: "connected", serverInstanceId: null };
const RECONNECTING: ConnectionState = { status: "reconnecting", serverInstanceId: null };

interface Calls {
  readonly search: Array<{ projectId: string; threadId?: string; query: string; limit?: number }>;
  readonly read: Array<{
    projectId: string;
    threadId?: string;
    path: string;
    offset?: number;
    limit?: number;
  }>;
  readonly stat: Array<{ projectId: string; threadId?: string; paths: ReadonlyArray<string> }>;
}

const hit = (path: string): FileSearchResult => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  isDirectory: false,
});

/** Files a test has "created" since the fake workspace began. */
const created = new Set<string>();

/**
 * A client whose file calls record their arguments and answer from a mutable
 * script, so a test can make the first read fail and assert the retry.
 */
const fakeClient = (calls: Calls, failRead: Ref.Ref<boolean>): PoseidonRpcClient =>
  new Proxy({} as PoseidonRpcClient, {
    get: (_target, key) => {
      if (key === "files.search") {
        return (payload: { projectId: string; query: string; limit?: number }) =>
          Effect.sync(() => {
            calls.search.push({ ...payload });
            return payload.query === "" ? [] : [hit(`src/${payload.query}.ts`)];
          });
      }
      if (key === "files.read") {
        return (payload: { projectId: string; path: string; offset?: number; limit?: number }) =>
          Effect.gen(function* () {
            calls.read.push({ ...payload });
            if (yield* Ref.get(failRead)) {
              return yield* Effect.fail({ message: `cannot read ${payload.path}` });
            }
            const offset = payload.offset ?? 0;
            const limit = payload.limit ?? 2;
            const content: FileContent = {
              path: payload.path,
              text: Array.from({ length: limit }, (_, i) => `line ${offset + i}`).join("\n"),
              totalLines: 5_000,
              truncated: offset + limit < 5_000,
            };
            return content;
          });
      }
      if (key === "files.stat") {
        // Every path under `src/` exists, and whatever a test created; nothing else does.
        return (payload: { projectId: string; paths: ReadonlyArray<string> }) =>
          Effect.sync(() => {
            calls.stat.push({ ...payload });
            return payload.paths
              .filter((path) => path.startsWith("src/") || created.has(path))
              .map((path): FileStat => ({
                path,
                relativePath: path,
                absolutePath: `/repo/${path}`,
                isDirectory: false,
              }));
          });
      }
      return () => Effect.die(`unimplemented rpc ${String(key)}`);
    },
  });

const runtimeWith = (client: PoseidonRpcClient, initial: ConnectionState) =>
  Effect.gen(function* () {
    const stateRef = yield* SubscriptionRef.make(initial);
    const layer = Layer.mergeAll(
      Layer.succeed(Connection, { client: Effect.succeed(client), state: stateRef }),
      Layer.succeed(ConnectionStateRef, stateRef),
    );
    const base = makeRuntime(layer);
    return { registry: AtomRegistry.make(), stateRef, ...makeFileAtoms(base.runtime) };
  });

/** Resolves on the first value matching the predicate — no timers in logic. */
const awaitValue = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  predicate: (value: A) => boolean,
): Promise<A> =>
  new Promise((resolve) => {
    const check = (result: AsyncResult.AsyncResult<A, E>) => {
      if (AsyncResult.isSuccess(result) && predicate(result.value)) {
        unmount();
        resolve(result.value);
      }
    };
    const unmount = registry.subscribe(atom, check);
    check(registry.get(atom));
  });

describe("file atoms", () => {
  it("a search request round-trips through its family key", () => {
    const projectId = makeProjectId();
    const keys: ReadonlyArray<FileSearchKey> = [
      { projectId, query: "" },
      { projectId, query: "router" },
      { projectId, query: "router", limit: 200 },
      { projectId, threadId: makeThreadId(), query: "router" },
    ];
    for (const key of keys) {
      expect(decodeFileSearch(encodeFileSearch(key))).toEqual(key);
    }
    expect(new Set(keys.map(encodeFileSearch)).size).toBe(keys.length);
  });

  it("a read window round-trips through its family key", () => {
    const projectId = makeProjectId();
    const keys: ReadonlyArray<FileWindowKey> = [
      { projectId, path: "src/app.ts", offset: 0, limit: 500 },
      { projectId, path: "src/app.ts", offset: 500, limit: 500 },
      { projectId, path: "src/other.ts", offset: 0, limit: 500 },
      { projectId, threadId: makeThreadId(), path: "src/app.ts", offset: 0, limit: 500 },
    ];
    for (const key of keys) {
      expect(decodeFileWindow(encodeFileWindow(key))).toEqual(key);
    }
    // Two pages of one file must not collide on one atom.
    expect(new Set(keys.map(encodeFileWindow)).size).toBe(keys.length);
  });

  it("a stat batch keys on the set of paths, not their order or repeats", () => {
    const projectId = makeProjectId();
    const threadId = makeThreadId();
    const key: FileStatKey = { projectId, paths: ["src/b.ts", "src/a.ts", "src/b.ts"] };
    expect(encodeFileStat(key)).toBe(
      encodeFileStat({ projectId, paths: ["src/a.ts", "src/b.ts"] }),
    );
    expect(decodeFileStat(encodeFileStat(key))).toEqual({
      projectId,
      paths: ["src/a.ts", "src/b.ts"],
    });
    const scoped: FileStatKey = { projectId, threadId, paths: ["src/a.ts"] };
    expect(decodeFileStat(encodeFileStat(scoped))).toEqual(scoped);
    const revised: FileStatKey = { projectId, threadId, paths: ["src/a.ts"], revision: "2" };
    expect(decodeFileStat(encodeFileStat(revised))).toEqual(revised);
    // A thread, one more path, or a new workspace revision is a different question.
    const distinct = [
      encodeFileStat({ projectId, paths: ["src/a.ts"] }),
      encodeFileStat(scoped),
      encodeFileStat({ projectId, paths: ["src/a.ts", "src/c.ts"] }),
      encodeFileStat(revised),
      encodeFileStat({ ...revised, revision: "3" }),
    ];
    expect(new Set(distinct).size).toBe(distinct.length);
  });

  it.live("a new workspace revision asks again, finding a file created since", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const threadId = makeThreadId();
        const calls: Calls = { search: [], read: [], stat: [] };
        const failing = yield* Ref.make(false);
        const { registry, fileStatAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );
        const ask = (revision: string) => {
          const atom = fileStatAtom({ projectId, threadId, paths: ["new.ts"], revision });
          registry.mount(atom);
          return Effect.promise(() =>
            awaitValue<FileQuery<ReadonlyArray<FileStat>>, Cause.NoSuchElementError>(
              registry,
              atom,
              (query) => query._tag === "ok",
            ),
          );
        };

        // Asked while the Write that creates it is still running: not there.
        expect(yield* ask("1")).toEqual({ _tag: "ok", value: [] });
        created.add("new.ts");
        // The same question reads the cached answer; the next revision asks again.
        expect(yield* ask("1")).toEqual({ _tag: "ok", value: [] });
        const again = yield* ask("2");
        expect(again._tag === "ok" && again.value.map((stat) => stat.path)).toEqual(["new.ts"]);
        expect(calls.stat).toHaveLength(2);
        created.delete("new.ts");
      }),
    ),
  );

  it.live("a stat batch is one call, and the same set asked again reads the cache", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const threadId = makeThreadId();
        const calls: Calls = { search: [], read: [], stat: [] };
        const failing = yield* Ref.make(false);
        const { registry, fileStatAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );

        const atom = fileStatAtom({ projectId, threadId, paths: ["src/b.ts", "README.md"] });
        registry.mount(atom);
        const found = yield* Effect.promise(() =>
          awaitValue<FileQuery<ReadonlyArray<FileStat>>, Cause.NoSuchElementError>(
            registry,
            atom,
            (query) => query._tag === "ok",
          ),
        );
        expect(found._tag === "ok" && found.value.map((stat) => stat.path)).toEqual(["src/b.ts"]);
        expect(fileStatAtom({ projectId, threadId, paths: ["README.md", "src/b.ts"] })).toBe(atom);
        expect(calls.stat).toEqual([{ projectId, threadId, paths: ["README.md", "src/b.ts"] }]);
      }),
    ),
  );

  it.live("more candidates than one call carries go out in several calls", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const calls: Calls = { search: [], read: [], stat: [] };
        const failing = yield* Ref.make(false);
        const { registry, fileStatAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );

        const paths = Array.from({ length: FILES_STAT_MAX_PATHS + 5 }, (_, i) => `src/${i}.ts`);
        const atom = fileStatAtom({ projectId, paths });
        registry.mount(atom);
        const found = yield* Effect.promise(() =>
          awaitValue<FileQuery<ReadonlyArray<FileStat>>, Cause.NoSuchElementError>(
            registry,
            atom,
            (query) => query._tag === "ok",
          ),
        );
        expect(found._tag === "ok" && found.value.length).toBe(paths.length);
        expect(calls.stat.map((call) => call.paths.length)).toEqual([FILES_STAT_MAX_PATHS, 5]);

        const empty = fileStatAtom({ projectId, paths: [] });
        registry.mount(empty);
        const none = yield* Effect.promise(() =>
          awaitValue<FileQuery<ReadonlyArray<FileStat>>, Cause.NoSuchElementError>(
            registry,
            empty,
            (query) => query._tag === "ok",
          ),
        );
        expect(none).toEqual({ _tag: "ok", value: [] });
        expect(calls.stat).toHaveLength(2);
      }),
    ),
  );

  it.live(
    "a one-shot stat asks each time, in contract-sized calls, and resolves its own exit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const projectId = makeProjectId();
          const threadId = makeThreadId();
          const calls: Calls = { search: [], read: [], stat: [] };
          const failing = yield* Ref.make(false);
          const { registry, statFiles } = yield* runtimeWith(fakeClient(calls, failing), CONNECTED);

          const paths = ["src/a.ts", "/elsewhere/b.ts"];
          const first = yield* Effect.promise(() =>
            statFiles(registry, { projectId, threadId, paths }),
          );
          const second = yield* Effect.promise(() => statFiles(registry, { projectId, paths }));
          expect(Exit.isSuccess(first) && first.value.map((stat) => stat.path)).toEqual([
            "src/a.ts",
          ]);
          expect(Exit.isSuccess(second)).toBe(true);
          expect(calls.stat).toEqual([
            { projectId, threadId, paths },
            { projectId, paths },
          ]);

          const many = Array.from({ length: FILES_STAT_MAX_PATHS + 1 }, (_, i) => `src/${i}.ts`);
          const all = yield* Effect.promise(() => statFiles(registry, { projectId, paths: many }));
          expect(Exit.isSuccess(all) && all.value.length).toBe(many.length);
          expect(calls.stat.slice(2).map((call) => call.paths.length)).toEqual([
            FILES_STAT_MAX_PATHS,
            1,
          ]);
        }),
      ),
  );

  it.live("a failed read becomes a value and the atom survives it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const calls: Calls = { search: [], read: [], stat: [] };
        const failing = yield* Ref.make(true);
        const { registry, stateRef, fileContentAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );

        const atom = fileContentAtom({ projectId, path: "src/app.ts", offset: 0, limit: 2 });
        registry.mount(atom);
        const failure = yield* Effect.promise(() =>
          awaitValue<FileQuery<FileContent>, Cause.NoSuchElementError>(
            registry,
            atom,
            (query) => query._tag === "error",
          ),
        );
        expect(failure).toEqual({ _tag: "error", message: "cannot read src/app.ts" });

        // The stream is still live: a reconnect refetches, and this time it works.
        yield* Ref.set(failing, false);
        yield* SubscriptionRef.set(stateRef, RECONNECTING);
        yield* SubscriptionRef.set(stateRef, CONNECTED);
        const recovered = yield* Effect.promise(() =>
          awaitValue<FileQuery<FileContent>, Cause.NoSuchElementError>(
            registry,
            atom,
            (query) => query._tag === "ok",
          ),
        );
        expect(recovered._tag === "ok" && recovered.value.totalLines).toBe(5_000);
        expect(calls.read).toEqual([
          { projectId, path: "src/app.ts", offset: 0, limit: 2 },
          { projectId, path: "src/app.ts", offset: 0, limit: 2 },
        ]);
      }),
    ),
  );

  it.live("a later page asks the server for that window, not the first one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const calls: Calls = { search: [], read: [], stat: [] };
        const failing = yield* Ref.make(false);
        const { registry, fileContentAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );

        const page = fileContentAtom({ projectId, path: "src/app.ts", offset: 4_000, limit: 2 });
        registry.mount(page);
        const content = yield* Effect.promise(() =>
          awaitValue<FileQuery<FileContent>, Cause.NoSuchElementError>(
            registry,
            page,
            (query) => query._tag === "ok",
          ),
        );
        expect(content._tag === "ok" && content.value.text).toBe("line 4000\nline 4001");
        expect(calls.read).toEqual([{ projectId, path: "src/app.ts", offset: 4_000, limit: 2 }]);
      }),
    ),
  );

  it.live("a search sends the query and the cap it was given", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const calls: Calls = { search: [], read: [], stat: [] };
        const failing = yield* Ref.make(false);
        const { registry, fileSearchAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );

        const atom = fileSearchAtom({ projectId, query: "router", limit: 200 });
        registry.mount(atom);
        const results = yield* Effect.promise(() =>
          awaitValue<FileQuery<ReadonlyArray<FileSearchResult>>, Cause.NoSuchElementError>(
            registry,
            atom,
            (query) => query._tag === "ok",
          ),
        );
        expect(results._tag === "ok" && results.value.map((r) => r.path)).toEqual([
          "src/router.ts",
        ]);
        expect(calls.search).toEqual([{ projectId, query: "router", limit: 200 }]);
      }),
    ),
  );

  it.live("a thread's search and read send its id, so the server reads the thread's root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const threadId = makeThreadId();
        const calls: Calls = { search: [], read: [], stat: [] };
        const failing = yield* Ref.make(false);
        const { registry, fileSearchAtom, fileContentAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );

        const search = fileSearchAtom({ projectId, threadId, query: "router" });
        const read = fileContentAtom({ projectId, threadId, path: "a.ts", offset: 0, limit: 2 });
        registry.mount(search);
        registry.mount(read);
        yield* Effect.promise(() =>
          awaitValue<FileQuery<ReadonlyArray<FileSearchResult>>, Cause.NoSuchElementError>(
            registry,
            search,
            (query) => query._tag === "ok",
          ),
        );
        yield* Effect.promise(() =>
          awaitValue<FileQuery<FileContent>, Cause.NoSuchElementError>(
            registry,
            read,
            (query) => query._tag === "ok",
          ),
        );
        expect(calls.search).toEqual([{ projectId, threadId, query: "router" }]);
        expect(calls.read).toEqual([{ projectId, threadId, path: "a.ts", offset: 0, limit: 2 }]);
      }),
    ),
  );
});
