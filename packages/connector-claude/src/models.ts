/**
 * The CLI's model list, as the model picker reads it.
 *
 * The list comes from the CLI itself — the `models` of the SDK's
 * initialization result, which is what `supportedModels()` returns too — so it
 * follows the account: the rows, their names and their effort ladders are the
 * ones this CLI offers this user today (`fixtures/claude/probe/`).
 *
 * The first row is the CLI's own `default`, whose description says which model
 * it currently stands for. It is kept as a model of its own: a thread on
 * `default` follows whatever the CLI's default is, and a session for it
 * leaves the SDK's `model` option out entirely rather than naming a model.
 */

import { EFFORT_ORDER, type Effort } from "@poseidon/contracts/enums";
import type { ModelOption } from "@poseidon/contracts/connectors";

/** The model id that means "whatever the CLI's default is". */
export const DEFAULT_MODEL = "default";

/** The picker's group header for every row this connector lists. */
export const MODEL_FAMILY = "Claude";

/** The fields of the SDK's `ModelInfo` this reads. */
export interface ClaudeModelInfo {
  readonly value: string;
  readonly displayName: string;
  /** The CLI's one-line tagline for the row, shown as secondary text. */
  readonly description?: string;
  readonly resolvedModel?: string;
  readonly supportedEffortLevels?: ReadonlyArray<string>;
}

/** The model's effort rungs that Poseidon knows, lowest first. */
const effortsOf = (info: ClaudeModelInfo): Array<Effort> => {
  const offered = new Set(info.supportedEffortLevels ?? []);
  return EFFORT_ORDER.filter((effort) => offered.has(effort));
};

export const toModelOptions = (
  models: ReadonlyArray<ClaudeModelInfo>,
): ReadonlyArray<ModelOption> =>
  models
    .filter((info) => info.value !== "")
    .map((info) => {
      // The contract refuses an empty description, so a blank one is left out.
      const description = info.description?.trim() ?? "";
      return {
        id: info.value,
        label: info.displayName === "" ? info.value : info.displayName,
        family: MODEL_FAMILY,
        efforts: effortsOf(info),
        ...(description === "" ? {} : { description }),
      };
    });

/**
 * What the SDK's `model` option should be for a thread's model: nothing for
 * `default`, so the CLI picks its own, and the id otherwise.
 */
export const sdkModelFor = (model: string): string | undefined =>
  model === DEFAULT_MODEL ? undefined : model;
