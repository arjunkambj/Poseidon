/**
 * The pull request half of the client runtime: the atoms the Pull request
 * dock tab and the sidebar's pull request marks read.
 *
 * - `pullRequestViewAtom(scope)` — `git.pullRequest.view` for a thread's
 *   branch (its worktree's, when it has one), or the project's.
 * - `pullRequestMarksAtom(projectId)` — `git.pullRequest.marks`, one mark per
 *   thread of the project whose branch has a pull request.
 * - `refreshPullRequests(registry, projectId)` — reread both now: the pane's
 *   refresh button, after a write to the pull request, and after a pull
 *   request is opened (`./gitCommands`).
 * - `revisitPullRequestMarks(registry, projectId)` — the sidebar's window
 *   return for a project whose threads carry marks: rereads the marks only,
 *   and only past their throttle.
 * - `runPullRequestAction(registry, input)` — `git.pullRequest.action`, a
 *   one-shot (`./oneShot`) that resolves with its own `Exit`: the view as it
 *   is after the write, or the server's refusal. Either way the project's pull
 *   request reads are refreshed once it settles, marks included, so the tab
 *   and the sidebar follow a merge or a close.
 * - `pullRequestFixContext(registry, input)` — `git.pullRequest.fixContext`,
 *   the one-shot a "fix" thread's first message is built from.
 *
 * They follow the git atoms' two shapes (`./gitAtoms`): each is a stream
 * driven by the connection's status, so a mounted read fetches on connect and
 * again on every reconnect, and a failed call is a value (`GitQuery`) so the
 * stream outlives it. Both also depend on the project's git revision
 * (`GitAtoms.projectRevisionAtom`), so the header's `refreshProject` on
 * window return rereads a mounted pull request with everything else — there
 * is no timer here.
 *
 * Every read is a gh call on the server, and the marks run one per branch
 * the project's threads are on, so marks are throttled per project: a revision bump
 * within `MARKS_MIN_INTERVAL_MS` of the last successful listing answers that
 * listing again instead of calling gh. `refreshPullRequests` is an explicit
 * ask and always goes through.
 */

import type { ProjectId } from "@poseidon/contracts/ids";
import type {
  PullRequestAction,
  PullRequestMarks,
  PullRequestView,
} from "@poseidon/contracts/pullRequest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import * as Atom from "effect/unstable/reactivity/Atom";

import { Connection, ConnectionStateRef, type PoseidonRpcClient } from "./connection";
import {
  decodeGitScope,
  encodeGitScope,
  type GitAtoms,
  type GitQuery,
  type GitScope,
} from "./gitAtoms";
import { runOneShot } from "./oneShot";

/** A write to pull request `number` of the scope's branch. */
export interface PullRequestActionInput {
  readonly scope: GitScope;
  readonly number: number;
  /** The head commit the pane showed; a merge pins it. */
  readonly headRefOid?: string;
  readonly action: PullRequestAction;
}

/** What a fix thread for pull request `number` of the scope's branch starts from. */
export interface PullRequestFixContextInput {
  readonly scope: GitScope;
  readonly number: number;
  readonly kind: "checks" | "conflicts";
}

const scopePayload = (scope: GitScope) => ({
  projectId: scope.projectId,
  ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
});

/** How long a marks listing stands before a revision bump lists again. */
export const MARKS_MIN_INTERVAL_MS = 60_000;

export interface PullRequestAtomsOptions {
  /** The clock the marks throttle reads; tests pass their own. */
  readonly now?: () => number;
}

