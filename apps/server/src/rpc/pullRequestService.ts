/**
 * The pull request half of `GitService` (`./services`): reading the current
 * branch's pull request and the project's marks, and acting on one through
 * the GitHub CLI. Implemented in `git/PullRequests.ts` and
 * `git/PullRequestActions.ts`, joined into the service's shape here so
 * `services.ts` stays within its size budget.
 */

import type { ProjectId } from "@poseidon/contracts/ids";
import type {
  PullRequestAction,
  PullRequestFixContext,
  PullRequestMarks,
  PullRequestView,
} from "@poseidon/contracts/pullRequest";
import type { PoseidonRpcError } from "@poseidon/contracts/rpc";
import type * as Effect from "effect/Effect";

import type { WorkspaceScope } from "./services";

export interface PullRequestMethods {
  /** The pull request of the workspace's current branch, read through the GitHub CLI. */
  readonly viewPullRequest: (
    scope: WorkspaceScope,
  ) => Effect.Effect<PullRequestView, PoseidonRpcError>;
  /** The pull request marks of the project's live threads; empty when gh cannot answer. */
  readonly pullRequestMarks: (
    projectId: ProjectId,
  ) => Effect.Effect<PullRequestMarks, PoseidonRpcError>;
  /** Runs one gh write on the workspace's pull request and answers the view afterwards. */
  readonly pullRequestAction: (
    scope: WorkspaceScope,
    request: {
      readonly number: number;
      readonly headRefOid?: string | undefined;
      readonly action: PullRequestAction;
    },
  ) => Effect.Effect<PullRequestView, PoseidonRpcError>;
  /** The failing-check logs or conflicting files a thread fixing the pull request starts from. */
  readonly pullRequestFixContext: (
    scope: WorkspaceScope,
    request: { readonly number: number; readonly kind: "checks" | "conflicts" },
  ) => Effect.Effect<PullRequestFixContext, PoseidonRpcError>;
}
