/**
 * The Changes tab of the New task page's dock: the project's own folder, over
 * `git.status` and `git.diff` with the `projectId` alone, since no thread
 * exists yet.
 *
 * It compares what a thread's pane compares when it has no turn to show: the
 * uncommitted working tree against `HEAD`, or the branch against the
 * repository's default branch. There are no turns, so no checkpoints and no
 * Restore; a remembered "turn" scope reads as Uncommitted here, and the
 * Compare menu lists no turns.
 *
 * The files, the review over them (which are open, which are viewed) and
 * "Add to chat" are the thread pane's own (`ComparisonBody`), keyed by the
 * page's draft (`draftId`) — so "Add to chat" writes into the draft on screen,
 * and the review carries over to the thread that draft becomes. The draft is
 * not a thread, so the file menus get none: they open paths in the project's
 * folder and offer no "Open in Files tab".
 *
 * Discard and blame act in the project's folder (`ReviewScopeProvider`), and
 * Discard is disabled offline or while a thread of the project runs a turn in
 * that folder (`projectFolderTurnRunning`).
 *
 * Refresh rereads every git read of the project, so the header's git actions
 * follow along; they refetch on a return to the window too, which reaches this
 * pane the same way.
 */

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { GitBranchList } from "@poseidon/contracts/git";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { GitStatus } from "@poseidon/contracts/rpc";
import * as React from "react";

import { FileMenuScopeProvider } from "@/components/open-in/file-menu-scope";
import { useKeybindingFlag } from "@/lib/shortcuts";
import { useDiffView } from "@/lib/use-diff-view";
import { projectFolderTurnRunning } from "@/lib/turn";
import { useConnectionState, useThreadList } from "@/state/hooks";
import { useChangesScope, useDiffStyle } from "@/state/ui";

import { BaseLine } from "./changes-header";
import { ComparisonBody, queryValue } from "./changes-list";
import { discardBlockedReason, reviewScopeFields } from "./discard";
import { useGitAtoms } from "./git-atoms";
import { ReviewScopeProvider, type ReviewScope } from "./review-scope";
import { BRANCH, ScopeBar, UNCOMMITTED } from "./scope-bar";
import { branchBaseFor, diffRangeFor, type ChangesSelection } from "./selection";

const noReveal = () => {};

export function ProjectChangesPane({
  projectId,
  draftId,
}: {
  projectId: ProjectId;
  /** The New task page's draft: "Add to chat" writes into it. */
  draftId: ThreadId;
}) {
  const atoms = useGitAtoms();
  const registry = React.useContext(RegistryContext);
  const connected = useConnectionState().status === "connected";
  const [changesScope, setChangesScope] = useChangesScope();
  const [diffStyle, setDiffStyle] = useDiffStyle();
  const [diffView, setDiffView] = useDiffView();
  // Mounted only while the dock shows this tab, so the file keys
  // (`changes.nextFile` / `previousFile`) are live exactly as long.
  useKeybindingFlag("changesOpen", true);

  // No thread, so no turns: the working tree is the nearest thing to one.
  const shownScope = changesScope === "branch" ? "branch" : "uncommitted";

  const scope = { projectId };
  const status = queryValue<GitStatus>(useAtomValue(atoms.gitStatusAtom(scope)));
  const branches = queryValue<GitBranchList>(useAtomValue(atoms.gitBranchesAtom(scope)));
  const branchList = branches?._tag === "ok" ? branches.value : null;
  const mergeBase = branchBaseFor(
    undefined,
    branches === null ? undefined : (branchList?.defaultBranch ?? null),
  );
  const selection: ChangesSelection =
    shownScope === "branch"
      ? { scope: "branch", mergeBase: mergeBase ?? null }
      : { scope: "uncommitted" };
  const range = diffRangeFor(scope, selection, diffView.ignoreWhitespace);

  const threads = useThreadList();
  const reviewScope: ReviewScope = {
    projectId,
    ...reviewScopeFields(selection, ""),
    discardDisabledReason: discardBlockedReason({
      connected,
      restoring: false,
      turnRunning: projectFolderTurnRunning(threads, projectId),
    }),
  };

  const refresh = React.useCallback(
    () => atoms.refreshProject(registry, projectId),
    [atoms, registry, projectId],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScopeBar
        value={shownScope}
        onValueChange={(next) => {
          if (next === UNCOMMITTED.value || next === BRANCH.value) {
            setChangesScope(next);
          }
        }}
        turns={[]}
        range={
          shownScope === "branch" && range?.mergeBase !== undefined ? (
            <BaseLine base={range.mergeBase} current={branchList?.current ?? null} />
          ) : null
        }
        restore={null}
        diffStyle={diffStyle}
        onDiffStyleChange={setDiffStyle}
        diffView={diffView}
        onDiffViewChange={setDiffView}
        onRefresh={refresh}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* No thread yet: the file menus open paths in the project's folder. */}
        <FileMenuScopeProvider projectId={projectId} threadId={null}>
          <ReviewScopeProvider value={reviewScope}>
            <ComparisonBody
              threadId={draftId}
              range={range}
              branchList={branchList}
              mergeBase={mergeBase}
              status={status}
              connected={connected}
              diffStyle={diffStyle}
              diffView={diffView}
              reveal={null}
              onRevealed={noReveal}
              onRetry={refresh}
            />
          </ReviewScopeProvider>
        </FileMenuScopeProvider>
      </div>
    </div>
  );
}
