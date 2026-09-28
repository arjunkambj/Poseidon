/**
 * The branch-off dialog's request and its side of `./branch-off`.
 *
 * `useRequestBranchOff` is what a message footer or a thread menu calls; the
 * dialog itself is mounted once above the routes (`BranchOffHost`), so it
 * outlives the row that asked for it — a virtualized timeline row may scroll
 * away, and a sidebar menu closes as the dialog opens.
 *
 * `useBranchOff` binds the steps to the server: one thread id per opening,
 * so a retried create is the same thread; `thread.create` with the fork —
 * or, for a plan, with the source's settings out of plan mode, and then the
 * source's pending plan answered `handoff`; the first message, when the
 * caller has one — put back in the new thread's composer, with a toast, if
 * it is refused; then the thread opened with its composer focused. The new-worktree path is the start screen's
 * (`useStartInWorktree`), with the same create, send and open.
 */

import { useAtom, useAtomSet } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";
import { toast } from "sonner";

import type { ThreadWorktree } from "@poseidon/contracts/git";
import { makeCommandId, makeThreadId } from "@poseidon/contracts/ids";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";
import { uuidV7 } from "@poseidon/shared/ids";

import {
  branchOffCreateFields,
  branchOffHere,
  inNewWorktree,
  sendFirstMessage,
  type BranchOffActions,
  type BranchOffRequest,
} from "@/components/thread/branch-off";
import { worktreeName } from "@/components/thread/start-in-worktree";
import { useStartInWorktree } from "@/components/thread/use-start-in-worktree";
import { requestComposerFocus } from "@/lib/composer-focus";
import { isAccepted, rejectionMessage } from "@/lib/dispatch-outcome";
import { useDispatchCommand } from "@/state/hooks";
import { useComposerDraft } from "@/state/ui";

const branchOffRequestAtom = Atom.keepAlive(Atom.make<BranchOffRequest | null>(null));

/** The open request, and the setter the host closes it with. */
export const useBranchOffRequest = () => useAtom(branchOffRequestAtom);

/** Opens the branch-off dialog for a thread, from one of its messages or the whole of it. */
export const useRequestBranchOff = () => {
  const set = useAtomSet(branchOffRequestAtom);
  return React.useCallback(
    (request: Omit<BranchOffRequest, "key">) => set({ ...request, key: uuidV7() }),
    [set],
  );
};

export const useBranchOff = (
  request: BranchOffRequest,
  source: ThreadSummary,
  options: {
    /** The new thread's title, as the dialog has it when the create runs. */
    readonly title: string;
    /** A first message to send once the thread exists. */
    readonly firstMessage?: string;
    /** Called once the new thread is open. */
    readonly onOpened: () => void;
  },
) => {
  const dispatch = useDispatchCommand();
  const navigate = useNavigate();
  const [threadId] = React.useState(makeThreadId);
  // The steps run across renders; they read the title as it is when they do.
  const optionsRef = React.useRef(options);
  optionsRef.current = options;
  // Where a refused first message goes back to: the new thread's composer.
  const { setText } = useComposerDraft(threadId);
  const keepDraftRef = React.useRef(setText);
  keepDraftRef.current = setText;

  const actions = React.useMemo((): BranchOffActions => {
    const plan = request.plan;
    const createThread = async (worktree: ThreadWorktree | undefined) => {
      const title = optionsRef.current.title.trim();
      const exit = await dispatch({
        commandId: makeCommandId(),
        createdAt: new Date().toISOString(),
        type: "thread.create",
        threadId,
        projectId: source.projectId,
        ...(title === "" ? {} : { title }),
        ...(worktree === undefined ? {} : { worktree }),
        ...branchOffCreateFields(request, source.settings),
      });
      if (!isAccepted(exit)) {
        toast.error(
          rejectionMessage(
            exit,
            plan === undefined ? "The fork was not created" : "The thread was not created",
          ),
        );
        return false;
      }
      if (plan?.handoffTurnId !== undefined) {
        // Closes the source's card. A refusal means the plan was answered
        // meanwhile, which leaves nothing to close.
        void dispatch({
          commandId: makeCommandId(),
          createdAt: new Date().toISOString(),
          type: "thread.plan.respond",
          threadId: request.threadId,
          turnId: plan.handoffTurnId,
          action: "handoff",
        });
      }
      return true;
    };
    const firstMessage = optionsRef.current.firstMessage;
    return {
      createThread,
      ...(firstMessage === undefined
        ? {}
        : {
            sendFirst: () =>
              void sendFirstMessage(
                () =>
                  dispatch({
                    commandId: makeCommandId(),
                    createdAt: new Date().toISOString(),
                    type: "thread.turn.start",
                    threadId,
                    text: firstMessage,
                    attachments: [],
                    mentions: [],
                    queued: false,
                  }),
                firstMessage,
                (text) => keepDraftRef.current(text),
                (message) =>
                  toast.error(message, {
                    description: "It is in the new thread's composer to send again.",
                  }),
              ),
          }),
      open: () => {
        requestComposerFocus(threadId);
        void navigate({ to: "/t/$threadId", params: { threadId } });
        optionsRef.current.onOpened();
      },
    };
  }, [dispatch, navigate, request, source.projectId, source.settings, threadId]);

  const worktree = useStartInWorktree(source.projectId, inNewWorktree(actions));
  const [creating, setCreating] = React.useState(false);

  /** In the source's own workspace: its worktree, or the project's folder. */
  const here = async () => {
    setCreating(true);
    try {
      await branchOffHere(actions, source.worktree);
    } finally {
      setCreating(false);
    }
  };

  /**
   * In a worktree of its own, named from the title and cut from the source's
   * branch when the source has a worktree, else from the default branch.
   */
  const inWorktree = () =>
    worktree.start(worktreeName(optionsRef.current.title), source.worktree?.branch);

  return { here, inWorktree, creating, worktree };
};
