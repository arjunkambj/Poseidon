/**
 * The commit dialog's Generate: writes the message from the diff of the ticked
 * files (`git.generateCommitMessage`, with `paths` only when something is
 * unticked) and puts it in the box through `fillGenerated`, so it counts as
 * edited and is marked generated.
 *
 * A click fills the box whatever it holds, since the user asked; a failure is
 * a toast with the server's reason. With Settings → Git's "Draft commit
 * messages" set to "Generate when the dialog opens", it also runs once as the
 * dialog opens, as soon as generation is available. That run never replaces
 * a message the user started typing meanwhile, and when it fails the template
 * stays and the toast says so (`COMMIT_DRAFT_FAILED`). A `notice` in the
 * answer — the Writing model was passed over — is said once per app session.
 *
 * The dialog is mounted fresh for each opening, so "once" is per opening;
 * closing it unmounts the hook, which cancels a run still in flight.
 */

import { useAtomValue } from "@effect/atom-react";
import type { GitScope } from "@poseidon/client-runtime/gitAtoms";
import type { CommitDraftMode } from "@poseidon/contracts/generation";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";
import { toast } from "sonner";

import { useAppAtoms } from "@/lib/app-runtime";
import type { GenerationOutcome, GenerationRunner } from "@/lib/generation-run";
import {
  showGenerationNotice,
  useGenerationBlockedReason,
  useGenerationCommands,
  useGenerationRunner,
} from "@/lib/use-generation";

import type { GenerateControl } from "./generate-button";
import { fillGenerated, generatedCommitMessage, type CommitPickerState } from "./commit-picker";

export const COMMIT_DRAFT_FAILED = "Couldn't write a message, kept the template";

interface GeneratedCommit {
  readonly subject: string;
  readonly body: string;
  readonly notice?: string | undefined;
}

export interface CommitGeneration {
  readonly runner: GenerationRunner;
  /** `git.generateCommitMessage` for `paths` (every change when absent). */
  readonly generate: (
    paths: ReadonlyArray<string> | undefined,
    signal: AbortSignal,
  ) => Promise<GenerationOutcome<GeneratedCommit>>;
  readonly update: (change: (picker: CommitPickerState) => CommitPickerState) => void;
  readonly toastError: (message: string) => void;
  readonly notice: (notice: string | undefined) => void;
}

/**
 * One Generate run into the picker: from a click (`auto` false) or as the
 * dialog opens (`auto` true). Does nothing when a run is already in flight,
 * and nothing more once it is cancelled.
 */
export const generateCommitInto = async (
  deps: CommitGeneration,
  paths: ReadonlyArray<string> | undefined,
  auto: boolean,
): Promise<void> => {
  const outcome = await deps.runner.start((signal) => deps.generate(paths, signal));
  if (outcome === null) {
    return;
  }
  if (!outcome.ok) {
    deps.toastError(
      auto ? COMMIT_DRAFT_FAILED : `Couldn't write a commit message: ${outcome.message}`,
    );
    return;
  }
  deps.notice(outcome.value.notice);
  const message = generatedCommitMessage(outcome.value);
  deps.update((picker) =>
    auto && picker.edited !== null ? picker : fillGenerated(picker, message),
  );
};

/**
 * The on-open draft for one opening: called whenever the setting or the
 * availability changes, it runs `draft` the first time the setting says
 * Generate and something can write, and never again.
 */
export const makeOpenDraft = (draft: () => void) => {
  let drafted = false;
  return (mode: CommitDraftMode, reason: string | null): void => {
    if (drafted || mode !== "generate" || reason !== null) {
      return;
    }
    drafted = true;
    draft();
  };
};

/** Settings → Git's "Draft commit messages", Template until the document says otherwise. */
const useCommitDraftMode = (): CommitDraftMode => {
  const result = useAtomValue(useAppAtoms().settingsAtom);
  return (
    (AsyncResult.isSuccess(result) ? result.value?.git.draftCommitMessages : undefined) ??
    "template"
  );
};

/** The Generate button's state and actions for the commit dialog in `scope`. */
export const useGenerateCommitMessage = ({
  scope,
  paths,
  setPicker,
}: {
  readonly scope: GitScope;
  /** The ticked paths; absent when every file is ticked. */
  readonly paths: ReadonlyArray<string> | undefined;
  readonly setPicker: (change: (picker: CommitPickerState) => CommitPickerState) => void;
}): GenerateControl => {
  const { running, runner } = useGenerationRunner();
  const reason = useGenerationBlockedReason();
  const draftMode = useCommitDraftMode();
  const { generateCommitMessage } = useGenerationCommands();

  const run = (auto: boolean) =>
    void generateCommitInto(
      {
        runner,
        generate: (ticked, signal) =>
          generateCommitMessage(
            { ...scope, ...(ticked === undefined ? {} : { paths: ticked }) },
            { signal },
          ),
        update: setPicker,
        toastError: (message) => {
          toast.error(message);
        },
        notice: showGenerationNotice,
      },
      paths,
      auto,
    );
  const runRef = React.useRef(run);
  runRef.current = run;

  // Once per opening, as soon as the setting is read and something can write.
  const [draftOnOpen] = React.useState(() => makeOpenDraft(() => runRef.current(true)));
  React.useEffect(() => draftOnOpen(draftMode, reason), [draftOnOpen, draftMode, reason]);

  return {
    running,
    reason,
    onGenerate: () => run(false),
    onCancel: runner.cancel,
  };
};
