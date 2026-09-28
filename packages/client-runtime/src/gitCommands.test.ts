/**
 * The git writes over a stubbed RPC client. What the start screen relies on:
 * the setup atom shows the output while the script is still running, a
 * finished run resolves with everything it printed and its exit status, a
 * background start's setup run resolves with the finished run on its own, and
 * the writes send the payload the server expects. What the git actions
 * control relies on: a commit or a push refetches the status it shows, and
 * two writes in flight at once each finish with their own result.
 */

import { describe, expect, it } from "@effect/vitest";
import type { GitBranchList, WorktreeSetupFrame } from "@poseidon/contracts/git";
import { makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { isObject } from "effect/Predicate";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
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
import {
  emptySetupProgress,
  makeGitCommands,
  type GitCommandsOptions,
  scanSetupFrame,
  type WorktreeSetupProgress,
} from "./gitCommands";
import { makeGitAtoms } from "./gitAtoms";

const WORKTREE = {
  path: "/home/me/.poseidon/worktrees/app/fix-login",
  branch: "poseidon/fix-login",
};

interface Calls {
  readonly create: Array<unknown>;
  readonly setup: Array<unknown>;
  readonly remove: Array<unknown>;
  readonly branches: Array<unknown>;
  readonly commit: Array<unknown>;
  readonly push: Array<unknown>;
  readonly pullRequest: Array<unknown>;
  readonly status: Array<unknown>;
  /** Calls cut short before they answered. */
  readonly interrupted: Array<unknown>;
}

const branchList = (branches: ReadonlyArray<string>): GitBranchList => ({
  isRepository: true,
  current: "main",
  defaultBranch: "main",
  remotes: [],
  branches: branches.map((name) => ({ name, kind: "local" as const, isCurrent: name === "main" })),
});

/** A worktree cut from `OFFLINE` answers with `OFFLINE_NOTICE`. */
const OFFLINE = "offline";
const OFFLINE_NOTICE =
  "Couldn't fetch offline from origin, so the worktree starts from your local offline.";

/** A commit whose message is `SLOW` waits for `gate` before it answers. */
const SLOW = "slow";

type Frames = Queue.Queue<WorktreeSetupFrame, Cause.Done>;

/**
 * A setup run reads the queue registered for its worktree path in
 * `setupFrames`, else the shared `frames` — so two runs can be fed apart.
 */
const fakeClient = (
  calls: Calls,
  frames: Frames,
  setupFrames: Map<string, Frames>,
  gate: Deferred.Deferred<void>,
): PoseidonRpcClient =>
  new Proxy({} as PoseidonRpcClient, {
    get: (_target, key) => {
      switch (key) {
        case "git.worktree.create":
          return (payload: unknown) =>
            Effect.sync(() => {
              calls.create.push(payload);
              // A base origin cannot serve is cut from the local branch, with a notice.
              return isObject(payload) && "baseBranch" in payload && payload.baseBranch === OFFLINE
                ? { ...WORKTREE, baseBranch: OFFLINE, notice: OFFLINE_NOTICE }
                : { ...WORKTREE, baseBranch: "main" };
            });
        case "git.worktree.setup":
          return (payload: { readonly path: string }) => {
            calls.setup.push(payload);
            return Stream.fromQueue(setupFrames.get(payload.path) ?? frames).pipe(
              Stream.onExit((exit) =>
                Effect.sync(() => {
                  if (Exit.hasInterrupts(exit)) {
                    calls.interrupted.push(payload);
                  }
                }),
              ),
            );
          };
        case "git.worktree.remove":
          return (payload: unknown) =>
            Effect.sync(() => {
              calls.remove.push(payload);
              return {};
            });
        case "git.branches":
          return (payload: unknown) =>
            Effect.sync(() => {
              calls.branches.push(payload);
              // A create adds a branch; the list the second fetch sees has it.
              return branchList(
                calls.create.length > calls.remove.length ? ["main", WORKTREE.branch] : ["main"],
              );
            });
        case "git.commit":
          return (payload: { readonly message: string }) =>
            Effect.gen(function* () {
              calls.commit.push(payload);
              if (payload.message === SLOW) {
                yield* Deferred.await(gate);
              }
              return {
                sha: payload.message === SLOW ? "5105105" : "abc1234def",
                subject: payload.message,
                branch: WORKTREE.branch,
              };
            }).pipe(Effect.onInterrupt(() => Effect.sync(() => calls.interrupted.push(payload))));
        case "git.push":
          return (payload: unknown) =>
            Effect.sync(() => {
              calls.push.push(payload);
              return { remote: "origin", branch: WORKTREE.branch, setUpstream: true };
            });
        case "git.pullRequest.create":
          return (payload: unknown) =>
            Effect.sync(() => {
              calls.pullRequest.push(payload);
              return { url: "https://github.com/acme/app/pull/7", created: true };
            });
        case "git.status":
          return (payload: unknown) =>
            Effect.sync(() => {
              calls.status.push(payload);
              // A commit leaves nothing behind; a push leaves nothing ahead.
              return {
                branch: WORKTREE.branch,
                upstream: calls.push.length > 0 ? `origin/${WORKTREE.branch}` : null,
                ahead: calls.commit.length > calls.push.length ? 1 : 0,
                behind: 0,
                isRepository: true,
                files:
                  calls.commit.length > 0
                    ? []
                    : [{ path: "src/login.ts", status: "modified", staged: false }],
              };
            });
        default:
          return () => Effect.die(`unimplemented rpc ${String(key)}`);
      }
    },
  });

const setupWithOptions = (options: GitCommandsOptions) =>
  Effect.gen(function* () {
    const calls: Calls = {
      create: [],
      setup: [],
      remove: [],
      branches: [],
      commit: [],
      push: [],
      pullRequest: [],
      status: [],
      interrupted: [],
    };
    const gate = yield* Deferred.make<void>();
    const frames = yield* Queue.unbounded<WorktreeSetupFrame, Cause.Done>();
    const setupFrames = new Map<string, Frames>();
    const stateRef = yield* SubscriptionRef.make<ConnectionState>({
      status: "connected",
      serverInstanceId: null,
    });
    const layer = Layer.mergeAll(
      Layer.succeed(Connection, {
        client: Effect.succeed(fakeClient(calls, frames, setupFrames, gate)),
        state: stateRef,
      }),
      Layer.succeed(ConnectionStateRef, stateRef),
    );
    const base = makeRuntime(layer);
    const git = makeGitAtoms(base.runtime);
    return {
      calls,
      frames,
      setupFrames,
      gate,
      registry: AtomRegistry.make(),
      git,
      ...makeGitCommands(base.runtime, git, options),
    };
  });

const setupWith = setupWithOptions({});

/** Resolves on the first result matching the predicate — no timers in logic. */
const awaitResult = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  predicate: (result: AsyncResult.AsyncResult<A, E>) => boolean,
): Promise<AsyncResult.AsyncResult<A, E>> =>
  new Promise((resolve) => {
    const check = (result: AsyncResult.AsyncResult<A, E>) => {
      if (predicate(result)) {
        unmount();
        resolve(result);
      }
    };
    const unmount = registry.subscribe(atom, check);
    check(registry.get(atom));
  });

