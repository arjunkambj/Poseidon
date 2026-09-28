/**
 * The git half of the client runtime: the atoms the changes pane reads.
 *
 * - `gitStatusAtom(scope)` — `git.status` for the project's workspace, or for
 *   a thread's own root (its worktree) when the scope names the thread.
 * - `gitDiffAtom(range)` — `git.diff` for one comparison. `from`/`to` are the
 *   server's own argument shape: omitting `to` diffs the working tree against
 *   `from` (default `HEAD`), giving both "working tree" and "working tree vs a
 *   turn checkpoint"; supplying both diffs checkpoint to checkpoint, and
 *   `mergeBase` diffs the working tree against where the branch forked.
 * - `gitBranchesAtom(scope)` — `git.branches`, the branch picker's list.
 * - `gitPullRequestReadinessAtom(scope)` — `git.pullRequest.readiness`, why
 *   `gh` cannot open a pull request there, which the header's git button reads
 *   before it offers Create PR.
 * - `checkpointsAtom(key)` — `checkpoints.list`, the thread's checkpoints that
 *   still exist in the repository, which the timeline intersects with its own
 *   fold before it offers a restore.
 * - `createBranch` / `checkout` — the picker's two writes, each a one-shot
 *   call (`./oneShot`) that resolves with its own `Exit`: the new branch list,
 *   or the server's refusal. A success refetches every git read of the
 *   project — branches, status and diffs, for every thread — so the header
 *   and the Changes pane follow the switch. A switch in the project's folder
 *   moves every local thread of it at once, so refetching only the scope that
 *   asked would leave its siblings showing the old branch.
 *
 * Two deliberate shapes here:
 *
 * 1. Each atom is a **stream driven by the connection's status**, not a
 *    one-shot effect. `SubscriptionRef.changes` replays the current status on
 *    mount, so a pane opened while connected fetches immediately, and a
 *    reconnect (`connected → reconnecting → connected`) refetches by itself.
 *    Offline, the status never reaches `connected`, the stream stays silent and
 *    the atom stays `Initial` — the pane pairs that with the connection state
 *    and says "not connected" rather than "no changes".
 * 2. Failures are **values**, not the atom's error channel (`GitQuery`). A
 *    failed status call must not tear the stream down, or the next reconnect
 *    would have nothing left to refetch on; the pane shows the message and the
 *    same atom recovers on its own.
 *
 * This module is additive on purpose: it takes the `AtomRuntime` that
 * `makeRuntime` already built rather than defining a second one, so the git
 * atoms share one connection with everything else.
 */

import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { CheckpointSummary } from "@poseidon/contracts/orchestration";
import type { GitStatus } from "@poseidon/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import * as Atom from "effect/unstable/reactivity/Atom";

import { Connection, ConnectionStateRef, type PoseidonRpcClient } from "./connection";
import { runOneShot } from "./oneShot";

/**
 * A git RPC's outcome as a value. `error` carries the server's message so the
 * pane can show what went wrong (a bad ref, git missing from PATH) and offer a
 * retry, instead of rendering an empty file list that looks like "no changes".
 */
export type GitQuery<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "error"; readonly message: string };

const ok = <A>(value: A): GitQuery<A> => ({ _tag: "ok", value });
const failed = <A>(message: string): GitQuery<A> => ({ _tag: "error", message });

/**
 * Which directory a git read runs in: the thread's own root when `threadId`
 * is set — its worktree, when it has one — and the project's otherwise.
 */
export interface GitScope {
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId | undefined;
}

/** `Atom.family` keys have to be primitives; a test pins the round trip. */
export const encodeGitScope = (scope: GitScope): string =>
  JSON.stringify([scope.projectId, scope.threadId ?? null]);

export const decodeGitScope = (key: string): GitScope => {
  const [projectId, threadId] = JSON.parse(key) as [ProjectId, ThreadId | null];
  return { projectId, ...(threadId === null ? {} : { threadId }) };
};