export const makePullRequestAtoms = (
  runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>,
  git: Pick<GitAtoms, "projectRevisionAtom">,
  options: PullRequestAtomsOptions = {},
) => {
  const now = options.now ?? Date.now;

  /** One tick per connected epoch, as in `./gitAtoms`. */
  const connectedEpochs = Effect.gen(function* () {
    const state = yield* ConnectionStateRef;
    return SubscriptionRef.changes(state).pipe(
      Stream.map((connection) => connection.status),
      Stream.changes,
      Stream.filter((status) => status === "connected"),
    );
  }).pipe(Stream.unwrap);

  /** Bumped by `refreshPullRequests`: the pull request reads only, not every git read. */
  const pullRequestRevisionAtom = Atom.family((_projectId: ProjectId) =>
    Atom.make(0).pipe(Atom.keepAlive),
  );

  /** Bumped by `revisitPullRequestMarks`: the marks only, and still throttled. */
  const marksRevisionAtom = Atom.family((_projectId: ProjectId) =>
    Atom.make(0).pipe(Atom.keepAlive),
  );

  /** The last successful marks listing per project, and when it was taken. */
  const lastMarks = new Map<ProjectId, { readonly at: number; readonly value: PullRequestMarks }>();
  /** Projects whose next marks read skips the throttle: an explicit refresh. */
  const forced = new Set<ProjectId>();

  const call = <A>(
    run: (client: PoseidonRpcClient) => Effect.Effect<A, { readonly message: string }>,
  ): Effect.Effect<GitQuery<A>, never, Connection> =>
    Effect.gen(function* () {
      const client = yield* (yield* Connection).client;
      return yield* run(client);
    }).pipe(
      Effect.map((value): GitQuery<A> => ({ _tag: "ok", value })),
      Effect.catch((error) =>
        Effect.succeed<GitQuery<A>>({ _tag: "error", message: error.message }),
      ),
    );

  const pullRequestViewByKeyAtom = Atom.family((key: string) => {
    const scope = decodeGitScope(key);
    return runtime.atom((get) => {
      get(git.projectRevisionAtom(scope.projectId));
      get(pullRequestRevisionAtom(scope.projectId));
      return connectedEpochs.pipe(
        Stream.mapEffect(() =>
          call<PullRequestView>((client) => client["git.pullRequest.view"](scopePayload(scope))),
        ),
      );
    });
  });

  const pullRequestMarksByIdAtom = Atom.family((projectId: ProjectId) =>
    runtime.atom((get) => {
      get(git.projectRevisionAtom(projectId));
      get(pullRequestRevisionAtom(projectId));
      get(marksRevisionAtom(projectId));
      return connectedEpochs.pipe(
        Stream.mapEffect(() => {
          const last = lastMarks.get(projectId);
          if (
            !forced.has(projectId) &&
            last !== undefined &&
            now() - last.at < MARKS_MIN_INTERVAL_MS
          ) {
            return Effect.succeed<GitQuery<PullRequestMarks>>({ _tag: "ok", value: last.value });
          }
          forced.delete(projectId);
          return call<PullRequestMarks>((client) =>
            client["git.pullRequest.marks"]({ projectId }),
          ).pipe(
            Effect.tap((query) =>
              Effect.sync(() => {
                if (query._tag === "ok") {
                  lastMarks.set(projectId, { at: now(), value: query.value });
                }
              }),
            ),
          );
        }),
      );
    }),
  );

  const pullRequestViewAtom = (scope: GitScope) => pullRequestViewByKeyAtom(encodeGitScope(scope));
  const pullRequestMarksAtom = (projectId: ProjectId) => pullRequestMarksByIdAtom(projectId);

  /** Reread the project's pull request reads now, marks included. */
  const refreshPullRequests = (registry: AtomRegistry.AtomRegistry, projectId: ProjectId) => {
    forced.add(projectId);
    registry.update(pullRequestRevisionAtom(projectId), (revision) => revision + 1);
  };

  /**
   * The user is back: list the project's marks again if the last listing is
   * older than `MARKS_MIN_INTERVAL_MS`, else answer it again. Nothing else rereads.
   */
  const revisitPullRequestMarks = (registry: AtomRegistry.AtomRegistry, projectId: ProjectId) => {
    registry.update(marksRevisionAtom(projectId), (revision) => revision + 1);
  };

  /**
   * One write, run on its own (`./oneShot`) so it outlives the menu that
   * started it. Whatever the answer, the pull request moved or may have: the
   * project's view and marks are reread once it settles.
   */
  const runPullRequestAction = (
    registry: AtomRegistry.AtomRegistry,
    input: PullRequestActionInput,
  ) =>
    runOneShot(runtime, registry, () =>
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return yield* client["git.pullRequest.action"]({
          ...scopePayload(input.scope),
          number: input.number,
          ...(input.headRefOid === undefined ? {} : { headRefOid: input.headRefOid }),
          action: input.action,
        });
      }).pipe(
        Effect.ensuring(Effect.sync(() => refreshPullRequests(registry, input.scope.projectId))),
      ),
    );

  /** A read, but asked for once at the moment a fix thread starts — never kept. */
  const pullRequestFixContext = (
    registry: AtomRegistry.AtomRegistry,
    input: PullRequestFixContextInput,
  ) =>
    runOneShot(runtime, registry, () =>
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return yield* client["git.pullRequest.fixContext"]({
          ...scopePayload(input.scope),
          number: input.number,
          kind: input.kind,
        });
      }),
    );

  return {
    pullRequestViewAtom,
    pullRequestMarksAtom,
    refreshPullRequests,
    revisitPullRequestMarks,
    runPullRequestAction,
    pullRequestFixContext,
  };
};

export type PullRequestAtoms = ReturnType<typeof makePullRequestAtoms>;
