/**
 * The Changes pane's file list for one comparison.
 *
 * The diff is the file list, because `GitDiff.files` already carries the path,
 * the `+`/`-` counts and the per-file patch. It reads as an overview first:
 * one compact row per file — its kind, directory and name, and counts — with
 * every patch closed until the user opens it. An open file's patch scrolls under its sticky header, so
 * the pane still reads top to bottom like one review. Which files are open is
 * the thread's own and kept per path (`useChangesReview`), so a new turn or
 * another comparison does not open them all again. Each patch renders through
 * `InlineDiff`, so highlighting stays on the shared worker pool and the dock
 * never blocks the main thread.
 *
 * Once the diff answers, `ReviewList` renders the files with the thread's
 * review over them. `ComparisonBody` is what a Changes pane shows under its
 * toolbar — this list, or why there is no comparison to list — for the
 * thread's pane and the New task page's alike.
 */

import { useAtomValue } from "@effect/atom-react";
import { isRepoless, type GitDiffRange, type GitQuery } from "@poseidon/client-runtime/gitAtoms";
import type { GitBranchList } from "@poseidon/contracts/git";
import type { GitDiff, GitStatus } from "@poseidon/contracts/rpc";
import type { DiffViewSettings } from "@poseidon/contracts/settings";
import { Button } from "@poseidon/ui/components/button";
import { AsyncResult } from "effect/unstable/reactivity";

import { PaneMessage } from "@/components/panes/files/pane-message";
import type { DiffStyle } from "@/state/ui";

import { useGitAtoms } from "./git-atoms";
import { ReviewList } from "./review-list";
import {
  AlertTriangle,
  GitBranch,
  GitDiff as GitDiffIcon,
  Repeat,
  Spinner,
  WifiOff,
} from "@honeyicons/react";

/**
 * What the pane renders from one git atom.
 *
 * `GitQuery` covers the RPC's own outcomes, which the atom turns into values so
 * a bad ref does not kill the stream. `broken` is the case above that: the
 * atom's error channel, which is inhabited by defects the stream cannot catch
 * (a client that dies on every `git.*` call, for one). There is no value to
 * show and no reconnect will produce one, so it has to read as an error with a
 * retry rather than as a load that never finishes.
 */
export type PaneQuery<A> = GitQuery<A> | { readonly _tag: "broken" };

const BROKEN = { _tag: "broken" } as const;

/** The state of a git atom, or `null` while it has not answered yet. */
export const queryValue = <A,>(
  result: AsyncResult.AsyncResult<GitQuery<A>, unknown>,
): PaneQuery<A> | null =>
  AsyncResult.isSuccess(result) ? result.value : AsyncResult.isFailure(result) ? BROKEN : null;

/** The files of one comparison, read from its own `git.diff` atom. */
export function ChangesList({
  threadId,
  range,
  status,
  connected,
  diffStyle,
  diffView,
  reveal,
  onRevealed,
  onRetry,
}: {
  /** Whose review this is, and whose draft "Add to chat" writes into. */
  threadId: string;
  range: GitDiffRange;
  status: PaneQuery<GitStatus> | null;
  connected: boolean;
  diffStyle: DiffStyle;
  diffView: DiffViewSettings;
  /** A file a link asked to open and scroll to once the files are in, or `null`. */
  reveal: string | null;
  onRevealed: () => void;
  onRetry: () => void;
}) {
  const { gitDiffAtom } = useGitAtoms();
  const diff = queryValue<GitDiff>(useAtomValue(gitDiffAtom(range)));

  const retry = (
    <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
      <Repeat variant="bold" />
      Try again
    </Button>
  );

  if (diff === null) {
    return connected ? (
      <PaneMessage icon={Spinner} text="Loading changes…" />
    ) : (
      <PaneMessage icon={WifiOff} text="Not connected to the server." />
    );
  }
  if (diff._tag === "error") {
    return <PaneMessage icon={AlertTriangle} text={diff.message} action={retry} />;
  }
  if (diff._tag === "broken") {
    return (
      <PaneMessage
        icon={AlertTriangle}
        text="Could not read the changes for this comparison."
        action={retry}
      />
    );
  }
  if (status?._tag === "ok" && isRepoless(status.value)) {
    return <NotARepository />;
  }
  if (diff.value.files.length === 0) {
    return <PaneMessage icon={GitDiffIcon} text="No changes in this comparison." />;
  }
  return (
    <ReviewList
      threadId={threadId}
      files={diff.value.files}
      prefix={diff.value.prefix ?? ""}
      diffStyle={diffStyle}
      diffView={diffView}
      reveal={reveal}
      onRevealed={onRevealed}
    />
  );
}

/**
 * Under the pane's toolbar: the comparison's files, or — with no `range` —
 * why there is nothing to compare: not a repository, the branches still
 * loading, or no base branch for "Branch".
 */
export function ComparisonBody({
  range,
  branchList,
  mergeBase,
  ...list
}: Omit<React.ComponentProps<typeof ChangesList>, "range"> & {
  range: GitDiffRange | null;
  branchList: GitBranchList | null;
  /** What "Branch" compares with; `undefined` while the branches load. */
  mergeBase: string | null | undefined;
}) {
  if (range !== null) {
    return <ChangesList range={range} {...list} />;
  }
  if (branchList?.isRepository === false) {
    return <NotARepository />;
  }
  if (mergeBase === undefined) {
    return list.connected ? (
      <PaneMessage icon={Spinner} text="Loading branches…" />
    ) : (
      <PaneMessage icon={WifiOff} text="Not connected to the server." />
    );
  }
  return <PaneMessage icon={GitBranch} text="No base branch to compare with" />;
}

function NotARepository() {
  return (
    <PaneMessage
      icon={GitDiffIcon}
      text="This workspace is not a git repository, so there is nothing to compare."
    />
  );
}
