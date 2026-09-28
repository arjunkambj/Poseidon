/**
 * The review calls over a stubbed RPC client: a discard sends the payload the
 * server expects and refetches the project's git reads, an empty list sends
 * nothing, a refusal comes back as the call's failure, and the blame atom
 * answers the server's blame as a `GitQuery`.
 */

import { describe, expect, it } from "@effect/vitest";
import type { GitBlame } from "@poseidon/contracts/git-review";
import { makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import type * as Atom from "effect/unstable/reactivity/Atom";

import { makeRuntime } from "./atoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
  type PoseidonRpcClient,
} from "./connection";
import { makeGitAtoms, type GitQuery } from "./gitAtoms";
import { decodeBlameKey, encodeBlameKey, makeGitReview, type GitBlameKey } from "./gitReview";

const BLAME: GitBlame = {
  path: "src/app.ts",
  untracked: false,
  entries: [
    {
      sha: "a".repeat(40),
      author: "Ada",
      time: "2026-01-01T00:00:00.000Z",
      summary: "Start the app",
      uncommitted: false,
      startLine: 1,
      lineCount: 2,
    },
  ],
};

interface Calls {
  readonly discard: Array<unknown>;
  readonly blame: Array<unknown>;
  readonly status: Array<unknown>;
}

/** `locked.txt` is refused the way the server refuses a discard under a running turn. */
const fakeClient = (calls: Calls): PoseidonRpcClient =>
  new Proxy({} as PoseidonRpcClient, {
    get: (_target, key) => {
      switch (key) {
        case "git.discard":
          return (payload: { readonly paths?: ReadonlyArray<string> }) =>
            Effect.suspend(() => {
              calls.discard.push(payload);
              return payload.paths?.includes("locked.txt") === true
                ? Effect.fail(
                    new PoseidonRpcError({ code: "conflict", message: "A turn is running" }),
                  )
                : Effect.succeed({});
            });
        case "git.blame":
          return (payload: unknown) =>
            Effect.sync(() => {
              calls.blame.push(payload);
              return BLAME;
            });
        case "git.status":
          return (payload: unknown) =>
            Effect.sync(() => {
              calls.status.push(payload);
              return {
                branch: "main",
                upstream: null,
                ahead: 0,
                behind: 0,
                isRepository: true,
                files: [],
              };
            });
        default:
          return () => Effect.die(`unimplemented rpc ${String(key)}`);
      }
    },
  });

const setup = Effect.gen(function* () {
  const calls: Calls = { discard: [], blame: [], status: [] };
  const stateRef = yield* SubscriptionRef.make<ConnectionState>({
    status: "connected",
    serverInstanceId: null,
  });
  const layer = Layer.mergeAll(
    Layer.succeed(Connection, { client: Effect.succeed(fakeClient(calls)), state: stateRef }),
    Layer.succeed(ConnectionStateRef, stateRef),
  );
  const base = makeRuntime(layer);
  const git = makeGitAtoms(base.runtime);
  return { calls, registry: AtomRegistry.make(), git, ...makeGitReview(base.runtime, git) };
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

describe("blame keys", () => {
  it("round-trip, and distinct ranges do not collide", () => {
    const projectId = makeProjectId();
    const keys: ReadonlyArray<GitBlameKey> = [
      { projectId, path: "a.ts" },
      { projectId, threadId: makeThreadId(), path: "a.ts" },
      { projectId, path: "a.ts", startLine: 3 },
      { projectId, path: "a.ts", startLine: 3, endLine: 3 },
      { projectId, path: "b.ts", endLine: 9 },
    ];
    for (const key of keys) {
      expect(decodeBlameKey(encodeBlameKey(key))).toEqual(key);
    }
    expect(new Set(keys.map(encodeBlameKey)).size).toBe(keys.length);
  });
});

describe("git review", () => {
  it.live("a discard sends its scope and refetches the project's git reads", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const threadId = makeThreadId();
      const { calls, registry, git, discard } = yield* setup;
      const statusAtom = git.gitStatusAtom({ projectId, threadId });
      registry.mount(statusAtom);
      yield* Effect.promise(() => awaitValue(registry, statusAtom, () => true));
      expect(calls.status).toHaveLength(1);

      const done = yield* Effect.promise(() =>
        discard(registry, {
          projectId,
          threadId,
          paths: ["src/b.ts", "src/a.ts"],
          source: "refs/poseidon/checkpoints/t/1",
        }),
      );
      expect(Exit.isSuccess(done)).toBe(true);
      expect(calls.discard).toEqual([
        {
          projectId,
          threadId,
          paths: ["src/b.ts", "src/a.ts"],
          source: "refs/poseidon/checkpoints/t/1",
        },
      ]);
      yield* Effect.promise(() => expect.poll(() => calls.status.length).toBe(2));

      // Everything uncommitted: no paths on the wire at all.
      yield* Effect.promise(() => discard(registry, { projectId }));
      expect(calls.discard.at(-1)).toEqual({ projectId });
    }),
  );

  it.live("an empty list discards nothing, and a refusal fails the call", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const { calls, registry, discard } = yield* setup;

      const nothing = yield* Effect.promise(() => discard(registry, { projectId, paths: [] }));
      expect(Exit.isSuccess(nothing)).toBe(true);
      expect(calls.discard).toEqual([]);

      const refused = yield* Effect.promise(() =>
        discard(registry, { projectId, paths: ["locked.txt"] }),
      );
      expect(Exit.isFailure(refused)).toBe(true);
      expect(JSON.stringify(refused)).toContain("A turn is running");
    }),
  );

  it.live("the blame atom answers the server's blame for the asked lines", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const { calls, registry, blameAtom } = yield* setup;
      const atom = blameAtom({ projectId, path: "src/app.ts", startLine: 1, endLine: 2 });
      expect(atom).toBe(blameAtom({ projectId, path: "src/app.ts", startLine: 1, endLine: 2 }));
      registry.mount(atom);

      const answer = yield* Effect.promise(() =>
        awaitValue<GitQuery<GitBlame>, unknown>(registry, atom, (query) => query._tag === "ok"),
      );
      expect(answer).toEqual({ _tag: "ok", value: BLAME });
      expect(calls.blame).toEqual([{ projectId, path: "src/app.ts", startLine: 1, endLine: 2 }]);
    }),
  );
});
