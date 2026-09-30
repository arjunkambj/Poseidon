/**
 * A thread's effort and ultracode flag, switched in a running session through
 * the SDK's `applyFlagSettings` — the flag settings layer, taken mid-session
 * in streaming-input mode (SDK 0.3.280).
 *
 * One switch is one call, whatever changed: `{ effortLevel }` for an effort,
 * `{ ultracode }` for the flag, both keys when both changed — and xhigh always
 * beside the flag going on. What CLI 2.1.286 does with each, read back
 * through its `get_settings` on a signed-in account:
 *
 * - `ultracode: true` sets the flag and leaves the effort where it was, so
 *   ultracode at low effort is what a flag alone gets; the effort the mode
 *   runs at has to be named;
 * - `ultracode: false` clears it with the effort kept;
 * - an `effortLevel` alone leaves the flag set, but below xhigh the CLI no
 *   longer applies it, so an effort pick that ends ultracode says
 *   `ultracode: false` beside it — the server's rules put it in the patch
 *   (`settingsRules.ts`).
 *
 * The settings the session then runs on are what `model.changed` reports:
 * xhigh once ultracode went on, and the effort and flag from before when the
 * CLI refused the call.
 */

import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import * as Effect from "effect/Effect";

import { sdkEffortFor, ULTRACODE_EFFORT } from "./queryOptions";

/**
 * The keys of the flag settings layer a switch writes. A type, not an
 * interface, so it fits the SDK's index-signed settings parameter.
 */
export type FlagSettings = {
  readonly effortLevel?: EffortLevel | null;
  readonly ultracode?: boolean;
};

const ultracodeOf = (settings: ThreadSettings): boolean => settings.ultracode === true;

/**
 * The one `applyFlagSettings` argument that moves the CLI from `before` to
 * `after`, or null when neither the effort nor the flag changed. An effort
 * the CLI has no rung for is `null`, its model's default. Ultracode going on
 * names xhigh whatever the thread's effort says, as the launch does.
 */
export const flagSettingsFor = (
  before: ThreadSettings,
  after: ThreadSettings,
): FlagSettings | null => {
  const effortChanged = after.effort !== before.effort;
  const ultracodeChanged = ultracodeOf(after) !== ultracodeOf(before);
  if (!effortChanged && !ultracodeChanged) return null;
  if (ultracodeChanged && ultracodeOf(after)) {
    return { effortLevel: ULTRACODE_EFFORT, ultracode: true };
  }
  return {
    ...(effortChanged ? { effortLevel: sdkEffortFor(after.effort) ?? null } : {}),
    ...(ultracodeChanged ? { ultracode: false } : {}),
  };
};

/** The effort and flag `settings` take from `source`, absence included. */
const withEffortAndFlag = (settings: ThreadSettings, source: ThreadSettings): ThreadSettings => {
  const { effort: _effort, ultracode: _ultracode, ...rest } = settings;
  return {
    ...rest,
    ...(source.effort === undefined ? {} : { effort: source.effort }),
    ...(source.ultracode === undefined ? {} : { ultracode: source.ultracode }),
  };
};

export interface FlagSwitch {
  /** The settings the CLI runs on after the switch. */
  readonly settings: ThreadSettings;
  /** Whether a call was made, taken or refused. */
  readonly switched: boolean;
  /** Whether the call named the flag, so `model.changed` says where it stands. */
  readonly ultracodeSwitched: boolean;
}

/**
 * The effort and flag switched with one call to `apply`, which answers
 * whether the CLI took it. Refused, the session keeps the effort and flag it
 * had; taken with ultracode going on, it runs at xhigh.
 */
export const switchFlags = (
  before: ThreadSettings,
  after: ThreadSettings,
  apply: (flags: FlagSettings) => Effect.Effect<boolean>,
): Effect.Effect<FlagSwitch> =>
  Effect.gen(function* () {
    const flags = flagSettingsFor(before, after);
    if (flags === null) return { settings: after, switched: false, ultracodeSwitched: false };
    const ultracodeSwitched = flags.ultracode !== undefined;
    if (!(yield* apply(flags))) {
      return { settings: withEffortAndFlag(after, before), switched: true, ultracodeSwitched };
    }
    const settings: ThreadSettings =
      flags.ultracode === true ? { ...after, effort: ULTRACODE_EFFORT } : after;
    return { settings, switched: true, ultracodeSwitched };
  });
