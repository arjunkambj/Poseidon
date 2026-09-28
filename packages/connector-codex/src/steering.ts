/**
 * Steering: a message delivered into the turn that is running.
 *
 * The app-server takes it as `turn/steer { threadId, expectedTurnId, input }`.
 * The CLI adds the message to the running turn — it is read at the model's
 * next request, after whatever tool is running now finishes — and keeps the
 * turn: no new turn starts, and the turn's one `turn/completed` ends it once
 * the model has answered both messages. So the session draws no boundary for
 * a steer, and the turn's usage — how far the thread's token total moved
 * between the turn's start and its end (`translate/usage.ts`) — already covers
 * both answers. `steering` records it: a steer while a `sleep` ran, and the
 * one turn's answer naming the steered word.
 *
 * `expectedTurnId` is a precondition: the CLI refuses a steer when no turn is
 * active or another one is (`no active turn to steer`), and refuses one into a
 * turn that cannot take input — a compaction, or a review. Every refusal is
 * `NotSteerable`, which the server answers by queueing the message, so it is
 * never lost. The session refuses without asking when it knows already: no
 * turn is running, the running turn is stopping, or it is a compaction.
 */

import * as Schema from "effect/Schema";

/** What `turn/steer` answers: the turn the message went into. */
export const TurnSteerResponse = Schema.Struct({ turnId: Schema.String });

/** The running turn as far as steering cares. */
export interface SteerTarget {
  readonly interrupted: boolean;
  readonly compaction: boolean;
}

/** Why a steer is refused before the CLI is asked, or undefined when it may be tried. */
export const steerRefusal = (active: SteerTarget | null): string | undefined => {
  if (active === null) return "no turn is running";
  if (active.interrupted) return "the running turn is stopping";
  if (active.compaction) return "the running turn is a compaction, which takes no messages";
  return undefined;
};