/** Which comparison the pane is showing. `undefined` ends mean the defaults. */
export interface GitDiffRange extends GitScope {
  /** Base ref; `undefined` is the server's default, `HEAD`. */
  readonly from?: string | undefined;
  /** Target ref; `undefined` means the working tree. */
  readonly to?: string | undefined;
  /** Diff the working tree against the merge base of `HEAD` and this ref. */
  readonly mergeBase?: string | undefined;
  /** Diff with `-w`. Part of the key, so toggling it refetches. */
  readonly ignoreWhitespace?: boolean | undefined;
}

/**
 * `Atom.family` keys have to be primitives, so a range becomes one string.
 * Keep it a total round trip: the atom decodes the key back into the RPC
 * payload, and a test pins that encode → decode is the identity.
 */
export const encodeDiffRange = (range: GitDiffRange): string =>
  JSON.stringify([
    range.projectId,
    range.threadId ?? null,
    range.from ?? null,
    range.to ?? null,
    range.mergeBase ?? null,
    range.ignoreWhitespace ?? null,
  ]);

export const decodeDiffRange = (key: string): GitDiffRange => {
  const [projectId, threadId, from, to, mergeBase, ignoreWhitespace] = JSON.parse(key) as [
    ProjectId,
    ThreadId | null,
    string | null,
    string | null,
    string | null,
    boolean | null | undefined,
  ];
  return {
    projectId,
    ...(threadId === null ? {} : { threadId }),
    ...(from === null ? {} : { from }),
    ...(to === null ? {} : { to }),
    ...(mergeBase === null ? {} : { mergeBase }),
    ...(ignoreWhitespace === null || ignoreWhitespace === undefined ? {} : { ignoreWhitespace }),
  };
};

/**
 * Which thread's checkpoints to list, and for which revision of its fold.
 * `revision` is the caller's word for "the list may have changed" — the
 * timeline passes the number of checkpoints its fold holds — and a new one is
 * a new atom, read fresh: an answer from before a checkpoint was created can
 * never be taken for one after it. It is not sent to the server.
 */
export interface CheckpointsKey {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly revision: string;
}

export const encodeCheckpointsKey = (key: CheckpointsKey): string =>
  JSON.stringify([key.projectId, key.threadId, key.revision]);

export const decodeCheckpointsKey = (key: string): CheckpointsKey => {
  const [projectId, threadId, revision] = JSON.parse(key) as [ProjectId, ThreadId, string];
  return { projectId, threadId, revision };
};

/** The branch picker's "new branch": cut from `from` (default `HEAD`), switched to when `checkout`. */
export interface GitCreateBranch extends GitScope {
  readonly name: string;
  readonly from?: string | undefined;
  readonly checkout: boolean;
}

/** The branch picker's switch: a local branch, or a remote one to track. */
export interface GitCheckout extends GitScope {
  readonly branch: string;
}

/** The scope half of a payload, without an absent `threadId` on the wire. */
const scopePayload = (scope: GitScope) => ({
  projectId: scope.projectId,
  ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
});

/**
 * `git.status` answers `branch: null` with no files both for "not a git
 * repository" and for a project the server does not know — the two cases are
 * indistinguishable on the wire and the pane says the same thing for both.
 */
export const isRepoless = (status: GitStatus): boolean =>
  status.branch === null && status.files.length === 0;

