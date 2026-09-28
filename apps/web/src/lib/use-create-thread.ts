/**
 * The one "new thread" flow. Mint the id client-side (so a retry is a no-op
 * rather than a second thread), dispatch `thread.create`, and navigate to the
 * thread on an accepted receipt. The sidebar's per-project button, the home
 * composer and the command palette all call this, so there is exactly one
 * code path that can bring a thread into existence.
 *
 * Every accepted create records its project as the last one used, which is
 * what the home composer's project picker opens on. One that navigates also
 * asks the thread's composer to take the focus (`@/lib/composer-focus`), so
 * the user can type the first message straight away.
 *
 * A project whose newest thread is still blank (no user or agent message
 * yet) gets that thread back instead of another one, so pressing "new thread"
 * repeatedly never stacks empty threads.
 *
 * The home composer passes its own id and `navigate: false`: it has a first
 * message to send before leaving, and the draft it holds is keyed by that id,
 * so an unsent draft follows the user into the thread's own composer. It
 * always creates, because the message it sends is what fills the thread —
 * and passes the `worktree` it cut when the thread starts in one.
 *
 * A create that names no model or instance gets New task's seed
 * (`threadCreateSeed`), so a harness switched off in Settings → Models is not
 * where a thread from the sidebar, the palette or a key starts.
 */

import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";

import type { ThreadWorktree } from "@poseidon/contracts/git";
import {
  makeCommandId,
  makeThreadId,
  type ProjectId,
  type ThreadId,
} from "@poseidon/contracts/ids";
import type { ThreadSettingsPatch, ThreadSummary } from "@poseidon/contracts/orchestration";

import { requestComposerFocus } from "@/lib/composer-focus";
import { isAccepted, rejectionMessage } from "@/lib/dispatch-outcome";
import { useThreadCreateSeed } from "@/lib/use-model-picker-prefs";
import { useDispatchCommand, useThreadList } from "@/state/hooks";
import { useLastProject } from "@/state/ui";

/**
 * The project's newest thread when nothing has been said in it yet. The read
 * model only sets `preview` from a user or assistant message, so its absence
 * on an idle thread means the thread is empty.
 */
export const blankLatestThread = (
  threads: ReadonlyArray<ThreadSummary>,
  projectId: ProjectId,
): ThreadSummary | undefined => {
  let latest: ThreadSummary | undefined;
  for (const thread of threads) {
    if (
      thread.projectId === projectId &&
      thread.status !== "archived" &&
      thread.status !== "deleted" &&
      (latest === undefined || thread.createdAt > latest.createdAt)
    ) {
      latest = thread;
    }
  }
  return latest !== undefined && latest.status === "idle" && latest.preview === undefined
    ? latest
    : undefined;
};

/** The caller's settings, with `seed` under them when they name no model or instance. */
export const withCreateSeed = (
  settings: ThreadSettingsPatch | undefined,
  seed: ThreadSettingsPatch | undefined,
): ThreadSettingsPatch | undefined =>
  seed === undefined || settings?.model !== undefined || settings?.connectorInstanceId !== undefined
    ? settings
    : { ...seed, ...settings };

export const useCreateThread = () => {
  const dispatch = useDispatchCommand();
  const threads = useThreadList();
  const navigate = useNavigate();
  const [, rememberProject] = useLastProject();
  const [pending, setPending] = React.useState(false);
  const seed = useThreadCreateSeed();

  const create = React.useCallback(
    async (
      projectId: ProjectId,
      options: {
        readonly threadId?: ThreadId;
        readonly navigate?: boolean;
        readonly settings?: ThreadSettingsPatch;
        /** The worktree the thread works in instead of the project's folder. */
        readonly worktree?: ThreadWorktree;
      } = {},
    ): Promise<boolean> => {
      const blank =
        options.threadId === undefined ? blankLatestThread(threads, projectId) : undefined;
      if (blank !== undefined) {
        rememberProject(projectId);
        if (options.navigate !== false) {
          requestComposerFocus(blank.threadId);
          void navigate({ to: "/t/$threadId", params: { threadId: blank.threadId } });
        }
        return true;
      }
      const threadId = options.threadId ?? makeThreadId();
      setPending(true);
      const exit = await dispatch({
        commandId: makeCommandId(),
        createdAt: new Date().toISOString(),
        type: "thread.create",
        threadId,
        projectId,
        settings: withCreateSeed(options.settings, seed),
        ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
      });
      setPending(false);
      if (isAccepted(exit)) {
        rememberProject(projectId);
        if (options.navigate !== false) {
          requestComposerFocus(threadId);
          void navigate({ to: "/t/$threadId", params: { threadId } });
        }
        return true;
      }
      toast.error(rejectionMessage(exit, "Thread was rejected"));
      return false;
    },
    [dispatch, navigate, rememberProject, seed, threads],
  );

  return { create, pending };
};
