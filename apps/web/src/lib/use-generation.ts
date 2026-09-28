/**
 * The generated-text calls (`@poseidon/client-runtime/generationCommands`),
 * built once on the app's runtime and bound to the registry in context, with
 * what every "Generate" in the renderer shares: whether generation can run
 * (`useGenerationBlockedReason`), one cancellable run per surface
 * (`useGenerationRunner`), and the once-per-session notice toast.
 *
 * Each call resolves with a `GenerationOutcome` — the answer, or the server's
 * reason in words — so a caller never reads an `Exit`. A call aborted through
 * its signal is interrupted on the server, which stops the harness.
 */

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  makeGenerationCommands,
  type GenerationCommands,
} from "@poseidon/client-runtime/generationCommands";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";
import { toast } from "sonner";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";
import {
  generationBlockedReason,
  makeGenerationRunner,
  noticeOnce,
  type GenerationOutcome,
  type GenerationRunner,
} from "@/lib/generation-run";
import { getAppAtoms } from "@/state/app-runtime";
import { useConnectionState } from "@/state/hooks";

let generationCommands: GenerationCommands | null = null;

const getGenerationCommands = (): GenerationCommands => {
  generationCommands ??= makeGenerationCommands(getAppAtoms().runtime);
  return generationCommands;
};

const outcomeOf = <A>(exit: Exit.Exit<A, unknown>, fallback: string): GenerationOutcome<A> =>
  Exit.isSuccess(exit)
    ? { ok: true, value: exit.value }
    : { ok: false, message: describeExitError(exit, fallback) };

/** The three calls, bound to the app's registry, each answering a `GenerationOutcome`. */
export const useGenerationCommands = () => {
  const registry = React.useContext(RegistryContext);
  return React.useMemo(() => {
    const commands = getGenerationCommands();
    type Options = Parameters<GenerationCommands["generateCommitMessage"]>[2];
    return {
      generateCommitMessage: async (
        input: Parameters<GenerationCommands["generateCommitMessage"]>[1],
        options?: Options,
      ) =>
        outcomeOf(
          await commands.generateCommitMessage(registry, input, options),
          "The message could not be written.",
        ),
      generatePullRequest: async (
        input: Parameters<GenerationCommands["generatePullRequest"]>[1],
        options?: Options,
      ) =>
        outcomeOf(
          await commands.generatePullRequest(registry, input, options),
          "The pull request text could not be written.",
        ),
      regenerateTitle: async (
        input: Parameters<GenerationCommands["regenerateTitle"]>[1],
        options?: Options,
      ) =>
        outcomeOf(
          await commands.regenerateTitle(registry, input, options),
          "The title could not be written.",
        ),
    };
  }, [registry]);
};

/** Why nothing can generate text right now (`generationBlockedReason`); `null` when something can. */
export const useGenerationBlockedReason = (): string | null => {
  const connected = useConnectionState().status === "connected";
  const result = useAtomValue(useAppAtoms().connectorsAtom);
  return generationBlockedReason({
    connected,
    connectors: AsyncResult.isSuccess(result) ? result.value : null,
  });
};

/**
 * One run at a time for the component that holds it, with whether it runs.
 * Unmounting — the dialog closing — cancels the run in flight.
 */
export const useGenerationRunner = (): {
  readonly running: boolean;
  readonly runner: GenerationRunner;
} => {
  const [running, setRunning] = React.useState(false);
  const [runner] = React.useState(() => makeGenerationRunner(setRunning));
  React.useEffect(() => runner.cancel, [runner]);
  return { running, runner };
};

/** Says, once per app session, that the chosen Writing model was passed over. */
export const showGenerationNotice = (notice: string | undefined): void =>
  noticeOnce(notice, (text) => {
    toast.info(text);
  });
