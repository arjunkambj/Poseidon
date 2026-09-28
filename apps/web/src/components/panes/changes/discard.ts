/**
 * What discarding means for the comparison on screen, with no React in the
 * way: which base a file goes back to, what the confirmation says is lost,
 * and the `git.discard` payload.
 *
 * A discard puts a file back to the comparison's base (`reviewScopeFields`):
 *
 * - **Uncommitted** — `HEAD`; the payload names no base.
 * - **Branch** — the point where the branch forked from its base branch
 *   (`mergeBase`, which the server turns into the fork point).
 * - **A turn** — the checkpoint before it (`source`). The first turn has no
 *   checkpoint before it and starts from `HEAD`, so it names no base either.
 *
 * A file the base does not have (`kind: "create"`) is deleted; a rename
 * names both of its paths, so the old one comes back and the new one goes.
 * "Discard all" is the Uncommitted scope's alone: the server refuses it with
 * a base, and any other scope would mean something else by "all".
 */

import type { GitDiscard } from "@poseidon/client-runtime/gitReview";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { GitDiffFile } from "@poseidon/contracts/rpc";

import type { ChangesScope } from "@/state/ui";

import type { ChangesSelection } from "./selection";

/** The base a discard restores to; neither field is `HEAD`. */
export interface ReviewBase {
  readonly source?: string;
  readonly mergeBase?: string;
}

/** What a scope's discard needs besides the file: its kind, base and the base's name. */
export interface ReviewScopeFields {
  readonly kind: ChangesScope;
  readonly base: ReviewBase;
  /** `HEAD`, the base branch's name, or `before Turn N`. */
  readonly baseLabel: string;
}

/** The discard fields of one selection; `turnName` names the shown turn ("Turn 3"). */
export const reviewScopeFields = (
  selection: ChangesSelection,
  turnName: string,
): ReviewScopeFields => {
  switch (selection.scope) {
    case "turn":
      return {
        kind: "turn",
        base: selection.from === null ? {} : { source: selection.from },
        baseLabel: `before ${turnName}`,
      };
    case "branch":
      return {
        kind: "branch",
        base: selection.mergeBase === null ? {} : { mergeBase: selection.mergeBase },
        baseLabel: selection.mergeBase ?? "its base",
      };
    case "uncommitted":
      return { kind: "uncommitted", base: {}, baseLabel: "HEAD" };
  }
};

/**
 * Why discarding cannot start now, or `null`. Offline the call never answers;
 * under a running turn or restore the server refuses it (`requireIdle`), and
 * a disabled entry with the reason beats a refusal after the fact.
 */
export const discardBlockedReason = (state: {
  readonly connected: boolean;
  readonly restoring: boolean;
  readonly turnRunning: boolean;
}): string | null =>
  !state.connected
    ? "Not connected to the server."
    : state.restoring
      ? "A restore is running."
      : state.turnRunning
        ? "A turn is running — stop it before discarding."
        : null;

/** Only the Uncommitted scope offers "Discard all". */
export const canDiscardAll = (kind: ChangesScope): boolean => kind === "uncommitted";

type DiscardFile = Pick<GitDiffFile, "path" | "oldPath" | "kind">;

/** The paths one file's discard names: a rename's old path too. */
export const discardPaths = (file: DiscardFile): ReadonlyArray<string> =>
  file.oldPath === undefined ? [file.path] : [file.path, file.oldPath];

/** The base, after "goes back to how" or "comes back as": "it is in HEAD". */
const atBase = (scope: ReviewScopeFields): string => {
  switch (scope.kind) {
    case "uncommitted":
      return "it is in HEAD";
    case "branch":
      return `it was where the branch forked from ${scope.baseLabel}`;
    case "turn":
      return `it was ${scope.baseLabel}`;
  }
};

/** What discarding one file loses, in the scope's own terms. */
export const discardDescription = (file: DiscardFile, scope: ReviewScopeFields): string => {
  const back = atBase(scope);
  if (file.oldPath !== undefined) {
    return `The rename is undone: ${file.oldPath} comes back as ${back}, and ${file.path} is deleted along with any edits made to it.`;
  }
  if (file.kind === "delete") {
    return `${file.path} comes back as ${back}.`;
  }
  if (file.kind === "create") {
    switch (scope.kind) {
      case "uncommitted":
        return `${file.path} is deleted and cannot be recovered.`;
      case "branch":
        return `${file.path} is deleted from the working copy, since it did not exist where the branch forked from ${scope.baseLabel}. Its uncommitted edits are lost; the branch's commits are not changed.`;
      case "turn":
        return `${file.path} is deleted, since it did not exist ${scope.baseLabel}. Anything written to it since is lost.`;
    }
  }
  switch (scope.kind) {
    case "uncommitted":
      return `Your uncommitted edits to ${file.path} are lost; it goes back to how ${back}.`;
    case "branch":
      return `${file.path} goes back to how ${back}: its uncommitted edits and the branch's changes to it are undone in the working copy. The branch's commits are not changed.`;
    case "turn":
      return `${file.path} goes back to how ${back}; anything written to it since is lost.`;
  }
};

/** What "Discard all" loses: every uncommitted change, and the new files named by count. */
export const discardAllDescription = (files: ReadonlyArray<Pick<GitDiffFile, "kind">>): string => {
  const created = files.filter((file) => file.kind === "create").length;
  const deleted =
    created === 0
      ? ""
      : ` and ${created === 1 ? "the 1 new file is" : `the ${created} new files are`} deleted`;
  return `Every uncommitted change in the repository is lost: tracked files go back to how they are in HEAD${deleted}. This cannot be undone.`;
};

/** Where the discard runs: the project, and the thread whose worktree it is. */
export interface ReviewWhere {
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId | undefined;
}

/** What a discard acts on: one file, or everything uncommitted. */
export type DiscardTarget =
  | { readonly kind: "file"; readonly file: DiscardFile }
  | { readonly kind: "all"; readonly files: ReadonlyArray<Pick<GitDiffFile, "kind">> };

/** The `git.discard` payload for a target in a scope; "all" names no paths and no base. */
export const discardInput = (
  where: ReviewWhere,
  base: ReviewBase,
  target: DiscardTarget,
): GitDiscard => {
  const scope = {
    projectId: where.projectId,
    ...(where.threadId === undefined ? {} : { threadId: where.threadId }),
  };
  return target.kind === "all" ? scope : { ...scope, ...base, paths: discardPaths(target.file) };
};
