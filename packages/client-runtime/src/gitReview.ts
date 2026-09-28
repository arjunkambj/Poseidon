/**
 * The Changes pane's review calls beyond the diff, on the same runtime and git
 * atoms as its reads.
 *
 * - `discard` — `git.discard`: throws away the change to some files, or to
 *   everything uncommitted, and resolves with its own `Exit` (a one-shot call,
 *   `./oneShot`). A success refetches every git read of the project — status,
 *   diffs and blames, for every thread — the way a commit does, since every
 *   scope on that repository just moved.
 * - `blameAtom(key)` — `git.blame` of one file, or a range of its lines, as a
 *   `GitQuery` like the diff atom: fetched when mounted (the pane mounts it on
 *   demand only), refetched on reconnect and whenever the project's git reads
 *   are refreshed, with a failure kept as a value.
 *
 * Paths are the ones `git.diff` answered with: relative to the repository's
 * top level, not the workspace root.
 */

import type { GitBlame } from "@poseidon/contracts/git-review";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import * as Effect from "effect/Effect";
import * as Atom from "effect/unstable/reactivity/Atom";
import type * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";

import { Connection, type ConnectionStateRef } from "./connection";
import type { GitAtoms, GitScope } from "./gitAtoms";
import { runOneShot } from "./oneShot";

/**
 * What to discard. An empty `paths` discards nothing. Without `paths`, everything uncommitted (only with neither
 * `source` nor `mergeBase`). `source` is the turn scope's `from` checkpoint,
 * `mergeBase` the branch scope's base; with neither, `HEAD`.
 */
export interface GitDiscard extends GitScope {
  readonly paths?: ReadonlyArray<string> | undefined;
  readonly source?: string | undefined;
  readonly mergeBase?: string | undefined;
}

/** Which file, and optionally which lines (1-based, inclusive), to blame. */
export interface GitBlameKey extends GitScope {
  readonly path: string;
  readonly startLine?: number | undefined;
  readonly endLine?: number | undefined;
}

/** `Atom.family` keys have to be primitives; a test pins the round trip. */
export const encodeBlameKey = (key: GitBlameKey): string =>
  JSON.stringify([
    key.projectId,
    key.threadId ?? null,
    key.path,
    key.startLine ?? null,
    key.endLine ?? null,
  ]);

export const decodeBlameKey = (encoded: string): GitBlameKey => {
  const [projectId, threadId, path, startLine, endLine] = JSON.parse(encoded) as [
    ProjectId,
    ThreadId | null,
    string,
    number | null,
    number | null,
  ];
  return {
    projectId,
    ...(threadId === null ? {} : { threadId }),
    path,
    ...(startLine === null ? {} : { startLine }),
    ...(endLine === null ? {} : { endLine }),
  };
};

/** The scope half of a payload, without an absent `threadId` on the wire. */
const scopePayload = (scope: GitScope) => ({
  projectId: scope.projectId,
  ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
});

export const makeGitReview = (
  runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>,
  git: GitAtoms,
) => {
  const client = Effect.flatMap(Connection, (connection) => connection.client);

  /** Fails with `invalid` for an unsafe path or scope, `conflict` while a turn runs there. */
  const discard = (registry: AtomRegistry.AtomRegistry, input: GitDiscard) =>
    runOneShot(runtime, registry, () =>
      Effect.gen(function* () {
        const paths = input.paths;
        // An empty list names nothing: it must never widen into "everything".
        if (paths !== undefined && paths.length === 0) return;
        yield* Effect.flatMap(client, (c) =>
          c["git.discard"]({
            ...scopePayload(input),
            ...(paths === undefined ? {} : { paths: [paths[0]!, ...paths.slice(1)] as const }),
            ...(input.source === undefined ? {} : { source: input.source }),
            ...(input.mergeBase === undefined ? {} : { mergeBase: input.mergeBase }),
          }),
        );
        git.refreshProject(registry, input.projectId);
      }),
    );

  const blameByKeyAtom = Atom.family((encoded: string) => {
    const key = decodeBlameKey(encoded);
    return git.gitRead<GitBlame>(key.projectId, (c) =>
      c["git.blame"]({
        ...scopePayload(key),
        path: key.path,
        ...(key.startLine === undefined ? {} : { startLine: key.startLine }),
        ...(key.endLine === undefined ? {} : { endLine: key.endLine }),
      }),
    );
  });

  const blameAtom = (key: GitBlameKey) => blameByKeyAtom(encodeBlameKey(key));

  return { discard, blameAtom };
};

export type GitReview = ReturnType<typeof makeGitReview>;
