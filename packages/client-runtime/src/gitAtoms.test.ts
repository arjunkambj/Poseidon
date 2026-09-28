/**
 * Git atoms over a stubbed RPC client. The three behaviours the changes pane
 * depends on and cannot get from the server: the range key round-trips, a
 * failed call becomes a value instead of killing the atom, and a reconnect
 * refetches without anyone asking.
 */

import { describe, expect, it } from "@effect/vitest";
import {
  decodeCheckpointId,
  decodeTurnId,
  makeProjectId,
  makeThreadId,
} from "@poseidon/contracts/ids";
import type { CheckpointSummary } from "@poseidon/contracts/orchestration";
import type { GitBranchList } from "@poseidon/contracts/git";
import type { GitDiff, GitStatus } from "@poseidon/contracts/rpc";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import type * as Atom from "effect/unstable/reactivity/Atom";

import {
  decodeCheckpointsKey,
  decodeDiffRange,
  decodeGitScope,
  encodeCheckpointsKey,
  encodeDiffRange,
  encodeGitScope,
  isRepoless,
  makeGitAtoms,
  type GitDiffRange,
  type GitQuery,
  type GitScope,
} from "./gitAtoms";
import { makeRuntime } from "./atoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
  type PoseidonRpcClient,
} from "./connection";

const CONNECTED: ConnectionState = { status: "connected", serverInstanceId: null };
const RECONNECTING: ConnectionState = { status: "reconnecting", serverInstanceId: null };

const status = (branch: string | null): GitStatus => ({
  branch,
  upstream: null,
  ahead: 0,
  behind: 0,
  files:
    branch === null ? [] : [{ path: "src/app.ts", status: "modified" as const, staged: false }],
});

const diff = (from: string | null, to: string | null): GitDiff => ({
  from,
  to,
  files: [
    {
      path: "src/app.ts",
      kind: "edit" as const,
      diff: "diff --git a/src/app.ts b/src/app.ts\n",
      additions: 3,
      deletions: 1,
    },
  ],
});

interface Calls {
  readonly status: Array<{ projectId: string; threadId?: string }>;
  readonly diff: Array<{
    from?: string;
    to?: string;
    mergeBase?: string;
    ignoreWhitespace?: boolean;
  }>;
  readonly branches?: Array<{ projectId: string; threadId?: string }>;
  readonly checkout?: Array<{ projectId: string; threadId?: string; branch: string }>;
  readonly checkpoints?: Array<{ projectId: string; threadId: string }>;
}

