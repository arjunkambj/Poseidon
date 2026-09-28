/**
 * The dock's Changes tab — the M4 surface over `git.status` and `git.diff`.
 *
 * The toolbar's Compare menu picks what to compare (`selection.ts`): what one
 * turn changed, the branch against its base, or the uncommitted working tree. `ChangesList` renders that comparison's files.
 * Every read runs in the thread's own root — its worktree, when it has one —
 * and the file menus open and copy paths in that root (`FileMenuScopeProvider`).
 *
 * `git.status` is read alongside it because the server answers a missing
 * project or a non-repository root with an empty status rather than an error,
 * and that is how "this is not a git repo" differs from "nothing changed". The
 * branch itself is the thread header's, so the pane does not repeat it.
 *
 * Restore lives behind `RestoreCheckpointButton` and its dialog, only while a
 * turn is shown — it puts the worktree back to how that turn left it — and is
 * disabled while a turn is running — the server rejects it anyway, but a
 * disabled button with a reason beats a rejection after the fact.
 *
 * Discard and blame act in the comparison on screen (`ReviewScopeProvider`):
 * a file goes back to that comparison's base, and Discard is disabled with a
 * reason offline or while a turn or a restore runs, as Restore is.
 *
 * Refresh — the button, a landed restore and a finished turn
 * (`use-changes-refresh.ts`) — rereads every git read of the project, so the
 * header's branch picker and git actions follow along with the pane.
 *
 * A link from the timeline (`./deep-link`) arrives as the route's `turn` and
 * `file` search params. The pane reads them itself, so the dock needs to know
 * nothing about them: it picks that turn, hands the file to the list to open
 * and scroll to once, and clears both params straight away.
 */

import * as React from "react";

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ThreadDetailView } from "@poseidon/client-runtime/clientState";
import type { GitBranchList } from "@poseidon/contracts/git";
import type { CheckpointSummary } from "@poseidon/contracts/orchestration";
import type { GitStatus } from "@poseidon/contracts/rpc";

import { FileMenuScopeProvider } from "@/components/open-in/file-menu-scope";
import { useKeybindingFlag } from "@/lib/shortcuts";
import { useDiffView } from "@/lib/use-diff-view";
import { turnInFlight } from "@/lib/turn";
import { useConnectionState } from "@/state/hooks";
import { useChangesScope, useDiffStyle } from "@/state/ui";

import { BaseLine, RestoreProgress } from "./changes-header";
import { ComparisonBody, queryValue } from "./changes-list";
import { linkedTurnChoice } from "./deep-link";
import { discardBlockedReason, reviewScopeFields } from "./discard";
import { useGitAtoms } from "./git-atoms";
import { RestoreCheckpointButton } from "./restore-dialog";
import { ReviewScopeProvider, type ReviewScope } from "./review-scope";
import { BRANCH, ScopeBar, UNCOMMITTED } from "./scope-bar";
import {
  branchBaseFor,
  checkpointLabel,
  diffRangeFor,
  pickTurn,
  turnRange,
  type ChangesSelection,
} from "./selection";
import { useChangesRefresh } from "./use-changes-refresh";