describe("scanSetupFrame", () => {
  it("collects output in order and ends on the exit status", () => {
    const frames: ReadonlyArray<WorktreeSetupFrame> = [
      { kind: "output", text: "installing\n" },
      { kind: "output", text: "warn: peer dep\n" },
      { kind: "exit", exitCode: 3 },
    ];
    expect(frames.reduce(scanSetupFrame, emptySetupProgress)).toEqual({
      output: "installing\nwarn: peer dep\n",
      exit: { code: 3 },
      skipped: false,
    });
  });

  it("keeps the signal of a killed script", () => {
    expect(
      scanSetupFrame(emptySetupProgress, { kind: "exit", exitCode: null, signal: "SIGTERM" }),
    ).toEqual({ output: "", exit: { code: null, signal: "SIGTERM" }, skipped: false });
  });

  it("marks a project without a script as skipped", () => {
    expect(scanSetupFrame(emptySetupProgress, { kind: "skipped" })).toEqual({
      output: "",
      exit: null,
      skipped: true,
    });
  });
});

describe("git commands", () => {
  it.live("the setup atom shows output before the script has finished", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const { calls, frames, registry, worktreeSetupAtom } = yield* setupWith;
      registry.mount(worktreeSetupAtom);
      registry.set(worktreeSetupAtom, { projectId, path: WORKTREE.path });

      yield* Queue.offer(frames, { kind: "output", text: "installing\n" });
      const partial = yield* Effect.promise(() =>
        awaitResult(
          registry,
          worktreeSetupAtom,
          (result) => AsyncResult.isSuccess(result) && result.value.output === "installing\n",
        ),
      );
      // Still running: no exit yet, and the atom says it is waiting for more.
      expect(AsyncResult.isSuccess(partial) && partial.value.exit).toBeNull();
      expect(partial.waiting).toBe(true);

      yield* Queue.offer(frames, { kind: "output", text: "done\n" });
      yield* Queue.offer(frames, { kind: "exit", exitCode: 0 });
      yield* Queue.end(frames);
      const finished = yield* Effect.promise(() =>
        awaitResult(registry, worktreeSetupAtom, (result) => !result.waiting),
      );
      expect(AsyncResult.isSuccess(finished) && finished.value).toEqual<WorktreeSetupProgress>({
        output: "installing\ndone\n",
        exit: { code: 0 },
        skipped: false,
      });
      expect(calls.setup).toEqual([{ projectId, path: WORKTREE.path }]);
    }),
  );

  it.live("a setup run resolves with the whole output and the exit code", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const { calls, frames, registry, worktreeSetupRun } = yield* setupWith;
      const run = worktreeSetupRun(registry, { projectId, path: WORKTREE.path });
      yield* Queue.offer(frames, { kind: "output", text: "installing\n" });
      yield* Queue.offer(frames, { kind: "output", text: "warn: peer dep\n" });
      yield* Queue.offer(frames, { kind: "exit", exitCode: 3 });
      yield* Queue.end(frames);
      const finished = yield* Effect.promise(() => run);
      expect(Exit.isSuccess(finished) && finished.value).toEqual<WorktreeSetupProgress>({
        output: "installing\nwarn: peer dep\n",
        exit: { code: 3 },
        skipped: false,
      });
      expect(calls.setup).toEqual([{ projectId, path: WORKTREE.path }]);
    }),
  );

  it.live("a setup run of a project without a script resolves as skipped", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const { frames, registry, worktreeSetupRun } = yield* setupWith;
      const run = worktreeSetupRun(registry, { projectId, path: WORKTREE.path });
      yield* Queue.offer(frames, { kind: "skipped" });
      yield* Queue.end(frames);
      const finished = yield* Effect.promise(() => run);
      expect(Exit.isSuccess(finished) && finished.value).toEqual<WorktreeSetupProgress>({
        output: "",
        exit: null,
        skipped: true,
      });
    }),
  );

  it.live("overlapping setup runs each finish with their own run", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const { calls, registry, setupFrames, worktreeSetupRun } = yield* setupWith;
      const first = yield* Queue.unbounded<WorktreeSetupFrame, Cause.Done>();
      const second = yield* Queue.unbounded<WorktreeSetupFrame, Cause.Done>();
      setupFrames.set("/wt/one", first);
      setupFrames.set("/wt/two", second);

      // The first lane's script is still running when the second one starts.
      const runOne = worktreeSetupRun(registry, { projectId, path: "/wt/one" });
      yield* Queue.offer(first, { kind: "output", text: "one\n" });
      yield* Effect.promise(() => expect.poll(() => calls.setup.length).toBe(1));
      const runTwo = worktreeSetupRun(registry, { projectId, path: "/wt/two" });
      yield* Effect.promise(() => expect.poll(() => calls.setup.length).toBe(2));

      yield* Queue.offer(second, { kind: "output", text: "two\n" });
      yield* Queue.offer(second, { kind: "exit", exitCode: 1 });
      yield* Queue.end(second);
      const finishedTwo = yield* Effect.promise(() => runTwo);
      expect(Exit.isSuccess(finishedTwo) && finishedTwo.value).toEqual<WorktreeSetupProgress>({
        output: "two\n",
        exit: { code: 1 },
        skipped: false,
      });

      yield* Queue.offer(first, { kind: "exit", exitCode: 0 });
      yield* Queue.end(first);
      const finishedOne = yield* Effect.promise(() => runOne);
      expect(Exit.isSuccess(finishedOne) && finishedOne.value).toEqual<WorktreeSetupProgress>({
        output: "one\n",
        exit: { code: 0 },
        skipped: false,
      });
    }),
  );

  it.live("an aborted setup run ends its stream and resolves as interrupted", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const { calls, frames, registry, worktreeSetupRun } = yield* setupWith;
      const controller = new AbortController();
      // A script that never exits: nothing ends the queue.
      const run = worktreeSetupRun(
        registry,
        { projectId, path: WORKTREE.path },
        { signal: controller.signal },
      );
      yield* Queue.offer(frames, { kind: "output", text: "watching\n" });
      yield* Effect.promise(() => expect.poll(() => calls.setup.length).toBe(1));
      controller.abort();
      const finished = yield* Effect.promise(() => run);
      expect(Exit.isFailure(finished) && Cause.hasInterruptsOnly(finished.cause)).toBe(true);
      yield* Effect.promise(() =>
        expect.poll(() => calls.interrupted).toEqual([{ projectId, path: WORKTREE.path }]),
      );
    }),
  );

  it.live("a create sends the name and base, and refetches the project's branches", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const { calls, registry, git, worktreeCreate } = yield* setupWith;
      const branchesAtom = git.gitBranchesAtom({ projectId });
      registry.mount(branchesAtom);
      yield* Effect.promise(() =>
        awaitResult(registry, branchesAtom, (result) => AsyncResult.isSuccess(result)),
      );

      const created = yield* Effect.promise(() =>
        worktreeCreate(registry, { projectId, name: "Fix the login", baseBranch: "main" }),
      );
      expect(Exit.isSuccess(created) && created.value.branch).toBe(WORKTREE.branch);
      expect(calls.create).toEqual([{ projectId, name: "Fix the login", baseBranch: "main" }]);

      const refreshed = yield* Effect.promise(() =>
        awaitResult(
          registry,
          branchesAtom,
          (result) =>
            AsyncResult.isSuccess(result) &&
            result.value._tag === "ok" &&
            result.value.value.branches.length === 2,
        ),
      );
      expect(AsyncResult.isSuccess(refreshed)).toBe(true);
    }),
  );

  it.live("a create's notice goes to onWorktreeNotice and not into the worktree", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const notices: Array<string> = [];
      const { registry, worktreeCreate } = yield* setupWithOptions({
        onWorktreeNotice: (notice) => notices.push(notice),
      });

      const quiet = yield* Effect.promise(() =>
        worktreeCreate(registry, { projectId, name: "Fix the login", baseBranch: "main" }),
      );
      expect(notices).toEqual([]);
      expect(Exit.isSuccess(quiet) && quiet.value).toEqual({ ...WORKTREE, baseBranch: "main" });

      const created = yield* Effect.promise(() =>
        worktreeCreate(registry, { projectId, name: "Fix the login", baseBranch: OFFLINE }),
      );
      expect(notices).toEqual([OFFLINE_NOTICE]);
      expect(Exit.isSuccess(created) && created.value).toEqual({
        ...WORKTREE,
        baseBranch: OFFLINE,
      });
    }),
  );

  it.live("a remove sends force only when asked", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const { calls, registry, worktreeRemove } = yield* setupWith;
      yield* Effect.promise(() =>
        worktreeRemove(registry, { projectId, path: WORKTREE.path, force: true }),
      );
      yield* Effect.promise(() => worktreeRemove(registry, { projectId, path: WORKTREE.path }));
      expect(calls.remove).toEqual([
        { projectId, path: WORKTREE.path, force: true },
        { projectId, path: WORKTREE.path },
      ]);
    }),
  );

  it.live("a commit sends the chosen paths and refetches the thread's status", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const threadId = makeThreadId();
      const { calls, registry, git, commit } = yield* setupWith;
      const statusAtom = git.gitStatusAtom({ projectId, threadId });
      registry.mount(statusAtom);
      yield* Effect.promise(() =>
        awaitResult(
          registry,
          statusAtom,
          (result) =>
            AsyncResult.isSuccess(result) &&
            result.value._tag === "ok" &&
            result.value.value.files.length === 1,
        ),
      );

      const committed = yield* Effect.promise(() =>
        commit(registry, {
          projectId,
          threadId,
          message: "Fix the login",
          paths: ["src/login.ts"],
        }),
      );
      expect(Exit.isSuccess(committed) && committed.value.sha).toBe("abc1234def");
      expect(calls.commit).toEqual([
        { projectId, threadId, message: "Fix the login", paths: ["src/login.ts"] },
      ]);

      const refreshed = yield* Effect.promise(() =>
        awaitResult(
          registry,
          statusAtom,
          (result) =>
            AsyncResult.isSuccess(result) &&
            result.value._tag === "ok" &&
            result.value.value.files.length === 0 &&
            result.value.value.ahead === 1,
        ),
      );
      expect(AsyncResult.isSuccess(refreshed)).toBe(true);
    }),
  );

  it.live("a push refetches the status, and a pull request sends its title and body", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const threadId = makeThreadId();
      const { calls, registry, git, push, openPullRequest } = yield* setupWith;
      const statusAtom = git.gitStatusAtom({ projectId, threadId });
      registry.mount(statusAtom);
      yield* Effect.promise(() =>
        awaitResult(registry, statusAtom, (result) => AsyncResult.isSuccess(result)),
      );

      yield* Effect.promise(() => push(registry, { projectId, threadId }));
      yield* Effect.promise(() =>
        awaitResult(
          registry,
          statusAtom,
          (result) =>
            AsyncResult.isSuccess(result) &&
            result.value._tag === "ok" &&
            result.value.value.upstream === `origin/${WORKTREE.branch}`,
        ),
      );
      expect(calls.push).toEqual([{ projectId, threadId }]);

      const opened = yield* Effect.promise(() =>
        openPullRequest(registry, { projectId, threadId, title: "Fix the login", body: "" }),
      );
      expect(Exit.isSuccess(opened) && opened.value.url).toBe("https://github.com/acme/app/pull/7");
      expect(calls.pullRequest).toEqual([
        { projectId, threadId, title: "Fix the login", body: "" },
      ]);
    }),
  );

  it.live("overlapping writes neither interrupt each other nor swap results", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const { calls, gate, registry, commit } = yield* setupWith;
      // Thread A's commit is still running (a slow hook) when thread B commits.
      const first = commit(registry, { projectId, threadId: makeThreadId(), message: SLOW });
      yield* Effect.promise(() => expect.poll(() => calls.commit.length).toBe(1));
      const second = yield* Effect.promise(() =>
        commit(registry, { projectId, threadId: makeThreadId(), message: "Fix the login" }),
      );
      expect(Exit.isSuccess(second) && second.value.sha).toBe("abc1234def");

      yield* Deferred.succeed(gate, undefined);
      const settled = yield* Effect.promise(() => first);
      expect(Exit.isSuccess(settled) && settled.value.sha).toBe("5105105");
      expect(calls.interrupted).toEqual([]);
      expect(calls.commit.map((call) => (call as { message: string }).message)).toEqual([
        SLOW,
        "Fix the login",
      ]);
    }),
  );
});
