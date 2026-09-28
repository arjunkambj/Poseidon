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

/** The picker's group header for every row this connector lists. */
export const MODEL_FAMILY = "Codex";

/**
 * The model's effort rungs that Poseidon knows, lowest first. The protocol's
 * effort is an open string, so a rung Poseidon has no name for is dropped
 * rather than guessed at.
 */
const effortsOf = (row: CodexModel): Array<Effort> => {
  const offered = new Set(row.supportedReasoningEfforts.map((option) => option.reasoningEffort));
  return EFFORT_ORDER.filter((effort) => offered.has(effort));
};

export const toModelOptions = (rows: ReadonlyArray<CodexModel>): ReadonlyArray<ModelOption> =>
  rows
    .filter((row) => !row.hidden && row.model !== "")
    .toSorted((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map((row) => ({
      id: row.model,
      label: row.displayName === "" ? row.model : row.displayName,
      family: MODEL_FAMILY,
      efforts: effortsOf(row),
      vision: row.inputModalities.includes("image"),
    }));
