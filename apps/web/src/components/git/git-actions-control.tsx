/**
 * The git actions in the thread header — and in the New task page's header,
 * before any thread exists: a primary button that follows the branch's state
 * and a menu with every action (`./git-primary-button`). The button offers
 * the next step (`@/lib/git-next-step`): Commit while anything changed, Push
 * while commits are unpushed or the branch has no upstream, Create PR for a
 * pushed feature branch, and View PR once a pull request for the branch is
 * remembered (`usePullRequestLink`), which opens it. A badge shows the
 * changed-file count or the commits ahead. The menu offers Commit, Commit &
 * push and Commit & create PR, each with its reason when it cannot run —
 * for a pull request, also when `gh` is missing or signed out, as
 * `git.pullRequest.readiness` answers (refetched with the rest of the git
 * reads, so signing in from a terminal enables it on return).
 *
 * With a thread (`snapshot`) it works in the thread's workspace — its
 * worktree, when it has one. Without one it works in the project's own
 * folder: the git calls carry the `projectId` alone, and the commit message
 * and pull request title are drafted from the files and the branch rather
 * than a thread title.
 *
 * An action is planned from the workspace's status and branches
 * (`@/lib/git-actions`): any action that commits opens the commit dialog
 * first — the message and the files to commit, with the one asked for filled
 * in — and a pull request made in the same run takes its title and body from
 * the commit message. With nothing to commit, a push (from its key) runs
 * straight away and a pull request asks only for its title and body. The
 * steps then run in order with one toast each, and stop at the first refusal
 * with the server's message (`./use-git-actions`).
 *
 * Every action is disabled while the thread's turn runs — View PR, which runs
 * nothing, stays — and each action that cannot run says why: in the button's
 * tooltip, the menu item, or the dialog. On the New task page there is no
 * thread, so it is disabled, with the same reason, while a local thread of
 * the project runs a turn in its folder (`projectFolderTurnRunning`). The
 * thread list cannot see a turn paused on the user; the server refuses a
 * commit under that one itself.
 *
 * The status is refetched when that turn finishes, because the agent changes
 * files, and when the user comes back to the window, because an
 * editor or a terminal changes them too — without that, a
 * Commit disabled as "No changes to commit" would stay so after an outside
 * edit, with no click of its own to refresh it. When the status cannot be
 * read (offline, or a client that serves no git) the control is disabled
 * with the reason instead of failing the header. Outside a repository it
 * renders nothing.
 *
 * It answers `git.commit` (Mod+Alt+C) as the menu's Commit and `git.push`
 * (Mod+Alt+P) as its Commit & push, which pushes straight away when there is
 * nothing to commit; an action that cannot run does nothing from its key, and
 * neither does either key while a dialog is up (`gitStartOf`), so it cannot
 * reopen the commit dialog over the message and files the user picked.
 */

import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import type { GitQuery } from "@poseidon/client-runtime/gitAtoms";
import type { GitBranchList, GitPullRequestReadiness } from "@poseidon/contracts/git";
import type { ProjectId } from "@poseidon/contracts/ids";
import type { ThreadDetailSnapshot } from "@poseidon/contracts/orchestration";
import type { GitStatus } from "@poseidon/contracts/rpc";

import { useGitAtoms } from "@/components/panes/changes/git-atoms";
import { openExternal } from "@/lib/desktop";
import { nextGitStep, nextGitStepHint, type GitNextStepView } from "@/lib/git-next-step";
import { useKeybindingCommand } from "@/lib/shortcuts";
import {
  availableActions,
  gitStartOf,
  planGitAction,
  planWithoutCommit,
  pullRequestFromMessage,
  pullRequestTitleDraft,
  pushTargetOf,
  stepsLabel,
  TURN_RUNNING_REASON,
  type GitAction,
} from "@/lib/git-actions";
import { projectFolderTurnRunning, turnInFlight } from "@/lib/turn";
import { useWindowReturn } from "@/lib/window-return";
import { useConnectionState, useThreadList } from "@/state/hooks";

