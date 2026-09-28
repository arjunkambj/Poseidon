/**
 * Starting a Fix menu thread: a new thread on the same branch as the one the
 * Pull request tab belongs to, whose first message is the fix's prompt
 * (`buildFixPrompt`).
 *
 * In order, once the person confirmed:
 *
 * 1. For failing checks or conflicts, read `git.pullRequest.fixContext` — the
 *    log tails or the conflicting files. A refusal (the pull request changed,
 *    gh signed out) stops here with the server's words.
 * 2. Create the thread through `useCreateThread` with an id minted here, so
 *    the "reuse a blank newest thread" rule never swaps in another thread. A
 *    source thread in a worktree gives the new one the same worktree; a local
 *    one gives a local thread, in the project's folder on the same branch. The
 *    source's settings (model, effort, modes, connector) are copied.
 * 3. Reread the project's pull request marks, skipping their throttle, so
 *    the new thread carries the pull request's glyph and tab at once.
 * 4. Send the prompt as its first turn the way `use-compact-now.ts` does
 *    (`noteLocalSend`, then `thread.turn.start`), and open the thread.
 *
 * One pending toast covers the whole run and turns into the outcome in place;
 * a rejected create is `useCreateThread`'s own toast.
 */

import { RegistryContext } from "@effect/atom-react";
import type { ThreadWorktree } from "@poseidon/contracts/git";
import {
  makeCommandId,
  makeThreadId,
  type ProjectId,
  type ThreadId,
} from "@poseidon/contracts/ids";
import type {
  CommandReceipt,
  ThreadSettings,
  ThreadSettingsPatch,
} from "@poseidon/contracts/orchestration";
import type { PullRequestDetail, PullRequestFixContext } from "@poseidon/contracts/pullRequest";
import { useNavigate } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import * as React from "react";
import { toast } from "sonner";

import { describeExitError } from "@/lib/app-runtime";
import { isAccepted, rejectionMessage, type DispatchExit } from "@/lib/dispatch-outcome";
import { useCreateThread } from "@/lib/use-create-thread";
import { useDispatchCommand, useThreadList } from "@/state/hooks";
import { noteLocalSend } from "@/state/local-sends";

import { buildFixPrompt, FIX_LABELS, fixNeedsContext, type FixKind } from "./pr-fix-prompt";
import { usePullRequestAtoms } from "./pull-request-atoms";

/** The source thread's settings as a create's patch: every field it has set. */
export const settingsPatch = (settings: ThreadSettings): ThreadSettingsPatch => ({
  model: settings.model,
  runtimeMode: settings.runtimeMode,
  interactionMode: settings.interactionMode,
  ...(settings.effort === undefined ? {} : { effort: settings.effort }),
  ...(settings.connectorInstanceId === undefined
    ? {}
    : { connectorInstanceId: settings.connectorInstanceId }),
});

/** Where the new thread works, as the confirm names it. */
export const fixTarget = (worktree: ThreadWorktree | undefined): string =>
  worktree === undefined ? "the project's folder" : `the worktree at ${worktree.path}`;

export interface FixThreadDeps {
  readonly fixContext: (
    kind: "checks" | "conflicts",
  ) => Promise<
    | { readonly ok: true; readonly value: PullRequestFixContext }
    | { readonly ok: false; readonly message: string }
  >;
  readonly create: (
    threadId: ThreadId,
    options: { readonly settings?: ThreadSettingsPatch; readonly worktree?: ThreadWorktree },
  ) => Promise<boolean>;
  readonly send: (threadId: ThreadId, text: string) => Promise<DispatchExit>;
  /** The new thread joined the branch: relist the project's marks now. */
  readonly refreshMarks: () => void;
  readonly open: (threadId: ThreadId) => void;
  readonly newThreadId: () => ThreadId;
  readonly toast: {
    readonly loading: (message: string, options: { readonly id: string }) => unknown;
    readonly success: (message: string, options: { readonly id: string }) => unknown;
    readonly error: (message: string, options: { readonly id: string }) => unknown;
    readonly dismiss: (id: string) => unknown;
  };
}