export function ChangesPane({ snapshot }: { snapshot: ThreadDetailView }) {
  const atoms = useGitAtoms();
  const registry = React.useContext(RegistryContext);
  const connection = useConnectionState();
  const connected = connection.status === "connected";
  const checkpoints = snapshot.checkpoints;
  const [changesScope, setChangesScope] = useChangesScope();
  const [diffStyle, setDiffStyle] = useDiffStyle();
  const [diffView, setDiffView] = useDiffView();
  // Mounted only while the dock shows this tab, so the file keys
  // (`changes.nextFile` / `previousFile`) are live exactly as long.
  useKeybindingFlag("changesOpen", true);

  // `null` follows the latest turn, so a finished turn takes the pane with it.
  const [turnChoice, setTurnChoice] = React.useState<string | null>(null);
  const turnIndex = pickTurn(checkpoints, turnChoice);
  const turn: CheckpointSummary | null = checkpoints[turnIndex] ?? null;
  const turnLabel = turn === null ? null : checkpointLabel(turn, turnIndex);

  // A link into the pane: act on it once, then drop it from the address so a
  // reload or a back step does not scroll again. The file waits in `reveal`
  // until the list for the linked turn has answered.
  const threadId = snapshot.threadId;
  const { turn: linkedTurn, file: linkedFile } = useSearch({ strict: false });
  const navigate = useNavigate();
  const [reveal, setReveal] = React.useState<string | null>(null);
  const onRevealed = React.useCallback(() => setReveal(null), []);
  React.useEffect(() => {
    if (linkedTurn === undefined && linkedFile === undefined) {
      return;
    }
    if (linkedTurn !== undefined) {
      setChangesScope("turn");
      setTurnChoice(linkedTurnChoice(checkpoints, linkedTurn));
    }
    setReveal(linkedFile ?? null);
    void navigate({
      to: "/t/$threadId",
      params: { threadId },
      search: (previous) => ({ ...previous, turn: undefined, file: undefined }),
      replace: true,
    });
  }, [linkedTurn, linkedFile, checkpoints, navigate, threadId, setChangesScope]);
  // A thread with no checkpoints yet has no turn to show; the working tree is
  // the nearest thing to one.
  const shownScope = changesScope === "turn" && turn === null ? "uncommitted" : changesScope;

  const projectId = snapshot.projectId;
  const scope = { projectId, threadId: snapshot.threadId };
  const status = queryValue<GitStatus>(useAtomValue(atoms.gitStatusAtom(scope)));
  const branches = queryValue<GitBranchList>(useAtomValue(atoms.gitBranchesAtom(scope)));
  const branchList = branches?._tag === "ok" ? branches.value : null;

  // "Branch vs base" waits for the branch list only when the thread did not
  // record its own base; a list that failed leaves nothing to compare with.
  const mergeBase = branchBaseFor(
    snapshot.worktree?.baseBranch,
    branches === null ? undefined : (branchList?.defaultBranch ?? null),
  );
  const selection: ChangesSelection =
    shownScope === "turn" && turn !== null
      ? { scope: "turn", ...turnRange(checkpoints[turnIndex - 1], turn) }
      : shownScope === "branch"
        ? { scope: "branch", mergeBase: mergeBase ?? null }
        : { scope: "uncommitted" };
  const range = diffRangeFor(scope, selection, diffView.ignoreWhitespace);

  const refresh = React.useCallback(
    () => atoms.refreshProject(registry, projectId),
    [atoms, registry, projectId],
  );
  const onRestoreAccepted = useChangesRefresh(snapshot, refresh);

  const turns = checkpoints
    .map((checkpoint, index) => ({
      value: checkpoint.ref,
      label: checkpointLabel(checkpoint, index),
    }))
    .reverse();
  const compareValue = shownScope === "turn" && turn !== null ? turn.ref : shownScope;
  const onCompareChange = (next: string) => {
    if (next === UNCOMMITTED.value || next === BRANCH.value) {
      setChangesScope(next);
      return;
    }
    setChangesScope("turn");
    // Picking the latest turn keeps following it; an older one stays put.
    setTurnChoice(next === checkpoints.at(-1)?.ref ? null : next);
  };

  // Offline the dispatch never resolves (the offline layer's client is
  // `Effect.never`), so the button would sit on "Restoring…" forever. Say why
  // instead.
  // `restoring` comes off the snapshot and is kept current between snapshots by
  // the client fold, so it survives a reload while git is still working. The
  // failure line is the fold's alone: the reason git gave is carried by the
  // `restore.failed` event and by nothing durable.
  const restoring = snapshot.restoring ?? null;
  const restoreFailure = snapshot.restoreFailure ?? null;

  const restoreDisabledReason = !connected
    ? "Not connected to the server."
    : restoring !== null
      ? "A restore is already running."
      : turn === null
        ? "This thread has no checkpoints yet."
        : // `turnInFlight`, not `currentTurnId`: the server rejects on its
          // own `currentTurn`, which it sets on `thread.turn.requested`,
          // while the client only fills the id on `thread.turn.started`.
          // Between the two the button would be live and the dispatch
          // would come back rejected.
          turnInFlight(snapshot)
          ? "A turn is running — stop it before restoring."
          : null;

  const scopeFields = reviewScopeFields(selection, `Turn ${turnIndex + 1}`);
  const reviewScope: ReviewScope = {
    projectId,
    threadId,
    ...scopeFields,
    discardDisabledReason: discardBlockedReason({
      connected,
      restoring: restoring !== null,
      turnRunning: turnInFlight(snapshot),
    }),
  };

  const body = (
    <ComparisonBody
      threadId={threadId}
      range={range}
      branchList={branchList}
      mergeBase={mergeBase}
      status={status}
      connected={connected}
      diffStyle={diffStyle}
      diffView={diffView}
      reveal={reveal}
      onRevealed={onRevealed}
      onRetry={refresh}
    />
  );

  // `h-full` so the diffs scroll inside the pane and the toolbar stays put;
  // the dock's own scroller then never has anything to scroll.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScopeBar
        value={compareValue}
        onValueChange={onCompareChange}
        turns={turns}
        range={
          shownScope === "branch" && range?.mergeBase !== undefined ? (
            <BaseLine base={range.mergeBase} current={branchList?.current ?? null} />
          ) : null
        }
        restore={
          shownScope === "turn" ? (
            <RestoreCheckpointButton
              threadId={snapshot.threadId}
              checkpoint={turn}
              label={turnLabel ?? "this turn"}
              disabledReason={restoreDisabledReason}
              onAccepted={onRestoreAccepted}
            />
          ) : null
        }
        diffStyle={diffStyle}
        onDiffStyleChange={setDiffStyle}
        diffView={diffView}
        onDiffViewChange={setDiffView}
        onRefresh={refresh}
      />
      {/* Only while a restore runs or after git refused one — never at rest. */}
      {restoring !== null || restoreFailure !== null ? (
        <div className="shrink-0 px-3 pb-2">
          <RestoreProgress restoring={restoring} failure={restoreFailure} />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <FileMenuScopeProvider projectId={projectId} threadId={threadId}>
          <ReviewScopeProvider value={reviewScope}>{body}</ReviewScopeProvider>
        </FileMenuScopeProvider>
      </div>
    </div>
  );
}