import { CommitDialog } from "./commit-dialog";
import type { CommitChoice } from "./commit-picker";
import { GitPrimaryButton } from "./git-primary-button";
import { PullRequestDialog } from "./pull-request-dialog";
import { useGitActions, type GitRunInput } from "./use-git-actions";

/** A git read as the control needs it: a value, still loading, or why it cannot be had. */
type Read<A> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "unavailable"; readonly reason: string };

const readOf = <A,>(
  result: AsyncResult.AsyncResult<GitQuery<A>, unknown>,
  connected: boolean,
): Read<A> => {
  if (AsyncResult.isFailure(result)) {
    return { _tag: "unavailable", reason: "Could not read this workspace's git status." };
  }
  if (!AsyncResult.isSuccess(result)) {
    return connected
      ? { _tag: "loading" }
      : { _tag: "unavailable", reason: "Not connected to the server." };
  }
  return result.value._tag === "ok"
    ? { _tag: "ok", value: result.value.value }
    : { _tag: "unavailable", reason: result.value.message };
};

const actionRecord = <A,>(of: (action: GitAction) => A): Record<GitAction, A> => ({
  commit: of("commit"),
  "commit-push": of("commit-push"),
  "commit-push-pr": of("commit-push-pr"),
});

/** Which dialog is up. `key` remounts it per opening, so each opening starts from a fresh draft. */
type OpenDialog =
  | { readonly kind: "commit"; readonly action: GitAction; readonly key: number }
  | { readonly kind: "pull-request"; readonly action: GitAction; readonly key: number };

