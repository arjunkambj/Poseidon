/**
 * The app's git atoms, built once on the app's own `AtomRuntime`.
 *
 * `@/state/app-runtime` owns the single runtime; this adds the git reads (the
 * Changes pane's) and the git writes (the start screen's worktree steps, the
 * header's branch picker and git actions) on top of it the same way
 * `@/lib/app-runtime` adds the settings ones, so they share one WebSocket with
 * the rest of the app instead of opening a second connection.
 *
 * The writes are one-shot calls on the app's registry, not atoms a component
 * mounts: `useGitCommands` and `useBranchWrites` bind them to the registry in
 * context, and each call resolves with its own `Exit` even when another call
 * is in flight or the component that started it is gone.
 *
 * `useGitReview` adds the pane's discard and blame (`makeGitReview`) on the
 * client runtime in context, next to the reads they refresh.
 *
 * The reads are built per client runtime, as the file atoms are
 * (`../files/file-atoms.ts`): in the app that is the one runtime above, and a
 * fixture page under its own `ClientRuntimeProvider` reads git — the timeline's
 * checkpoint list, say — over its scripted client instead of the app's socket.
 * The pull request atoms (`../pull-request/pull-request-atoms.ts`) are built
 * here too, once per git atoms, so the git writes can reread them: opening a
 * pull request relists the marks the dock's Pull request tab and the sidebar's
 * glyph wait on.
 */

import { RegistryContext } from "@effect/atom-react";
import { makeGitAtoms, type GitAtoms } from "@poseidon/client-runtime/gitAtoms";
import { makeGitCommands, type GitCommands } from "@poseidon/client-runtime/gitCommands";
import { makeGitReview, type GitDiscard, type GitReview } from "@poseidon/client-runtime/gitReview";
import {
  makePullRequestAtoms,
  type PullRequestAtoms,
} from "@poseidon/client-runtime/pullRequestAtoms";
import * as React from "react";

import { type ClientRuntime, useClientRuntime } from "@/lib/client-runtime";
import { getAppAtoms } from "@/state/app-runtime";

const byRuntime = new WeakMap<ClientRuntime["runtime"], GitAtoms>();
const pullRequestsByGit = new WeakMap<GitAtoms, PullRequestAtoms>();
let gitCommands: GitCommands | null = null;

const gitAtomsFor = (runtime: ClientRuntime["runtime"]): GitAtoms => {
  let atoms = byRuntime.get(runtime);
  if (atoms === undefined) {
    atoms = makeGitAtoms(runtime);
    byRuntime.set(runtime, atoms);
  }
  return atoms;
};

/** The pull request atoms on `git`, built on the runtime `git` was built on. */
export const pullRequestAtomsFor = (
  runtime: ClientRuntime["runtime"],
  git: GitAtoms,
): PullRequestAtoms => {
  let atoms = pullRequestsByGit.get(git);
  if (atoms === undefined) {
    atoms = makePullRequestAtoms(runtime, git);
    pullRequestsByGit.set(git, atoms);
  }
  return atoms;
};

const getGitAtoms = (): GitAtoms => gitAtomsFor(getAppAtoms().runtime);

const getGitCommands = (): GitCommands => {
  const { runtime } = getAppAtoms();
  const git = getGitAtoms();
  gitCommands ??= makeGitCommands(runtime, git, {
    pullRequests: pullRequestAtomsFor(runtime, git),
  });
  return gitCommands;
};

export const useGitAtoms = (): GitAtoms => gitAtomsFor(useClientRuntime().runtime);

/** The branch picker's writes, bound to the app's registry. */
export const useBranchWrites = () => {
  const registry = React.useContext(RegistryContext);
  return React.useMemo(() => {
    const git = getGitAtoms();
    return {
      checkout: (input: Parameters<GitAtoms["checkout"]>[1]) => git.checkout(registry, input),
      createBranch: (input: Parameters<GitAtoms["createBranch"]>[1]) =>
        git.createBranch(registry, input),
    };
  }, [registry]);
};

const reviewByRuntime = new WeakMap<ClientRuntime["runtime"], GitReview>();

/**
 * The Changes pane's discard and blame (`makeGitReview`), on the client
 * runtime in context like the reads, so a success refreshes the very atoms
 * the pane shows; `discard` is bound to the registry in context.
 */
export const useGitReview = () => {
  const runtime = useClientRuntime().runtime;
  const registry = React.useContext(RegistryContext);
  return React.useMemo(() => {
    let review = reviewByRuntime.get(runtime);
    if (review === undefined) {
      review = makeGitReview(runtime, gitAtomsFor(runtime));
      reviewByRuntime.set(runtime, review);
    }
    const { blameAtom } = review;
    const discardWith = review.discard;
    return {
      discard: (input: GitDiscard) => discardWith(registry, input),
      blameAtom,
    };
  }, [runtime, registry]);
};

/**
 * The worktree and commit writes, bound to the app's registry. The start
 * panel's setup stays an atom it watches; `worktreeSetupRun` is the one-shot
 * setup for a start nothing watches.
 */
export const useGitCommands = () => {
  const registry = React.useContext(RegistryContext);
  return React.useMemo(() => {
    const commands = getGitCommands();
    return {
      worktreeSetupAtom: commands.worktreeSetupAtom,
      worktreeCreate: (input: Parameters<GitCommands["worktreeCreate"]>[1]) =>
        commands.worktreeCreate(registry, input),
      worktreeSetupRun: (
        input: Parameters<GitCommands["worktreeSetupRun"]>[1],
        options?: Parameters<GitCommands["worktreeSetupRun"]>[2],
      ) => commands.worktreeSetupRun(registry, input, options),
      worktreeRemove: (input: Parameters<GitCommands["worktreeRemove"]>[1]) =>
        commands.worktreeRemove(registry, input),
      commit: (input: Parameters<GitCommands["commit"]>[1]) => commands.commit(registry, input),
      push: (input: Parameters<GitCommands["push"]>[1]) => commands.push(registry, input),
      openPullRequest: (input: Parameters<GitCommands["openPullRequest"]>[1]) =>
        commands.openPullRequest(registry, input),
    };
  }, [registry]);
};
