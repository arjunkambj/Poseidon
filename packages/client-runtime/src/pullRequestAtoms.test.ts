/**
 * Pull request atoms over a stubbed RPC client: the view reads the scope it
 * was asked for, a failure is a value the atom survives, a project refresh
 * rereads a mounted view, and the marks listing is throttled except when a
 * refresh asks for it.
 */

import { describe, expect, it } from "@effect/vitest";
import { makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import type { PullRequestMarks, PullRequestView } from "@poseidon/contracts/pullRequest";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
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
import { MARKS_MIN_INTERVAL_MS, makePullRequestAtoms } from "./pullRequestAtoms";

const CONNECTED: ConnectionState = { status: "connected", serverInstanceId: null };
const RECONNECTING: ConnectionState = { status: "reconnecting", serverInstanceId: null };

interface Script {
  readonly view: Array<{ projectId: string; threadId?: string }>;
  readonly marks: Array<{ projectId: string }>;
  /** The view's next answer: a branch with none, or a refusal. */
  failView: boolean;
}

const noneOn = (branch: string): PullRequestView => ({ state: "none", branch });

const fakeClient = (script: Script): PoseidonRpcClient =>
  new Proxy({} as PoseidonRpcClient, {
    get: (_target, key) => {
      if (key === "git.pullRequest.view") {
        return (payload: { projectId: string; threadId?: string }) =>
          Effect.gen(function* () {
            script.view.push({ ...payload });
            if (script.failView) {
              return yield* Effect.fail({ message: "HTTP 502: Bad Gateway" });
            }
            return noneOn(`branch-${script.view.length}`);
          });
      }
      if (key === "git.pullRequest.marks") {
        return (payload: { projectId: string }) =>
          Effect.sync((): PullRequestMarks => {
            script.marks.push({ ...payload });
            return { marks: [] };
          });
      }
      return () => Effect.die(`unimplemented rpc ${String(key)}`);
    },
  });

const runtimeWith = (client: PoseidonRpcClient, clock: { now: number }) =>
  Effect.gen(function* () {
    const stateRef = yield* SubscriptionRef.make(CONNECTED);
    const layer = Layer.mergeAll(
      Layer.succeed(Connection, { client: Effect.succeed(client), state: stateRef }),
      Layer.succeed(ConnectionStateRef, stateRef),
    );
    const base = makeRuntime(layer);
    const git = makeGitAtoms(base.runtime);
    return {
      registry: AtomRegistry.make(),
      stateRef,
      refreshProject: git.refreshProject,
      ...makePullRequestAtoms(base.runtime, git, { now: () => clock.now }),
    };
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

type ViewQuery = GitQuery<PullRequestView>;
type MarksQuery = GitQuery<PullRequestMarks>;

describe("pull request atoms", () => {
  it.live("the view reads the thread's scope and rereads on a project refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const threadId = makeThreadId();
        const script: Script = { view: [], marks: [], failView: false };
        const { registry, pullRequestViewAtom, refreshProject } = yield* runtimeWith(
          fakeClient(script),
          { now: 0 },
        );
        const atom = pullRequestViewAtom({ projectId, threadId });
        expect(pullRequestViewAtom({ projectId, threadId })).toBe(atom);
        registry.mount(atom);
        const first = yield* Effect.promise(() =>
          awaitValue<ViewQuery, Cause.NoSuchElementError>(registry, atom, (q) => q._tag === "ok"),
        );
        expect(first).toEqual({ _tag: "ok", value: noneOn("branch-1") });
        expect(script.view).toEqual([{ projectId, threadId }]);

        // The header's window-return refresh reaches the view through the revision.
        refreshProject(registry, projectId);
        const second = yield* Effect.promise(() =>
          awaitValue<ViewQuery, Cause.NoSuchElementError>(
            registry,
            atom,
            (q) => q._tag === "ok" && q.value.state === "none" && q.value.branch === "branch-2",
          ),
        );
        expect(second._tag).toBe("ok");
        expect(script.view).toHaveLength(2);
      }),
    ),
  );

  it.live("a failed view is a value, and the same atom recovers on reconnect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const script: Script = { view: [], marks: [], failView: true };
        const { registry, stateRef, pullRequestViewAtom } = yield* runtimeWith(fakeClient(script), {
          now: 0,
        });
        const atom = pullRequestViewAtom({ projectId });
        registry.mount(atom);
        const failure = yield* Effect.promise(() =>
          awaitValue<ViewQuery, Cause.NoSuchElementError>(
            registry,
            atom,
            (q) => q._tag === "error",
          ),
        );
        expect(failure).toEqual({ _tag: "error", message: "HTTP 502: Bad Gateway" });
        // No threadId on the wire for the project's own scope.
        expect(script.view).toEqual([{ projectId }]);

        script.failView = false;
        yield* SubscriptionRef.set(stateRef, RECONNECTING);
        yield* SubscriptionRef.set(stateRef, CONNECTED);
        const recovered = yield* Effect.promise(() =>
          awaitValue<ViewQuery, Cause.NoSuchElementError>(registry, atom, (q) => q._tag === "ok"),
        );
        expect(recovered._tag).toBe("ok");
      }),
    ),
  );

  it.live("marks are throttled on a project refresh but not on a pull request refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const clock = { now: 1_000 };
        const script: Script = { view: [], marks: [], failView: false };
        const {
          registry,
          pullRequestMarksAtom,
          pullRequestViewAtom,
          refreshProject,
          refreshPullRequests,
        } = yield* runtimeWith(fakeClient(script), clock);
        const marks = pullRequestMarksAtom(projectId);
        const view = pullRequestViewAtom({ projectId });
        registry.mount(marks);
        registry.mount(view);
        yield* Effect.promise(() =>
          awaitValue<MarksQuery, Cause.NoSuchElementError>(registry, marks, (q) => q._tag === "ok"),
        );
        yield* Effect.promise(() =>
          awaitValue<ViewQuery, Cause.NoSuchElementError>(registry, view, (q) => q._tag === "ok"),
        );
        expect(script.marks).toEqual([{ projectId }]);

        // A window return a moment later: the view rereads, the marks do not.
        clock.now += 5_000;
        refreshProject(registry, projectId);
        yield* Effect.promise(() =>
          awaitValue<ViewQuery, Cause.NoSuchElementError>(
            registry,
            view,
            (q) => q._tag === "ok" && q.value.state === "none" && q.value.branch === "branch-2",
          ),
        );
        yield* Effect.promise(() =>
          awaitValue<MarksQuery, Cause.NoSuchElementError>(registry, marks, (q) => q._tag === "ok"),
        );
        expect(script.marks).toHaveLength(1);

        // Past the interval, the next return lists again.
        clock.now += MARKS_MIN_INTERVAL_MS;
        refreshProject(registry, projectId);
        yield* Effect.promise(() =>
          awaitValue<MarksQuery, Cause.NoSuchElementError>(
            registry,
            marks,
            () => script.marks.length === 2,
          ),
        );

        // An explicit refresh goes through at once.
        refreshPullRequests(registry, projectId);
        yield* Effect.promise(() =>
          awaitValue<MarksQuery, Cause.NoSuchElementError>(
            registry,
            marks,
            () => script.marks.length === 3,
          ),
        );
        expect(script.marks).toHaveLength(3);
      }),
    ),
  );
});
