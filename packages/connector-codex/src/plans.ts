/**
 * Plan mode on Codex, as Poseidon runs it.
 *
 * The app-server has plan mode as a *collaboration mode*: `turn/start` takes
 * `collaborationMode: { mode, settings }`, experimental in `PROTOCOL_CLI_VERSION`
 * and only accepted from a client that set `experimentalApi` in its
 * `initialize` (the handshake does). In `plan` the CLI gives the model its own
 * plan-mode instructions (`developer_instructions: null` asks for the built-in
 * ones), the model reads but does not change anything, and it hands its plan
 * over as a `plan` item — streamed by `item/plan/delta`, whole on
 * `item/completed` — before the turn ends.
 *
 * The mode is a setting of the thread, not of the one turn: once a turn put
 * the thread in plan mode it stays there, and the mode carries a model and
 * an effort of its own. So from the first plan turn on, every turn names its
 * mode — `plan`, or `default` to leave it — with the turn's model and effort,
 * and a model switch never meets a mode still holding the old model. A
 * thread that was never put in a mode names none, as before plan mode
 * existed. A resumed thread's mode is not known — the previous process may
 * have left it in plan mode — so it names its mode on every turn too.
 *
 * `settings.model` is required: the thread's model, or — for a thread on the
 * CLI's default — the model `thread/start` or `thread/resume` resolved it to.
 * `reasoning_effort` is the turn's effort, or null for the model's own.
 *
 * Poseidon's side of the plan (`makePlanTracker`, read by the translator):
 * the item is the timeline's plan row (`translate/tools.ts`), and a turn that
 * ends `end_turn` with a plan item completed proposes the last one
 * (`turn.plan.proposed`), which raises the plan card. Nothing parks on the
 * card: accepting or revising is the server's next turn, as on every
 * connector, and `respondToPlan` has nothing to release.
 */

import type { Effort, InteractionMode } from "@poseidon/contracts/enums";

/** `turn/start`'s `collaborationMode`, as the app-server spells it. */
export interface CollaborationMode {
  readonly mode: InteractionMode;
  readonly settings: {
    readonly model: string;
    readonly reasoning_effort: Effort | null;
    readonly developer_instructions: null;
  };
}

/**
 * What `turn/start` names for a turn in `mode`: nothing for a default turn on
 * a thread that carries no mode (`carried` false — never put in one, and not
 * resumed), the mode otherwise.
 */
export const collaborationModeFor = (input: {
  readonly mode: InteractionMode;
  readonly carried: boolean;
  readonly model: string;
  readonly effort: Effort | undefined;
}): CollaborationMode | undefined => {
  if (input.mode === "default" && !input.carried) return undefined;
  return {
    mode: input.mode,
    settings: {
      model: input.model,
      reasoning_effort: input.effort ?? null,
      developer_instructions: null,
    },
  };
};

/** The plan a turn handed over, for `turn.plan.proposed`. */
export interface PlanTracker {
  /** A `plan` item completed with this markdown. */
  readonly completed: (markdown: string) => void;
  /** The turn ended: the plan to propose, if it handed one over; forgets it either way. */
  readonly take: () => string | undefined;
}

export const makePlanTracker = (): PlanTracker => {
  let plan: string | undefined;
  return {
    completed: (markdown) => {
      const trimmed = markdown.trim();
      if (trimmed !== "") plan = trimmed;
    },
    take: () => {
      const taken = plan;
      plan = undefined;
      return taken;
    },
  };
};
