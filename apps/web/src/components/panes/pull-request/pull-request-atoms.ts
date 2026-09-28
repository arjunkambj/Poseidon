/**
 * The app's pull request atoms, built on the git atoms of the same client
 * runtime (`../changes/git-atoms.ts`), so they share its connection and its
 * per-project git revision: the header's refresh on window return rereads a
 * mounted pull request with every other git read.
 *
 * Built once per git atoms — per client runtime — as the git atoms are per
 * runtime, so a fixture page under its own `ClientRuntimeProvider` reads its
 * scripted client instead of the app's socket. They live beside the git atoms
 * (`pullRequestAtomsFor`) so the app's git writes reread the same ones.
 */

import { RegistryContext } from "@effect/atom-react";
import type { GitQuery } from "@poseidon/client-runtime/gitAtoms";
import type { PullRequestAtoms } from "@poseidon/client-runtime/pullRequestAtoms";
import type { ProjectId } from "@poseidon/contracts/ids";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { useClientRuntime } from "@/lib/client-runtime";

import { pullRequestAtomsFor, useGitAtoms } from "../changes/git-atoms";

export const usePullRequestAtoms = (): PullRequestAtoms =>
  pullRequestAtomsFor(useClientRuntime().runtime, useGitAtoms());

/** Reread the project's pull request and marks now: the refresh button, an action's end. */
export const useRefreshPullRequests = (projectId: ProjectId): (() => void) => {
  const registry = React.useContext(RegistryContext);
  const { refreshPullRequests } = usePullRequestAtoms();
  return React.useCallback(
    () => refreshPullRequests(registry, projectId),
    [refreshPullRequests, registry, projectId],
  );
};

/**
 * What the pane renders from one pull request atom, or `null` while it has
 * not answered. `broken` is the atom's own error channel — a defect the
 * stream could not catch — which no reconnect will fix, so it reads as an
 * error with a retry rather than a load that never ends.
 */
export type PullRequestQuery<A> = GitQuery<A> | { readonly _tag: "broken" };

export const pullRequestQuery = <A>(
  result: AsyncResult.AsyncResult<GitQuery<A>, unknown>,
): PullRequestQuery<A> | null =>
  AsyncResult.isSuccess(result)
    ? result.value
    : AsyncResult.isFailure(result)
      ? { _tag: "broken" }
      : null;
