/**
 * What the changes pane's selection means, with no React in the way.
 *
 * The pane has three scopes (`ChangesScope`), picked from one Compare menu:
 *
 * - **A turn** — what that turn changed: the previous turn's checkpoint
 *   against its own. The first turn has no snapshot before it, so it starts
 *   from `HEAD`. Unless one is picked, the latest turn shows.
 * - **Branch** — the working tree against the point where the branch forked
 *   from its base (`mergeBase`), so it shows the branch's commits plus
 *   whatever is not committed yet.
 * - **Uncommitted** — the working tree against `HEAD`: both ends omitted.
 *
 * `diffRangeFor` is the single place that translates a selection into the RPC
 * payload, so every scope is one code path. It also carries the View menu's
 * "Ignore whitespace", only when it is on, so the default range (and its
 * cached answer) is the same as before the option existed.
 */

import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { GitDiffRange } from "@poseidon/client-runtime/gitAtoms";
import type { CheckpointSummary } from "@poseidon/contracts/orchestration";

import type { ChangesScope } from "@/state/ui";

const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * Checkpoints are appended in turn order, so the index is the turn number the
 * user saw in the timeline. The time disambiguates a long thread; a checkpoint
 * with an unparseable timestamp still gets a label.
 */
export const checkpointLabel = (checkpoint: CheckpointSummary, index: number): string => {
  const at = new Date(checkpoint.createdAt);
  return Number.isNaN(at.getTime())
    ? `Turn ${index + 1}`
    : `Turn ${index + 1} · ${TIME.format(at)}`;
};

/**
 * The index of the turn "This turn" shows: the one picked while it is still
 * in the thread, else the latest — a picked ref can be pruned with a deleted
 * thread or gone after a resnapshot. `-1` when the thread has no checkpoints.
 */
export const pickTurn = (
  checkpoints: ReadonlyArray<CheckpointSummary>,
  choice: string | null,
): number => {
  const picked = checkpoints.findIndex((checkpoint) => checkpoint.ref === choice);
  return picked === -1 ? checkpoints.length - 1 : picked;
};

/**
 * What one turn changed: the checkpoint before it to its own. Checkpoints are
 * root commits, so there is no parent to ask for the first turn's starting
 * point; `HEAD` (an omitted `from`) stands in for it.
 */
export const turnRange = (
  previous: CheckpointSummary | undefined,
  turn: CheckpointSummary,
): { readonly from: string | null; readonly to: string } => ({
  from: previous?.ref ?? null,
  to: turn.ref,
});

/** What one scope compares; only a turn carries refs, `from: null` being `HEAD`. */
export type ChangesSelection =
  | {
      readonly scope: Extract<ChangesScope, "turn">;
      readonly from: string | null;
      readonly to: string;
    }
  | { readonly scope: Extract<ChangesScope, "branch">; readonly mergeBase: string | null }
  | { readonly scope: Extract<ChangesScope, "uncommitted"> };

/**
 * The `git.diff` payload for one selection, or `null` for "Branch" with no
 * base to compare with. A `HEAD` start becomes an omitted end, and the thread
 * picks the directory — its worktree, when it has one; with no thread (the
 * New task page) it is the project's own folder.
 */
export const diffRangeFor = (
  where: { readonly projectId: ProjectId; readonly threadId?: ThreadId | undefined },
  selection: ChangesSelection,
  ignoreWhitespace = false,
): GitDiffRange | null => {
  const scope = {
    projectId: where.projectId,
    ...(where.threadId === undefined ? {} : { threadId: where.threadId }),
    ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}),
  };
  switch (selection.scope) {
    case "turn":
      return {
        ...scope,
        ...(selection.from === null ? {} : { from: selection.from }),
        to: selection.to,
      };
    case "branch":
      return selection.mergeBase === null ? null : { ...scope, mergeBase: selection.mergeBase };
    case "uncommitted":
      return scope;
  }
};

/**
 * The branch "Branch" compares with: the worktree's own base when the
 * thread was started in one — it records what it was cut from — else the
 * repository's default branch. `undefined` while the branch list has not
 * answered, `null` when there is nothing to compare with.
 */
export const branchBaseFor = (
  worktreeBase: string | undefined,
  defaultBranch: string | null | undefined,
): string | null | undefined => worktreeBase ?? defaultBranch;
