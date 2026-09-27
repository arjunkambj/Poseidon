/**
 * The git actions in the thread header — and in the New task page's header,
 * before any thread exists: a single Commit button. It opens the commit
 * dialog, which offers Commit, Commit & push, and Commit & create PR as
 * buttons.
 *
 * With a thread (`snapshot`) it works in the thread's workspace — its
 * worktree, when it has one. Without one it works in the project's own
 * folder: the git calls carry the `projectId` alone, and the commit message
 * and pull request title are drafted from the files and the branch rather
 * than a thread title.
 *
 * An action is planned from the workspace's status and branches
 * (`@/lib/git-actions`): any action that commits opens the commit dialog
 * first, with the one asked for filled in, and a pull request made in the
 * same run takes its title and body from the drafted commit message. With
 * nothing to commit, a push (from its key) runs straight away and a pull
 * request asks only for its title and body. The steps then run in
 * order with one toast each, and stop at the first refusal with the server's
 * message (`./use-git-actions`).
 *
 * The whole control is disabled while the thread's turn runs, and each
 * action that cannot run says why — in the button's tooltip, or in the
 * dialog's. On the New task page there is no thread, so it is disabled, with
 * the same reason, while a local thread of the project runs a turn in its
 * folder (`projectFolderTurnRunning`). The thread list cannot see a turn
 * paused on the user; the server refuses a commit under that one itself.
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
 * It answers `git.commit` (Mod+Alt+C) as the Commit button and `git.push`
 * (Mod+Alt+P) as the dialog's Commit & push, which pushes straight away when there is
 * nothing to commit; an action that cannot run does nothing from its key.
 */

import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { GitQuery } from "@poseidon/client-runtime/gitAtoms";
import type { GitBranchList } from "@poseidon/contracts/git";
import type { ProjectId } from "@poseidon/contracts/ids";
import type { ThreadDetailSnapshot } from "@poseidon/contracts/orchestration";
import type { GitStatus } from "@poseidon/contracts/rpc";

import { useGitAtoms } from "@/components/panes/changes/git-atoms";
import { useKeybindingCommand } from "@/lib/shortcuts";
import {
  availableActions,
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
import { Git, Spinner } from "@honeyicons/react";

import { CommitDialog, type CommitChoice } from "./commit-dialog";
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
  const { gitStatusAtom, gitBranchesAtom, refreshProject } = useGitAtoms();
  const registry = React.useContext(RegistryContext);
  const connected = useConnectionState().status === "connected";
  const scope = snapshot === undefined ? { projectId } : { projectId, threadId: snapshot.threadId };
  const statusAtom = gitStatusAtom(scope);
  const status = readOf<GitStatus>(useAtomValue(statusAtom), connected);
  const branches = readOf<GitBranchList>(useAtomValue(gitBranchesAtom(scope)), connected);
  const refreshStatus = useAtomRefresh(statusAtom);
  const { run } = useGitActions(scope, status._tag === "ok" ? status.value.branch : null);

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
  const availability = ready === null ? null : availableActions({ ...ready, turnRunning });
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
    if (ready === null || reasonFor(action) !== null) {
      return;
    }
    const steps = planGitAction(action, ready.status, ready.branches);
    if (steps.includes("commit")) {
      refreshStatus();
      setDialog({ kind: "commit", action, key: (dialog?.key ?? 0) + 1 });
      setDialogOpen(true);
    } else if (steps.includes("pr")) {
      setDialog({ kind: "pull-request", action, key: (dialog?.key ?? 0) + 1 });
      setDialogOpen(true);
    } else {
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

  const disabled = blocked !== null || pending;
  const commitReason = reasonFor("commit");
  const files = ready?.status.files ?? [];
  const branch = ready?.status.branch ?? null;

  return (
    <div className="inline-flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || commitReason !== null}
            onClick={() => start("commit")}
            aria-label="Commit"
          >
            {pending ? <Spinner variant="bold" /> : <Git variant="bold" />}
            {/* A narrow header keeps the branch name over this label. */}
            <span className="hidden @lg/header:inline">Commit</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{commitReason ?? "Commit the changes in this workspace"}</TooltipContent>
      </Tooltip>

      {dialog?.kind === "commit" ? (
        <CommitDialog
          key={dialog.key}
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