const checkpoint = (n: number): CheckpointSummary => ({
  checkpointId: decodeCheckpointId(`0190a000-0000-7000-8000-00000000000${n}`),
  turnId: decodeTurnId(`0190a000-0000-7000-8000-00000000010${n}`),
  ref: `refs/poseidon/checkpoints/t/${n}`,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const branchList = (current: string): GitBranchList => ({
  isRepository: true,
  current,
  defaultBranch: "main",
  remotes: [],
  branches: ["feature", "main"].map((name) => ({
    name,
    kind: "local" as const,
    isCurrent: name === current,
  })),
});

/**
 * A client whose git calls record their arguments and answer from a mutable
 * script, so a test can make the second call fail or assert it happened.
 */
const fakeClient = (calls: Calls, failStatus: Ref.Ref<boolean>): PoseidonRpcClient =>
  new Proxy({} as PoseidonRpcClient, {
    get: (_target, key) => {
      if (key === "git.status") {
        return (payload: { projectId: string; threadId?: string }) =>
          Effect.gen(function* () {
            calls.status.push({ ...payload });
            if (yield* Ref.get(failStatus)) {
              return yield* Effect.fail({ message: "not a git repository" });
            }
            return status(calls.checkout?.at(-1)?.branch ?? "main");
          });
      }
      if (key === "git.diff") {
        return (payload: { from?: string; to?: string; mergeBase?: string }) =>
          Effect.sync(() => {
            calls.diff.push({ ...payload });
            return diff(payload.from ?? null, payload.to ?? null);
          });
      }
      if (key === "git.branches") {
        return (payload: { projectId: string; threadId?: string }) =>
          Effect.sync(() => {
            calls.branches?.push({ ...payload });
            return branchList(calls.checkout?.at(-1)?.branch ?? "main");
          });
      }
      if (key === "checkpoints.list") {
        return (payload: { projectId: string; threadId: string }) =>
          Effect.sync(() => {
            calls.checkpoints?.push({ ...payload });
            // One more checkpoint exists at every read, as turns complete.
            return Array.from({ length: calls.checkpoints?.length ?? 0 }, (_, n) =>
              checkpoint(n + 1),
            );
          });
      }
      if (key === "git.checkout") {
        return (payload: { projectId: string; threadId?: string; branch: string }) =>
          Effect.gen(function* () {
            if (payload.branch === "dirty") {
              return yield* Effect.fail({ message: "The working tree has uncommitted changes" });
            }
            calls.checkout?.push({ ...payload });
            return branchList(payload.branch);
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
    return { registry: AtomRegistry.make(), stateRef, ...makeGitAtoms(base.runtime) };
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

describe("git atoms", () => {
  it("a diff range round-trips through its family key", () => {
    const projectId = makeProjectId();
    const ranges: ReadonlyArray<GitDiffRange> = [
      { projectId },
      { projectId, from: "refs/poseidon/checkpoints/a" },
      { projectId, from: "refs/poseidon/checkpoints/a", to: "refs/poseidon/checkpoints/b" },
      { projectId, to: "refs/poseidon/checkpoints/b" },
      { projectId, threadId: makeThreadId() },
      { projectId, threadId: makeThreadId(), from: "main", to: "refs/poseidon/checkpoints/b" },
      { projectId, mergeBase: "main" },
      { projectId, threadId: makeThreadId(), mergeBase: "origin/main" },
      { projectId, mergeBase: "main", ignoreWhitespace: true },
      { projectId, ignoreWhitespace: true },
      { projectId, ignoreWhitespace: false },
    ];
    for (const range of ranges) {
      expect(decodeDiffRange(encodeDiffRange(range))).toEqual(range);
    }
    // Distinct comparisons must not collide on one atom.
    expect(new Set(ranges.map(encodeDiffRange)).size).toBe(ranges.length);
  });

  it("toggling ignoreWhitespace is a different comparison, and an older key still decodes", () => {
    const projectId = makeProjectId();
    expect(encodeDiffRange({ projectId, ignoreWhitespace: true })).not.toBe(
      encodeDiffRange({ projectId }),
    );
    // A key written before the field existed has five slots.
    expect(decodeDiffRange(JSON.stringify([projectId, null, "HEAD", null, null]))).toEqual({
      projectId,
      from: "HEAD",
    });
  });

  it("a git scope round-trips through its family key", () => {
    const projectId = makeProjectId();
    const scopes: ReadonlyArray<GitScope> = [
      { projectId },
      { projectId, threadId: makeThreadId() },
    ];
    for (const scope of scopes) {
      expect(decodeGitScope(encodeGitScope(scope))).toEqual(scope);
    }
    expect(new Set(scopes.map(encodeGitScope)).size).toBe(scopes.length);
  });

  it("a checkpoints key round-trips through its family key", () => {
    const key = { projectId: makeProjectId(), threadId: makeThreadId(), revision: "3" };
    expect(decodeCheckpointsKey(encodeCheckpointsKey(key))).toEqual(key);
  });

  it.live(
    "checkpoints list in the thread's scope, afresh for a new revision and on a project refresh",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const projectId = makeProjectId();
          const threadId = makeThreadId();
          const calls: Calls = { status: [], diff: [], checkpoints: [] };
          const failing = yield* Ref.make(false);
          const { registry, checkpointsAtom, refreshProject } = yield* runtimeWith(
            fakeClient(calls, failing),
            CONNECTED,
          );
          type Listed = GitQuery<ReadonlyArray<CheckpointSummary>>;
          const first = checkpointsAtom({ projectId, threadId, revision: "1" });
          registry.mount(first);
          const one = yield* Effect.promise(() =>
            awaitValue<Listed, Cause.NoSuchElementError>(registry, first, (q) => q._tag === "ok"),
          );
          expect(one._tag === "ok" && one.value.map((entry) => entry.ref)).toEqual([
            "refs/poseidon/checkpoints/t/1",
          ]);
          // The revision never reaches the server.
          expect(calls.checkpoints).toEqual([{ projectId, threadId }]);

          // Same key: the same atom, no second call.
          expect(checkpointsAtom({ projectId, threadId, revision: "1" })).toBe(first);

          // A new revision is a new atom that reads the list again.
          const second = checkpointsAtom({ projectId, threadId, revision: "2" });
          registry.mount(second);
          const two = yield* Effect.promise(() =>
            awaitValue<Listed, Cause.NoSuchElementError>(registry, second, (q) => q._tag === "ok"),
          );
          expect(two._tag === "ok" && two.value).toHaveLength(2);

          // A project refresh — a restore settling, the pane's refresh — rereads
          // the mounted list too.
          refreshProject(registry, projectId);
          const three = yield* Effect.promise(() =>
            awaitValue<Listed, Cause.NoSuchElementError>(
              registry,
              second,
              (q) => q._tag === "ok" && q.value.length > 2,
            ),
          );
          expect(three._tag).toBe("ok");
        }),
      ),
  );

  it("a repo-less status is recognised, a real one is not", () => {
    expect(isRepoless(status(null))).toBe(true);
    expect(isRepoless(status("main"))).toBe(false);
  });

  it.live("a failed status call becomes a value and the atom survives it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const calls: Calls = { status: [], diff: [] };
        const failing = yield* Ref.make(true);
        const { registry, stateRef, gitStatusAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );

        const atom = gitStatusAtom({ projectId });
        registry.mount(atom);
        const failure = yield* Effect.promise(() =>
          awaitValue<GitQuery<GitStatus>, Cause.NoSuchElementError>(
            registry,
            atom,
            (query) => query._tag === "error",
          ),
        );
        expect(failure).toEqual({ _tag: "error", message: "not a git repository" });

        // The stream is still live: a reconnect refetches, and this time it works.
        yield* Ref.set(failing, false);
        yield* SubscriptionRef.set(stateRef, RECONNECTING);
        yield* SubscriptionRef.set(stateRef, CONNECTED);
        const recovered = yield* Effect.promise(() =>
          awaitValue<GitQuery<GitStatus>, Cause.NoSuchElementError>(
            registry,
            atom,
            (query) => query._tag === "ok",
          ),
        );
        expect(recovered._tag === "ok" && recovered.value.branch).toBe("main");
        expect(calls.status).toEqual([{ projectId }, { projectId }]);
      }),
    ),
  );

  it.live("a checkpoint-to-checkpoint range sends both refs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const calls: Calls = { status: [], diff: [] };
        const failing = yield* Ref.make(false);
        const { registry, gitDiffAtom } = yield* runtimeWith(fakeClient(calls, failing), CONNECTED);

        const worktree = gitDiffAtom({ projectId });
        const between = gitDiffAtom({ projectId, from: "refs/a", to: "refs/b" });
        registry.mount(worktree);
        registry.mount(between);
        yield* Effect.promise(() =>
          awaitValue<GitQuery<GitDiff>, Cause.NoSuchElementError>(
            registry,
            worktree,
            (query) => query._tag === "ok" && query.value.to === null,
          ),
        );
        const ranged = yield* Effect.promise(() =>
          awaitValue<GitQuery<GitDiff>, Cause.NoSuchElementError>(
            registry,
            between,
            (query) => query._tag === "ok" && query.value.to === "refs/b",
          ),
        );
        expect(ranged._tag === "ok" && ranged.value.files[0]?.additions).toBe(3);
        // The working-tree atom sends neither ref; the ranged one sends both.
        expect(calls.diff).toContainEqual({ projectId });
        expect(calls.diff).toContainEqual({ projectId, from: "refs/a", to: "refs/b" });
      }),
    ),
  );

  it.live("an ignore-whitespace range sends the flag as a comparison of its own", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const calls: Calls = { status: [], diff: [] };
        const failing = yield* Ref.make(false);
        const { registry, gitDiffAtom } = yield* runtimeWith(fakeClient(calls, failing), CONNECTED);

        const ignoring = gitDiffAtom({ projectId, ignoreWhitespace: true });
        expect(ignoring).not.toBe(gitDiffAtom({ projectId }));
        registry.mount(ignoring);
        yield* Effect.promise(() =>
          awaitValue<GitQuery<GitDiff>, Cause.NoSuchElementError>(
            registry,
            ignoring,
            (query) => query._tag === "ok",
          ),
        );
        expect(calls.diff).toEqual([{ projectId, ignoreWhitespace: true }]);
      }),
    ),
  );

  it.live("a thread's scope sends its id, so the server reads the thread's root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const threadId = makeThreadId();
        const calls: Calls = { status: [], diff: [] };
        const failing = yield* Ref.make(false);
        const { registry, gitStatusAtom, gitDiffAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );
        const statusAtom = gitStatusAtom({ projectId, threadId });
        const diffAtom = gitDiffAtom({ projectId, threadId });
        registry.mount(statusAtom);
        registry.mount(diffAtom);
        yield* Effect.promise(() =>
          awaitValue<GitQuery<GitStatus>, Cause.NoSuchElementError>(
            registry,
            statusAtom,
            (query) => query._tag === "ok",
          ),
        );
        yield* Effect.promise(() =>
          awaitValue<GitQuery<GitDiff>, Cause.NoSuchElementError>(
            registry,
            diffAtom,
            (query) => query._tag === "ok",
          ),
        );
        expect(calls.status).toEqual([{ projectId, threadId }]);
        expect(calls.diff).toEqual([{ projectId, threadId }]);
      }),
    ),
  );

  it.live(
    "a checkout resolves with the new list and refetches that scope's branches and status",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const projectId = makeProjectId();
          const threadId = makeThreadId();
          const calls: Calls = { status: [], diff: [], branches: [], checkout: [] };
          const failing = yield* Ref.make(false);
          const { registry, gitBranchesAtom, gitStatusAtom, checkout } = yield* runtimeWith(
            fakeClient(calls, failing),
            CONNECTED,
          );
          const branchesAtom = gitBranchesAtom({ projectId, threadId });
          const statusAtom = gitStatusAtom({ projectId, threadId });
          registry.mount(branchesAtom);
          registry.mount(statusAtom);
          yield* Effect.promise(() =>
            awaitValue<GitQuery<GitBranchList>, Cause.NoSuchElementError>(
              registry,
              branchesAtom,
              (query) => query._tag === "ok" && query.value.current === "main",
            ),
          );
          expect(calls.branches).toEqual([{ projectId, threadId }]);

          const result = yield* Effect.promise(() =>
            checkout(registry, { projectId, threadId, branch: "feature" }),
          );
          expect(Exit.isSuccess(result) && result.value.current).toBe("feature");
          const switched = yield* Effect.promise(() =>
            awaitValue<GitQuery<GitBranchList>, Cause.NoSuchElementError>(
              registry,
              branchesAtom,
              (query) => query._tag === "ok" && query.value.current === "feature",
            ),
          );
          expect(switched._tag).toBe("ok");
          expect(calls.checkout).toEqual([{ projectId, threadId, branch: "feature" }]);
          // The status atom of the same scope is refetched as well.
          yield* Effect.promise(() =>
            awaitValue<GitQuery<GitStatus>, Cause.NoSuchElementError>(
              registry,
              statusAtom,
              (query) => query._tag === "ok" && query.value.branch === "feature",
            ),
          );
        }),
      ),
  );

  it.live(
    "a checkout refetches every git read of the project: diffs, and a sibling thread's branches",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const projectId = makeProjectId();
          const threadId = makeThreadId();
          const sibling = makeThreadId();
          const otherProject = makeProjectId();
          const calls: Calls = { status: [], diff: [], branches: [], checkout: [] };
          const failing = yield* Ref.make(false);
          const { registry, gitBranchesAtom, gitDiffAtom, checkout } = yield* runtimeWith(
            fakeClient(calls, failing),
            CONNECTED,
          );
          // Another local thread of the project shares its folder, so its
          // branch moves too; the diff range was never named by the write.
          const siblingBranches = gitBranchesAtom({ projectId, threadId: sibling });
          const diffAtom = gitDiffAtom({ projectId, threadId: sibling, mergeBase: "main" });
          const unrelated = gitDiffAtom({ projectId: otherProject });
          registry.mount(siblingBranches);
          registry.mount(diffAtom);
          registry.mount(unrelated);
          yield* Effect.promise(() =>
            awaitValue<GitQuery<GitBranchList>, Cause.NoSuchElementError>(
              registry,
              siblingBranches,
              (query) => query._tag === "ok" && query.value.current === "main",
            ),
          );
          yield* Effect.promise(() => expect.poll(() => calls.diff.length).toBe(2));

          yield* Effect.promise(() =>
            checkout(registry, { projectId, threadId, branch: "feature" }),
          );
          yield* Effect.promise(() =>
            awaitValue<GitQuery<GitBranchList>, Cause.NoSuchElementError>(
              registry,
              siblingBranches,
              (query) => query._tag === "ok" && query.value.current === "feature",
            ),
          );
          yield* Effect.promise(() => expect.poll(() => calls.diff.length).toBe(3));
          // The project's diff was fetched again; the other project's was not.
          expect(calls.diff.filter((call) => "mergeBase" in call)).toHaveLength(2);
        }),
      ),
  );

  it.live("a refused checkout fails the mutation with the server's message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const calls: Calls = { status: [], diff: [], branches: [], checkout: [] };
        const failing = yield* Ref.make(false);
        const { registry, checkout } = yield* runtimeWith(fakeClient(calls, failing), CONNECTED);
        const failure = yield* Effect.promise(() =>
          checkout(registry, { projectId, branch: "dirty" }),
        );
        expect(Exit.isFailure(failure)).toBe(true);
        expect(calls.checkout).toEqual([]);
      }),
    ),
  );
});
