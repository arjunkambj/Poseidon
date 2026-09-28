/**
 * The pull request dialog's Generate: writes the title and description from
 * the branch's commits and its diff against the base (`git.generatePullRequest`)
 * and puts both in the dialog, replacing what they held, since the user asked.
 * A failure is a toast with the server's reason and leaves both fields as
 * they were; a `notice` in the answer is said once per app session. Closing
 * the dialog unmounts the hook, which cancels a run still in flight.
 */

import type { GitScope } from "@poseidon/client-runtime/gitAtoms";
import { toast } from "sonner";

import type { GenerationOutcome, GenerationRunner } from "@/lib/generation-run";
import {
  showGenerationNotice,
  useGenerationBlockedReason,
  useGenerationCommands,
  useGenerationRunner,
} from "@/lib/use-generation";

import type { GenerateControl } from "./generate-button";

/** A pull request's title and description. */
export interface PullRequestText {
  readonly title: string;
  readonly body: string;
}

export interface PullRequestGeneration {
  readonly runner: GenerationRunner;
  readonly generate: (
    signal: AbortSignal,
  ) => Promise<GenerationOutcome<PullRequestText & { readonly notice?: string | undefined }>>;
  readonly fill: (text: PullRequestText) => void;
  readonly toastError: (message: string) => void;
  readonly notice: (notice: string | undefined) => void;
}

/** One Generate run into the dialog; nothing when one already runs or it is cancelled. */
export const generatePullRequestInto = async (deps: PullRequestGeneration): Promise<void> => {
  const outcome = await deps.runner.start(deps.generate);
  if (outcome === null) {
    return;
  }
  if (!outcome.ok) {
    deps.toastError(`Couldn't write the pull request: ${outcome.message}`);
    return;
  }
  deps.notice(outcome.value.notice);
  deps.fill({ title: outcome.value.title.trim(), body: outcome.value.body.trim() });
};

/** The Generate button's state and actions for the pull request dialog in `scope`. */
export const useGeneratePullRequest = ({
  scope,
  fill,
}: {
  readonly scope: GitScope;
  readonly fill: (text: PullRequestText) => void;
}): GenerateControl => {
  const { running, runner } = useGenerationRunner();
  const reason = useGenerationBlockedReason();
  const { generatePullRequest } = useGenerationCommands();
  return {
    running,
    reason,
    onGenerate: () =>
      void generatePullRequestInto({
        runner,
        generate: (signal) => generatePullRequest(scope, { signal }),
        fill,
        toastError: (message) => {
          toast.error(message);
        },
        notice: showGenerationNotice,
      }),
    onCancel: runner.cancel,
  };
};
