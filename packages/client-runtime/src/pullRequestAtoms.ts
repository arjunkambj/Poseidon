/**
 * The pull request half of the client runtime: the atoms the Pull request
 * dock tab and the sidebar's pull request marks read.
 *
 * - `pullRequestViewAtom(scope)` — `git.pullRequest.view` for a thread's
 *   branch (its worktree's, when it has one), or the project's.
 * - `pullRequestMarksAtom(projectId)` — `git.pullRequest.marks`, one mark per
 *   thread of the project whose branch has a pull request.
 * - `refreshPullRequests(registry, projectId)` — reread both now: the pane's
 *   refresh button, and after a write to the pull request.
 *
 * They follow the git atoms' two shapes (`./gitAtoms`): each is a stream
 * driven by the connection's status, so a mounted read fetches on connect and
 * again on every reconnect, and a failed call is a value (`GitQuery`) so the
 * stream outlives it. Both also depend on the project's git revision
 * (`GitAtoms.projectRevisionAtom`), so the header's `refreshProject` on
 * window return rereads a mounted pull request with everything else — there
 * is no timer here.
 *
 * Every read is a gh call on the server, and the marks list the repository's
 * newest pull requests, so marks are throttled per project: a revision bump
 * within `MARKS_MIN_INTERVAL_MS` of the last successful listing answers that
 * listing again instead of calling gh. `refreshPullRequests` is an explicit
 * ask and always goes through.
 */

import type { ProjectId } from "@poseidon/contracts/ids";
import type { PullRequestMarks, PullRequestView } from "@poseidon/contracts/pullRequest";
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
          call<PullRequestView>((client) =>
            client["git.pullRequest.view"]({
              projectId: scope.projectId,
              ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
            }),
          ),
        ),
      );
    });
  });

  const pullRequestMarksByIdAtom = Atom.family((projectId: ProjectId) =>
    runtime.atom((get) => {
      get(git.projectRevisionAtom(projectId));
      get(pullRequestRevisionAtom(projectId));
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

  return { pullRequestViewAtom, pullRequestMarksAtom, refreshPullRequests };
};

export type PullRequestAtoms = ReturnType<typeof makePullRequestAtoms>;