export interface FixSource {
  readonly settings?: ThreadSettings;
  readonly worktree?: ThreadWorktree;
}

let runs = 0;

/** The whole run for one confirmed fix; resolves with the new thread's id, or `null`. */
export const runFixThread = async (
  deps: FixThreadDeps,
  kind: FixKind,
  pullRequest: PullRequestDetail,
  source: FixSource,
): Promise<ThreadId | null> => {
  runs += 1;
  const id = `pull-request-fix-${runs}`;
  const failed = (message: string) => {
    deps.toast.error(`${FIX_LABELS[kind]} failed: ${message}`, { id });
    return null;
  };
  deps.toast.loading(`Starting a thread to ${FIX_LABELS[kind].toLowerCase()}…`, { id });

  let context: PullRequestFixContext | null = null;
  if (fixNeedsContext(kind)) {
    const read = await deps.fixContext(kind);
    if (!read.ok) {
      return failed(read.message);
    }
    context = read.value;
  }
  const prompt = buildFixPrompt(kind, pullRequest, context);

  const threadId = deps.newThreadId();
  const created = await deps.create(threadId, {
    ...(source.settings === undefined ? {} : { settings: settingsPatch(source.settings) }),
    ...(source.worktree === undefined ? {} : { worktree: source.worktree }),
  });
  if (!created) {
    // `useCreateThread` has said why.
    deps.toast.dismiss(id);
    return null;
  }
  deps.refreshMarks();
  const sent = await deps.send(threadId, prompt);
  deps.open(threadId);
  if (!isAccepted(sent)) {
    return failed(
      `the thread started, but its first message was not sent: ${rejectionMessage(sent, "the server rejected the message")}`,
    );
  }
  deps.toast.success(`Started a thread to ${FIX_LABELS[kind].toLowerCase()}`, { id });
  return threadId;
};

/** The Fix menu's run, bound to the tab's thread. */
export const useFixThread = (projectId: ProjectId, threadId: ThreadId) => {
  const registry = React.useContext(RegistryContext);
  const { pullRequestFixContext, refreshPullRequests } = usePullRequestAtoms();
  const { create } = useCreateThread();
  const dispatch = useDispatchCommand();
  const navigate = useNavigate();
  const source = useThreadList().find((thread) => thread.threadId === threadId);

  const start = React.useCallback(
    (kind: FixKind, pullRequest: PullRequestDetail) =>
      runFixThread(
        {
          fixContext: async (contextKind) => {
            const exit = await pullRequestFixContext(registry, {
              scope: { projectId, threadId },
              number: pullRequest.number,
              kind: contextKind,
            });
            return Exit.isSuccess(exit)
              ? { ok: true, value: exit.value }
              : { ok: false, message: describeExitError(exit, "the context was not read") };
          },
          create: (newThreadId, options) =>
            create(projectId, { threadId: newThreadId, navigate: false, ...options }),
          send: (newThreadId, text): Promise<Exit.Exit<CommandReceipt, unknown>> => {
            // Before the dispatch: the message row can arrive before the receipt.
            noteLocalSend(newThreadId);
            return dispatch({
              commandId: makeCommandId(),
              createdAt: new Date().toISOString(),
              type: "thread.turn.start",
              threadId: newThreadId,
              text,
              attachments: [],
              mentions: [],
              queued: false,
            });
          },
          refreshMarks: () => refreshPullRequests(registry, projectId),
          open: (newThreadId) =>
            void navigate({ to: "/t/$threadId", params: { threadId: newThreadId } }),
          newThreadId: makeThreadId,
          toast,
        },
        kind,
        pullRequest,
        {
          ...(source === undefined ? {} : { settings: source.settings }),
          ...(source?.worktree === undefined ? {} : { worktree: source.worktree }),
        },
      ),
    [
      create,
      dispatch,
      navigate,
      projectId,
      pullRequestFixContext,
      refreshPullRequests,
      registry,
      source,
      threadId,
    ],
  );

  return { start, target: fixTarget(source?.worktree) };
};
