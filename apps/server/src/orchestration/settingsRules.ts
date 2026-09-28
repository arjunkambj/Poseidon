/**
 * How a thread's settings change: the decider's ultracode rules and the fold
 * of `thread.settings.updated` onto the stored settings.
 *
 * Ultracode is Claude Code's `xhigh` effort plus standing dynamic-workflow
 * orchestration, and the stored settings keep to the rules of the harness's
 * own `apply_flag_settings` handler, so the header never shows a combination
 * the session is not in:
 *
 * - switching ultracode on sets the effort to `xhigh`;
 * - switching it off keeps the effort as it is;
 * - picking an effort without naming ultracode switches ultracode off.
 */

import type { Effort } from "@poseidon/contracts/enums";
import type { ThreadSettings, ThreadSettingsPatch } from "@poseidon/contracts/orchestration";

/** The effort ultracode runs at. */
const ULTRACODE_EFFORT: Effort = "xhigh";

/**
 * The effort and ultracode flag a new thread starts with, from the command's
 * patch (or a fork's) and the effort it would otherwise take. Only an
 * ultracode that is on is recorded; absent reads as off.
 */
export const createdEffortAndUltracode = (
  patch: ThreadSettingsPatch,
  effort: Effort | null | undefined,
): Pick<ThreadSettings, "effort" | "ultracode"> =>
  patch.ultracode === true
    ? { effort: ULTRACODE_EFFORT, ultracode: true }
    : effort === null || effort === undefined
      ? {}
      : { effort };

/**
 * The effort and ultracode fields a `thread.settings.updated` carries for an
 * update of `current`: the command's own, bent by the three rules above.
 */
export const updatedEffortAndUltracode = (
  command: Pick<ThreadSettingsPatch, "effort" | "ultracode">,
  current: Pick<ThreadSettings, "ultracode">,
): Pick<ThreadSettingsPatch, "effort" | "ultracode"> => {
  if (command.ultracode === true) {
    return { effort: ULTRACODE_EFFORT, ultracode: true };
  }
  const ultracode =
    command.ultracode ??
    (command.effort !== undefined && current.ultracode === true ? false : undefined);
  return {
    ...(command.effort === undefined ? {} : { effort: command.effort }),
    ...(ultracode === undefined ? {} : { ultracode }),
  };
};

/**
 * The settings after a `thread.settings.updated`: each field the payload
 * names, the stored one otherwise. The two optional fields are spread rather
 * than assigned, so a thread that never chose a connector or ultracode keeps
 * no key for it at all — which is every thread stored before either existed.
 */
export const patchSettings = (
  settings: ThreadSettings,
  payload: Record<string, unknown>,
): ThreadSettings => {
  const connectorInstanceId =
    (payload.connectorInstanceId as ThreadSettings["connectorInstanceId"]) ??
    settings.connectorInstanceId;
  const ultracode = (payload.ultracode as boolean | undefined) ?? settings.ultracode;
  return {
    model: (payload.model as string | undefined) ?? settings.model,
    effort:
      payload.effort === undefined ? settings.effort : (payload.effort as ThreadSettings["effort"]),
    runtimeMode: (payload.runtimeMode as ThreadSettings["runtimeMode"]) ?? settings.runtimeMode,
    interactionMode:
      (payload.interactionMode as ThreadSettings["interactionMode"]) ?? settings.interactionMode,
    ...(connectorInstanceId === undefined ? {} : { connectorInstanceId }),
    ...(ultracode === undefined ? {} : { ultracode }),
  };
};