export const makeGitAtoms = (runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>) => {
  /** One tick per connected epoch: mount, and every reconnect after that. */
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

  /**
   * A counter per project that every git read of that project depends on.
   * Bumping it rebuilds each mounted read, which restarts its stream and
   * refetches on the replayed status; an unmounted one fetches fresh when it
   * next mounts anyway. `Atom.family` cannot list its members, so this is how
   * a branch write reaches the diff ranges it never saw.
   */
  const projectRevisionAtom = Atom.family((_projectId: ProjectId) =>
    Atom.make(0).pipe(Atom.keepAlive),
  );

  /**
   * One git read as an atom: `call` once per connected epoch, rerun from the
   * top whenever the project's revision moves, with a failed call kept as a
   * value (`GitQuery`) so the stream survives it.
   */
  const gitRead = <A>(
    projectId: ProjectId,
    call: (client: PoseidonRpcClient) => Effect.Effect<A, { readonly message: string }>,
  ) =>
    runtime.atom((get) => {
      get(projectRevisionAtom(projectId));
      return connectedEpochs.pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const client = yield* (yield* Connection).client;
            return yield* call(client);
          }).pipe(
            Effect.map(ok<A>),
            Effect.catch((error) => Effect.succeed(failed<A>(error.message))),
          ),
        ),
      );
    });

  const gitStatusByKeyAtom = Atom.family((key: string) => {
    const scope = decodeGitScope(key);
    return gitRead(scope.projectId, (client) => client["git.status"](scopePayload(scope)));
  });

  const gitDiffByKeyAtom = Atom.family((key: string) => {
    const range = decodeDiffRange(key);
    return gitRead(range.projectId, (client) =>
      client["git.diff"]({
        ...scopePayload(range),
        ...(range.from === undefined ? {} : { from: range.from }),
        ...(range.to === undefined ? {} : { to: range.to }),
        ...(range.mergeBase === undefined ? {} : { mergeBase: range.mergeBase }),
        ...(range.ignoreWhitespace === undefined
          ? {}
          : { ignoreWhitespace: range.ignoreWhitespace }),
      }),
    );
  });

  const gitBranchesByKeyAtom = Atom.family((key: string) => {
    const scope = decodeGitScope(key);
    return gitRead(scope.projectId, (client) => client["git.branches"](scopePayload(scope)));
  });

  const gitPullRequestReadinessByKeyAtom = Atom.family((key: string) => {
    const scope = decodeGitScope(key);
    return gitRead(scope.projectId, (client) =>
      client["git.pullRequest.readiness"](scopePayload(scope)),
    );
  });

  const checkpointsByKeyAtom = Atom.family((key: string) => {
    const { projectId, threadId } = decodeCheckpointsKey(key);
    return gitRead<ReadonlyArray<CheckpointSummary>>(projectId, (client) =>
      client["checkpoints.list"]({ projectId, threadId }),
    );
  });

  /** The pane's handles: one atom per scope and per comparison, shared across mounts. */
  const gitStatusAtom = (scope: GitScope) => gitStatusByKeyAtom(encodeGitScope(scope));
  const gitDiffAtom = (range: GitDiffRange) => gitDiffByKeyAtom(encodeDiffRange(range));
  const gitBranchesAtom = (scope: GitScope) => gitBranchesByKeyAtom(encodeGitScope(scope));
  const gitPullRequestReadinessAtom = (scope: GitScope) =>
    gitPullRequestReadinessByKeyAtom(encodeGitScope(scope));
  const checkpointsAtom = (key: CheckpointsKey) => checkpointsByKeyAtom(encodeCheckpointsKey(key));

  /**
   * After a branch write every git read of the project is stale: the current
   * branch moved, and so did what each working tree is compared with. A switch
   * in the project's folder moves all of its local threads at once, so the
   * whole project refetches — not only the scope that asked.
   */
  const refreshProject = (registry: AtomRegistry.AtomRegistry, projectId: ProjectId) =>
    registry.update(projectRevisionAtom(projectId), (revision) => revision + 1);

  /**
   * The branch picker's new branch. Fails with the server's refusal (a bad
   * name, a dirty tree) for the caller to show.
   */
  const createBranch = (registry: AtomRegistry.AtomRegistry, input: GitCreateBranch) =>
    runOneShot(runtime, registry, () =>
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        const list = yield* client["git.branch.create"]({
          ...scopePayload(input),
          name: input.name,
          ...(input.from === undefined ? {} : { from: input.from }),
          checkout: input.checkout,
        });
        refreshProject(registry, input.projectId);
        return list;
      }),
    );

  /** The branch picker's switch. Fails with `conflict` on a dirty tracked tree or a running turn in that root. */
  const checkout = (registry: AtomRegistry.AtomRegistry, input: GitCheckout) =>
    runOneShot(runtime, registry, () =>
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        const list = yield* client["git.checkout"]({
          ...scopePayload(input),
          branch: input.branch,
        });
        refreshProject(registry, input.projectId);
        return list;
      }),
    );

  return {
    gitStatusAtom,
    gitDiffAtom,
    gitBranchesAtom,
    gitPullRequestReadinessAtom,
    checkpointsAtom,
    createBranch,
    checkout,
    refreshProject,
  };
};

export type GitAtoms = ReturnType<typeof makeGitAtoms>;
