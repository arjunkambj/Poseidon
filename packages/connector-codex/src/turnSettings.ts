/**
 * What a turn runs on, and what `turn/start` has to name for it.
 *
 * `turn/start`'s `model` and `effort` are overrides "for this turn and
 * subsequent turns" (the app-server bindings of `PROTOCOL_CLI_VERSION`): the
 * CLI's thread keeps the last value it was sent. Leaving one out does not go
 * back to a default — it keeps the old one. So a model switch that left out
 * an effort the new model does not offer would run the new model at the old
 * effort, and a thread switched back to `default` would stay on the model it
 * was switched to.
 *
 * So the session keeps what the CLI's thread holds (`ThreadHolds`) — first
 * what `thread/start` or `thread/resume` answered — and every turn names each
 * value that differs from it, explicitly:
 *
 * - the model is the thread's, or for `default` the model the CLI opened the
 *   thread on;
 * - the effort is the thread's when the model offers it; otherwise — unset,
 *   or not offered — the effort the CLI opened the thread with, when the turn
 *   runs on that model, else the model's own default (`defaultReasoningEffort`
 *   from `model/list`). With neither known, none is named.
 *
 * What the thread holds moves only once the CLI accepted the `turn/start`
 * that named it: a refused turn changed nothing on the thread.
 */

import type { Effort } from "@poseidon/contracts/enums";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";

import { codexModelFor, type CodexModelFacts } from "./models";
import type { OpenedThread } from "./threadOpen";

/** What the CLI's thread holds between turns, as far as the session knows. */
export interface ThreadHolds {
  readonly model: string;
  /** Undefined when the session does not know which effort the thread holds. */
  readonly effort: Effort | undefined;
}

/** What one turn runs on. */
export interface TurnTarget {
  readonly model: string;
  /** Undefined when neither the thread nor the CLI names one the model offers. */
  readonly effort: Effort | undefined;
}

export const holdsOf = (opened: OpenedThread): ThreadHolds => ({
  model: opened.model,
  effort: opened.effort,
});

export const turnTarget = (input: {
  /** Only the model and effort are read, so a one-shot call names just those. */
  readonly settings: Pick<ThreadSettings, "model" | "effort">;
  readonly opened: OpenedThread;
  readonly factsFor?: (model: string) => CodexModelFacts | undefined;
}): TurnTarget => {
  const { settings, opened } = input;
  const model = codexModelFor(settings.model) ?? opened.model;
  const facts = input.factsFor?.(model);
  const offered = (effort: Effort | undefined): effort is Effort =>
    effort !== undefined && (facts === undefined || facts.efforts.includes(effort));
  if (offered(settings.effort)) return { model, effort: settings.effort };
  const openedWith = model === opened.model ? opened.effort : undefined;
  return { model, effort: offered(openedWith) ? openedWith : facts?.defaultEffort };
};

/**
 * The overrides `turn/start` names for `target`, and what the thread holds
 * once the CLI accepted them.
 */
export const turnOverrides = (
  target: TurnTarget,
  holds: ThreadHolds,
): {
  readonly params: { readonly model?: string; readonly effort?: Effort };
  readonly next: ThreadHolds;
} => {
  const model = target.model === holds.model ? undefined : target.model;
  const effort =
    target.effort === undefined || (model === undefined && target.effort === holds.effort)
      ? undefined
      : target.effort;
  return {
    params: {
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    },
    next: {
      model: target.model,
      // A model named with no effort leaves the effort the CLI's to choose.
      effort: target.effort ?? (model === undefined ? holds.effort : undefined),
    },
  };
};