export function GitActionsControl({
  projectId,
  snapshot,
}: {
  projectId: ProjectId;
  /** The thread whose workspace this acts on; absent, the project's own folder. */
  snapshot?: ThreadDetailSnapshot | undefined;
}) {
  const { gitStatusAtom, gitBranchesAtom, gitPullRequestReadinessAtom, refreshProject } =
    useGitAtoms();
  const registry = React.useContext(RegistryContext);
  const connected = useConnectionState().status === "connected";
  const scope = snapshot === undefined ? { projectId } : { projectId, threadId: snapshot.threadId };
  const statusAtom = gitStatusAtom(scope);
  const status = readOf<GitStatus>(useAtomValue(statusAtom), connected);
  const branches = readOf<GitBranchList>(useAtomValue(gitBranchesAtom(scope)), connected);
  const readiness = readOf<GitPullRequestReadiness>(
    useAtomValue(gitPullRequestReadinessAtom(scope)),
    connected,
  );
  // Not known yet (or an older server): offered, and the server says why not.
  const pullRequestBlocker = readiness._tag === "ok" ? readiness.value.reason : null;
  const refreshStatus = useAtomRefresh(statusAtom);
  const { run, pullRequestUrl } = useGitActions(
    scope,
    status._tag === "ok" ? status.value.branch : null,
  );

  const [dialog, setDialog] = React.useState<OpenDialog | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  // With no thread, the project's local threads are the ones that can be
  // working in its folder.
  const threads = useThreadList();
  const turnRunning =
    snapshot === undefined ? projectFolderTurnRunning(threads, projectId) : turnInFlight(snapshot);

  // The agent changes files; its turn is over when `currentTurnId` falls back
  // to null — or, with no thread, when no local thread runs one any more.
  const currentTurnId =
    snapshot === undefined ? (turnRunning ? "folder" : null) : snapshot.currentTurnId;
  const lastTurnId = React.useRef(currentTurnId);
  React.useEffect(() => {
    const previous = lastTurnId.current;
    lastTurnId.current = currentTurnId;
    if (previous !== null && currentTurnId === null) {
      refreshStatus();
    }
  }, [currentTurnId, refreshStatus]);
  useWindowReturn(() => refreshProject(registry, projectId));

  // `git.commit` and `git.push` do what the button and the dialog's Commit &
  // push do. The hooks run before the early return below; `start` is assigned
  // further down in the same render, and stays unset outside a repository.
  let start: ((action: GitAction) => void) | undefined;
  useKeybindingCommand("git.commit", () => start?.("commit"));
  useKeybindingCommand("git.push", () => start?.("commit-push"));

  if (
    (status._tag === "ok" && status.value.isRepository === false) ||
    (branches._tag === "ok" && !branches.value.isRepository)
  ) {
    return null;
  }

  const ready =
    status._tag === "ok" && branches._tag === "ok"
      ? { status: status.value, branches: branches.value }
      : null;
  const blocked =
    status._tag === "unavailable"
      ? status.reason
      : branches._tag === "unavailable"
        ? branches.reason
        : ready === null
          ? "Reading the git status…"
          : turnRunning
            ? TURN_RUNNING_REASON
            : null;
  const availability =
    ready === null ? null : availableActions({ ...ready, turnRunning, pullRequestBlocker });
  const reasonFor = (action: GitAction): string | null => blocked ?? availability?.[action] ?? null;

  /** Plans from the status as it is now, not as it was when the dialog opened. */
  const execute = async (action: GitAction, input: GitRunInput) => {
    if (ready === null) {
      return;
    }
    setPending(true);
    try {
      await run(
        input.commit === undefined
          ? planWithoutCommit(action, ready.status, ready.branches)
          : planGitAction(action, ready.status, ready.branches),
        input,
        pushTargetOf(ready.status, ready.branches),
      );
    } finally {
      setPending(false);
    }
  };

  start = (action: GitAction) => {
    if (ready === null) {
      return;
    }
    const started = gitStartOf({ action, ...ready, reason: reasonFor(action), dialogOpen });
    if (started === "commit-dialog") {
      refreshStatus();
      setDialog({ kind: "commit", action, key: (dialog?.key ?? 0) + 1 });
      setDialogOpen(true);
    } else if (started === "pull-request-dialog") {
      setDialog({ kind: "pull-request", action, key: (dialog?.key ?? 0) + 1 });
      setDialogOpen(true);
    } else if (started === "run") {
      void execute(action, {});
    }
  };

  const commitChosen = (action: GitAction, choice: CommitChoice) =>
    void execute(action, {
      commit: choice,
      ...(action === "commit-push-pr"
        ? { pullRequest: pullRequestFromMessage(choice.message) }
        : {}),
    });

  const files = ready?.status.files ?? [];
  const branch = ready?.status.branch ?? null;
  // Before the status is read the button offers Commit, disabled with why.
  const next: GitNextStepView =
    ready === null
      ? { step: "commit", action: "commit", label: "Commit", badge: null, reason: blocked }
      : nextGitStep({ ...ready, turnRunning, pullRequestUrl, pullRequestBlocker });

  return (
    <div className="inline-flex shrink-0 items-center gap-0.5">
      <GitPrimaryButton
        next={next}
        hint={ready === null ? "" : nextGitStepHint(next.step, ready.status, ready.branches)}
        pending={pending}
        pullRequestUrl={pullRequestUrl}
        reasons={actionRecord(reasonFor)}
        onStart={(action) => start?.(action)}
        onOpen={openExternal}
        onMenuOpen={refreshStatus}
      />

      {dialog?.kind === "commit" ? (
        <CommitDialog
          key={dialog.key}
          scope={scope}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          initialAction={dialog.action}
          reasons={actionRecord(reasonFor)}
          threadTitle={snapshot?.title ?? ""}
          branch={branch}
          files={files}
          onSubmit={commitChosen}
        />
      ) : null}
      {dialog?.kind === "pull-request" ? (
        <PullRequestDialog
          key={dialog.key}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          actionLabel={
            (ready === null
              ? null
              : stepsLabel(planWithoutCommit(dialog.action, ready.status, ready.branches))) ??
            "Create PR"
          }
          initialTitle={pullRequestTitleDraft(snapshot?.title ?? "", branch)}
          branch={branch}
          onSubmit={(pullRequest) => void execute(dialog.action, { pullRequest })}
        />
      ) : null}
    </div>
  );
}
