/**
 * Pull request atoms over a stubbed RPC client: the view reads the scope it
 * was asked for, a failure is a value the atom survives, a project refresh
 * rereads a mounted view, and the marks listing is throttled except when a
 * refresh asks for it — or a pull request was just opened.
 */

import { describe, expect, it } from "@effect/vitest";
import { makeProjectId, makeThreadId, type ThreadId } from "@poseidon/contracts/ids";
import type {
  PullRequestFixContext,
  PullRequestMarks,
  PullRequestView,
} from "@poseidon/contracts/pullRequest";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import type * as Cause from "effect/Cause";
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
import { makeGitCommands } from "./gitCommands";
import { MARKS_MIN_INTERVAL_MS, makePullRequestAtoms } from "./pullRequestAtoms";

const CONNECTED: ConnectionState = { status: "connected", serverInstanceId: null };
const RECONNECTING: ConnectionState = { status: "reconnecting", serverInstanceId: null };

interface Script {
  readonly view: Array<{ projectId: string; threadId?: string }>;
  readonly marks: Array<{ projectId: string }>;
  /** The view's next answer: a branch with none, or a refusal. */
  failView: boolean;
  readonly actions?: Array<unknown>;
  readonly fixContexts?: Array<unknown>;
  /** The action's next answer is gh's refusal. */
  failAction?: boolean;
  /** Set once `git.pullRequest.create` ran: the marks then list the thread's. */
  opened?: { readonly threadId: string };
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
      if (key === "git.pullRequest.action") {
        return (payload: unknown) =>
          Effect.gen(function* () {
            script.actions?.push(payload);
            if (script.failAction === true) {
              return yield* Effect.fail(
                new PoseidonRpcError({
                  code: "conflict",
                  message:
                    "Pull request #7 is not mergeable: the merge commit cannot be cleanly created.",
                }),
              );
            }
            return noneOn("merged-away");
          });
      }
      if (key === "git.pullRequest.fixContext") {
        return (payload: unknown) =>
          Effect.sync((): PullRequestFixContext => {
            script.fixContexts?.push(payload);
            return { checks: [], conflictFiles: ["a.txt"], base: "origin/main" };
          });
      }
      if (key === "git.pullRequest.marks") {
        return (payload: { projectId: string }) =>
          Effect.sync((): PullRequestMarks => {
            script.marks.push({ ...payload });
            const opened = script.opened;
            return {
              marks:
                opened === undefined
                  ? []
                  : [
                      {
                        threadId: opened.threadId as ThreadId,
                        number: 7,
                        url: "https://github.com/acme/app/pull/7",
                        state: "open",
                        isDraft: false,
                        failing: false,
                      },
                    ],
            };
          });
      }
      if (key === "git.push") {
        return () => Effect.succeed({ remote: "origin", branch: "fix-login", setUpstream: true });
      }
      if (key === "git.pullRequest.create") {
        return (payload: { threadId: string }) =>
          Effect.sync(() => {
            script.opened = { threadId: payload.threadId };
            return { url: "https://github.com/acme/app/pull/7", created: true };
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
    const pullRequests = makePullRequestAtoms(base.runtime, git, { now: () => clock.now });
    const { push, openPullRequest } = makeGitCommands(base.runtime, git, { pullRequests });
    return {
      registry: AtomRegistry.make(),
      stateRef,
      refreshProject: git.refreshProject,
      push,
      openPullRequest,
      ...pullRequests,
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

  it.live("a sidebar revisit rereads only the marks, and only past the throttle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const clock = { now: 1_000 };
        const script: Script = { view: [], marks: [], failView: false };
        const { registry, pullRequestMarksAtom, pullRequestViewAtom, revisitPullRequestMarks } =
          yield* runtimeWith(fakeClient(script), clock);
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

        // Back a moment later: the last listing answers again.
        clock.now += 5_000;
        revisitPullRequestMarks(registry, projectId);
        yield* Effect.promise(() =>
          awaitValue<MarksQuery, Cause.NoSuchElementError>(registry, marks, (q) => q._tag === "ok"),
        );
        expect(script.marks).toHaveLength(1);

        // Back after the interval: one new listing, and the view is left alone.
        clock.now += MARKS_MIN_INTERVAL_MS;
        revisitPullRequestMarks(registry, projectId);
        yield* Effect.promise(() =>
          awaitValue<MarksQuery, Cause.NoSuchElementError>(
            registry,
            marks,
            () => script.marks.length === 2,
          ),
        );
        expect(script.view).toHaveLength(1);
      }),
    ),
  );

  it.live("a pull request opened right after a push is marked at once, inside the throttle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const threadId = makeThreadId();
        const clock = { now: 1_000 };
        const script: Script = { view: [], marks: [], failView: false };
        const { registry, pullRequestMarksAtom, push, openPullRequest } = yield* runtimeWith(
          fakeClient(script),
          clock,
        );
        const marks = pullRequestMarksAtom(projectId);
        registry.mount(marks);
        yield* Effect.promise(() =>
          awaitValue<MarksQuery, Cause.NoSuchElementError>(registry, marks, (q) => q._tag === "ok"),
        );
        expect(script.marks).toHaveLength(1);

        // The push is a project refresh: inside the throttle, the empty listing stands.
        clock.now += 1_000;
        yield* Effect.promise(() => push(registry, { projectId, threadId }));
        yield* Effect.promise(() =>
          awaitValue<MarksQuery, Cause.NoSuchElementError>(registry, marks, (q) => q._tag === "ok"),
        );
        expect(script.marks).toHaveLength(1);

        // Opening the pull request a moment later lists again, and the thread is marked.
        clock.now += 1_000;
        const opened = yield* Effect.promise(() =>
          openPullRequest(registry, { projectId, threadId, title: "Fix the login", body: "" }),
        );
        expect(Exit.isSuccess(opened)).toBe(true);
        const marked = yield* Effect.promise(() =>
          awaitValue<MarksQuery, Cause.NoSuchElementError>(
            registry,
            marks,
            (q) => q._tag === "ok" && q.value.marks.length === 1,
          ),
        );
        expect(marked._tag === "ok" && marked.value.marks[0]).toMatchObject({
          threadId,
          number: 7,
        });
        expect(script.marks).toHaveLength(2);
      }),
    ),
  );

  it.live("an action sends the pinned head and refreshes the marks whatever it answers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const threadId = makeThreadId();
        const clock = { now: 1_000 };
        const script: Script = { view: [], marks: [], failView: false, actions: [] };
        const { registry, pullRequestMarksAtom, runPullRequestAction } = yield* runtimeWith(
          fakeClient(script),
          clock,
        );
        const marks = pullRequestMarksAtom(projectId);
        registry.mount(marks);
        yield* Effect.promise(() =>
          awaitValue<MarksQuery, Cause.NoSuchElementError>(registry, marks, (q) => q._tag === "ok"),
        );

        const merged = yield* Effect.promise(() =>
          runPullRequestAction(registry, {
            scope: { projectId, threadId },
            number: 7,
            headRefOid: "0123456789abcdef",
            action: { kind: "merge", method: "squash" },
          }),
        );
        expect(Exit.isSuccess(merged) && merged.value).toEqual(noneOn("merged-away"));
        expect(script.actions).toEqual([
          {
            projectId,
            threadId,
            number: 7,
            headRefOid: "0123456789abcdef",
            action: { kind: "merge", method: "squash" },
          },
        ]);
        // Well inside the throttle, and still the marks list again.
        yield* Effect.promise(() =>
          awaitValue<MarksQuery, Cause.NoSuchElementError>(
            registry,
            marks,
            () => script.marks.length === 2,
          ),
        );

        script.failAction = true;
        const refused = yield* Effect.promise(() =>
          runPullRequestAction(registry, {
            scope: { projectId },
            number: 7,
            action: { kind: "close" },
          }),
        );
        expect(Exit.isFailure(refused)).toBe(true);
        expect(script.actions?.[1]).toEqual({ projectId, number: 7, action: { kind: "close" } });
        yield* Effect.promise(() =>
          awaitValue<MarksQuery, Cause.NoSuchElementError>(
            registry,
            marks,
            () => script.marks.length === 3,
          ),
        );
      }),
    ),
  );

  it.live("the fix context is asked for the scope, number and kind", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const threadId = makeThreadId();
      const script: Script = { view: [], marks: [], failView: false, fixContexts: [] };
      const { registry, pullRequestFixContext } = yield* runtimeWith(fakeClient(script), {
        now: 0,
      });
      const exit = yield* Effect.promise(() =>
        pullRequestFixContext(registry, {
          scope: { projectId, threadId },
          number: 7,
          kind: "conflicts",
        }),
      );
      expect(Exit.isSuccess(exit) && exit.value.conflictFiles).toEqual(["a.txt"]);
      expect(script.fixContexts).toEqual([{ projectId, threadId, number: 7, kind: "conflicts" }]);
    }),
  );
});
