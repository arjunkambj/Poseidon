/**
 * The app-server's model catalogue, as the model picker reads it.
 *
 * The list comes from the CLI itself — `model/list` on the handshake — so it
 * follows the account: the rows, their names and their effort ladders are the
 * ones this CLI offers this user today (`fixtures/codex/probe/`).
 *
 * Rows the server marks `hidden` are left out, as its own picker leaves them
 * out. The row it marks `isDefault` goes first: a thread that names no model
 * runs on it, because a session leaves `model` out of `thread/start` and the
 * CLI picks its own.
 */

import { EFFORT_ORDER, type Effort } from "@poseidon/contracts/enums";
import type { ModelOption } from "@poseidon/contracts/connectors";

import type { CodexModel } from "./protocol";

/**
 * The model id that means "whatever the CLI's default is": a thread on it
 * names no model to `thread/start`, and its turns run on the model the CLI
 * opened the thread on. The recordings run on it, so they follow the
 * account's default rather than naming one.
 */
export const DEFAULT_MODEL = "default";

/** What `thread/start` names as the model: nothing for the default. */
export const codexModelFor = (model: string): string | undefined =>
  model === DEFAULT_MODEL ? undefined : model;

/** The picker's group header for every row this connector lists. */
export const MODEL_FAMILY = "Codex";

/** An effort Poseidon has a name for; the protocol's effort is an open string. */
export const toEffort = (value: unknown): Effort | undefined =>
  EFFORT_ORDER.find((effort) => effort === value);

/**
 * The model's effort rungs that Poseidon knows, lowest first. A rung Poseidon
 * has no name for is dropped rather than guessed at. `ultra` — "Maximum
 * reasoning with automatic task delegation", the rung above `max` — is kept
 * where the row lists it, so only those models offer it; the others never do.
 */
const effortsOf = (row: CodexModel): Array<Effort> => {
  const offered = new Set(row.supportedReasoningEfforts.map((option) => option.reasoningEffort));
  return EFFORT_ORDER.filter((effort) => offered.has(effort));
};

/** What a session needs of a model to choose a turn's effort. */
export interface CodexModelFacts {
  readonly efforts: ReadonlyArray<Effort>;
  /** The model's own effort (`defaultReasoningEffort`), when Poseidon names it. */
  readonly defaultEffort?: Effort;
}

/** Every row's efforts and default, hidden rows included: a thread may run on one. */
export const modelFactsOf = (
  rows: ReadonlyArray<CodexModel>,
): ReadonlyMap<string, CodexModelFacts> =>
  new Map(
    rows.map((row) => {
      const defaultEffort = toEffort(row.defaultReasoningEffort);
      return [
        row.model,
        { efforts: effortsOf(row), ...(defaultEffort === undefined ? {} : { defaultEffort }) },
      ];
    }),
  );

export const toModelOptions = (rows: ReadonlyArray<CodexModel>): ReadonlyArray<ModelOption> =>
  rows
    .filter((row) => !row.hidden && row.model !== "")
    .toSorted((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map((row) => {
      // The contract refuses an empty description, so a blank one is left out.
      const description = row.description?.trim() ?? "";
      return {
        id: row.model,
        label: row.displayName === "" ? row.model : row.displayName,
        family: MODEL_FAMILY,
        efforts: effortsOf(row),
        vision: row.inputModalities.includes("image"),
        ...(description === "" ? {} : { description }),
      };
    });
