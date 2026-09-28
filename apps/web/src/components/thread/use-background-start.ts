/**
 * Starting threads from New task without leaving it: the steps
 * `background-start.ts` runs, bound to the server, with a toast for the user.
 *
 * Every write is a one-shot call — `worktreeCreate`, `worktreeSetupRun` and
 * `worktreeRemove` from the git commands, `thread.create`, the attachment
 * uploads and `thread.turn.start` from `@/lib/one-shot-commands` — never the
 * composer's shared dispatch or the start panel's setup atom. Each resolves
 * on its own, so the user's next send, a sibling lane or leaving the page
 * interrupts none of them. The chain holds no component state either: the
 * draft it sends is a snapshot taken at the press, and a thread that exists
 * but did not get its message keeps that snapshot in its own composer.
 *
 * One toast follows a start: "Starting in <project>…" while it runs, then the
 * same toast turns into the result (`backgroundSummary`), with an Open action
 * for the first thread that started — or, failing that, the first that
 * exists. When a lane has a worktree, the loading toast offers Stop setup:
 * it ends every setup of that start still running or yet to run, as the
 * start panel's Stop does, so each such lane creates its thread with the
 * message parked. Nothing navigates on its own. A start in which no thread
 * came to exist hands the message back to the start screen's current draft,
 * if the user has not begun typing another one there.
 *
 * `useStartInBackground` is the start composer's side: the
 * `composer.startInBackground` command and the send menu's item take the
 * draft, empty the composer under a fresh draft id and run one lane — in a new
 * worktree when the workspace picker says so. With "Compare models" on
 * (`use-compare-models.ts`) the same press fans out instead: one lane per
 * chosen model, each in its own new worktree, named for its model in the
 * toast. It does not hand the project's terminals to the thread: the user
 * stays on New task, with them.
 */

import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as React from "react";
import { toast } from "sonner";

import { makeCommandId, type ThreadId } from "@poseidon/contracts/ids";
import type {
  Attachment,
  ProjectSummary,
  ThreadSettingsPatch,
} from "@poseidon/contracts/orchestration";

import { readAsBase64 } from "@/components/composer/attachment-rules";
import { useGitCommands } from "@/components/panes/changes/git-atoms";
import {
  backgroundSummary,
  runBackgroundLanes,
  serialized,
  type BackgroundLane,
  type BackgroundLaneSteps,
  type BackgroundOutcome,
} from "@/components/thread/background-start";
import { worktreeName } from "@/components/thread/start-in-worktree";
import type { CompareModels } from "@/components/thread/use-compare-models";
import type { WorkspaceChoice } from "@/components/thread/workspace-mode-picker";
import { describeExitError } from "@/lib/app-runtime";
import {
  DISPATCH_UNREACHABLE,
  isAccepted,
  receiptError,
  rejectionMessage,
} from "@/lib/dispatch-outcome";
import { useOneShotCommands } from "@/lib/one-shot-commands";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { noteLocalSend } from "@/state/local-sends";
import { isEmptyDraft, useComposerDraftWriter, type ComposerDraft } from "@/state/ui";

export interface BackgroundStart {
  readonly project: ProjectSummary;
  readonly lanes: ReadonlyArray<BackgroundLane>;
  /** The message every lane sends, as it was when the user pressed. */
  readonly draft: ComposerDraft;
  /** Names each lane in the result toast (the model), by index. */
  readonly labels?: ReadonlyArray<string | undefined>;
  /** The start screen's draft at the moment no thread came to exist. */
  readonly restoreTo?: () => string;
}

const UPLOAD_FAILED = "the attachment could not be uploaded";
const SETUP_STOPPED = "Setup script stopped";

