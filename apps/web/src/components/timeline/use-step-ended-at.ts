/**
 * When the live line's newest step finished, as this client saw it happen. A
 * snapshot carries no end time — only the start its UUIDv7 id records — so a
 * thought on the live line is timed by the moment its status left
 * `in_progress` on screen: "Thinking…", then "Thought for 4s". A step first
 * seen already finished (a thread opened after the fact) has no end: the label
 * falls back to its untimed form, and the settled fold times it against the
 * row that followed it (`fold.ts`).
 *
 * The same local-clock-against-id-time reading the working row's elapsed clock
 * makes; presentation state only.
 */

import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { useEffect, useState } from "react";

/** The step being watched, whether it was last seen running, and when it stopped. */
export interface StepClock {
  readonly id: string | undefined;
  readonly running: boolean;
  readonly endedAt: number | undefined;
}

/**
 * The clock after seeing step `id` in state `running` at `now`. The same
 * clock back when nothing changed, so the caller skips a render.
 */
export const tickStepClock = (
  clock: StepClock,
  id: string | undefined,
  running: boolean,
  now: number,
): StepClock => {
  if (clock.id !== id) {
    return { id, running, endedAt: undefined };
  }
  if (clock.running && !running) {
    return { id, running, endedAt: now };
  }
  return clock.running === running ? clock : { ...clock, running };
};

/** When `step` stopped running while on screen; undefined until then, or for no step. */
export const useStepEndedAt = (step: ItemSnapshot | undefined): number | undefined => {
  const id = step?.itemId;
  const running = step?.status === "in_progress";
  const [clock, setClock] = useState<StepClock>(() => ({ id, running, endedAt: undefined }));
  useEffect(() => {
    setClock((current) => tickStepClock(current, id, running, Date.now()));
  }, [id, running]);
  return clock.id === id ? clock.endedAt : undefined;
};