/** Runs lanes in the background and reports them in one toast; resolves with their outcomes. */
const useBackgroundStart = () => {
  const git = useGitCommands();
  const oneShot = useOneShotCommands();
  const writeDraft = useComposerDraftWriter();
  const navigate = useNavigate();

  return React.useCallback(
    async (start: BackgroundStart): Promise<ReadonlyArray<BackgroundOutcome>> => {
      const { project, lanes, draft } = start;
      const projectId = project.projectId;
      // One upload at a time across the lanes, as the composer does for one.
      const uploads = serialized();
      // Stop setup on the loading toast: ends this start's setups.
      const setupStop = new AbortController();

      const upload = async (threadId: ThreadId): Promise<ReadonlyArray<Attachment> | null> => {
        const staged: Array<Attachment> = [];
        for (const file of draft.files) {
          const exit = await oneShot.stageAttachment({
            threadId,
            name: file.name,
            base64: await readAsBase64(file),
          });
          if (!Exit.isSuccess(exit)) {
            return null;
          }
          const { path, mime, name, size, sha256 } = exit.value;
          staged.push({ path, mime, name, size, sha256 });
        }
        return staged;
      };

      const steps: BackgroundLaneSteps = {
        createWorktree: async (worktree) => {
          const exit = await git.worktreeCreate({ projectId, ...worktree });
          if (Exit.isSuccess(exit)) {
            return exit.value;
          }
          throw Cause.squash(exit.cause);
        },
        runSetup: async (worktree) => {
          if (setupStop.signal.aborted) {
            throw { message: SETUP_STOPPED };
          }
          const exit = await git.worktreeSetupRun(
            { projectId, path: worktree.path },
            { signal: setupStop.signal },
          );
          if (Exit.isSuccess(exit)) {
            return exit.value;
          }
          throw {
            message: setupStop.signal.aborted
              ? SETUP_STOPPED
              : `Setup script could not run: ${describeExitError(exit, "the stream failed")}`,
          };
        },
        createThread: async (lane, worktree) => {
          const exit = await oneShot.dispatch({
            commandId: makeCommandId(),
            createdAt: new Date().toISOString(),
            type: "thread.create",
            threadId: lane.threadId,
            projectId,
            settings: lane.settings,
            ...(lane.title === undefined ? {} : { title: lane.title }),
            ...(worktree === undefined ? {} : { worktree }),
          });
          return isAccepted(exit) ? null : rejectionMessage(exit, "The thread was rejected");
        },
        sendFirstTurn: async (threadId) => {
          const attachments = await uploads(() => upload(threadId)).catch(() => null);
          if (attachments === null) {
            return UPLOAD_FAILED;
          }
          // Before the dispatch: the message row can arrive before the receipt.
          noteLocalSend(threadId);
          const exit = await oneShot.dispatch({
            commandId: makeCommandId(),
            createdAt: new Date().toISOString(),
            type: "thread.turn.start",
            threadId,
            text: draft.text.trim(),
            attachments: [...attachments],
            mentions: [...draft.mentions],
            ...(draft.references.length > 0 ? { references: [...draft.references] } : {}),
            queued: false,
          });
          return Exit.isSuccess(exit)
            ? receiptError(exit.value, "the server rejected the message")
            : DISPATCH_UNREACHABLE;
        },
        parkDraft: (threadId) => writeDraft(threadId, draft),
        discardWorktree: async (worktree) => {
          const exit = await git.worktreeRemove({ projectId, path: worktree.path, force: true });
          if (!Exit.isSuccess(exit)) {
            throw { message: describeExitError(exit, "unknown error") };
          }
        },
      };

      const toastId = toast.loading(
        lanes.length === 1
          ? `Starting in ${project.name}…`
          : `Starting ${lanes.length} threads in ${project.name}…`,
        {
          action: lanes.some((lane) => lane.worktree !== undefined)
            ? {
                label: "Stop setup",
                onClick: (event) => {
                  // The toast stays until the lanes have settled.
                  event.preventDefault();
                  setupStop.abort();
                  toast.loading(`Stopping setup in ${project.name}…`, {
                    id: toastId,
                    action: undefined,
                  });
                },
              }
            : undefined,
        },
      );
      const outcomes = await runBackgroundLanes(lanes, steps).catch((error: unknown) =>
        lanes.map((): BackgroundOutcome => ({
          _tag: "failed",
          reason: error instanceof Error ? error.message : "The start stopped unexpectedly",
        })),
      );

      const restoreTo = start.restoreTo;
      if (restoreTo !== undefined && outcomes.every((outcome) => outcome._tag === "failed")) {
        writeDraft(restoreTo(), (current) => (isEmptyDraft(current) ? draft : current));
      }
      const summary = backgroundSummary(project.name, outcomes, start.labels);
      const openThreadId = summary.openThreadId;
      toast[summary.tone](summary.title, {
        id: toastId,
        description: summary.description,
        action:
          openThreadId === null
            ? undefined
            : {
                label: "Open",
                onClick: () =>
                  void navigate({ to: "/t/$threadId", params: { threadId: openThreadId } }),
              },
      });
      return outcomes;
    },
    [git, oneShot, writeDraft, navigate],
  );
};

/** What the start composer hands `useStartInBackground`. */
export interface StartInBackgroundInput {
  readonly project: ProjectSummary;
  /** The start draft's id; the thread takes it, and the composer moves on to a new one. */
  readonly threadId: ThreadId;
  readonly draft: ComposerDraft;
  readonly settings: ThreadSettingsPatch;
  readonly choice: WorkspaceChoice;
  readonly canSend: boolean;
  /** A foreground start is under way. */
  readonly blocked: boolean;
  /** Empties the current draft. */
  readonly clearDraft: () => void;
  /** Moves the composer to a fresh draft id. */
  readonly onNextDraft: () => void;
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** "Compare models": while it is on, a start fans out into one lane per model. */
  readonly compare?: Pick<CompareModels, "enabled" | "refusal" | "plan">;
}

/**
 * The start composer's "Start in background": answers
 * `composer.startInBackground` and returns the same action for the send menu.
 */
export const useStartInBackground = (input: StartInBackgroundInput): (() => void) => {
  const run = useBackgroundStart();
  // Latched from the press until the composer is on its next draft: a second
  // press before the re-render would otherwise send the same draft twice.
  const latchRef = React.useRef(false);
  const currentIdRef = React.useRef(input.threadId);
  currentIdRef.current = input.threadId;
  React.useEffect(() => {
    latchRef.current = false;
  }, [input.threadId]);

  const start = () => {
    const { project, threadId, draft, settings, choice, textareaRef } = input;
    const compare = input.compare?.enabled === true ? input.compare : undefined;
    if (latchRef.current || !input.canSend || input.blocked || compare?.refusal != null) {
      return;
    }
    latchRef.current = true;
    const lane: BackgroundLane = {
      threadId,
      settings,
      ...(choice.mode === "worktree"
        ? { worktree: { name: worktreeName(draft.text), baseBranch: choice.baseBranch } }
        : {}),
    };
    // Compare lanes mint their own thread ids; the draft id is simply retired.
    const fanOut = compare?.plan(draft.text);
    input.clearDraft();
    input.onNextDraft();
    textareaRef.current?.focus();
    void run({
      project,
      lanes: fanOut ?? [lane],
      draft,
      ...(fanOut === undefined ? {} : { labels: fanOut.map((entry) => entry.label) }),
      restoreTo: () => currentIdRef.current,
    });
  };

  useKeybindingCommand("composer.startInBackground", start);
  return start;
};
