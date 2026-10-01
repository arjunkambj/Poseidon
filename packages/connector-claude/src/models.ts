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
 *
 * Every label names a version. The CLI has two lists: its account's catalog,
 * whose names carry one ("Opus 5.5"), and the list compiled into the binary,
 * whose names do not ("Opus", "Fable"), which it answers with whenever the
 * catalog is not to hand (docs/claude-code-connector.md, "The probe"). A name
 * without a version gets the one the row runs as, from its `resolvedModel` or
 * from the description's leading "<Name> <version> ·"; the ids stay the CLI's,
 * since threads store them.
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

/**
 * A display name that already says which version it is. A parenthesised note
 * is not a version: "Opus (1M context)" names none.
 */
const hasVersion = (name: string): boolean => /\d/.test(name.replace(/\([^)]*\)/g, ""));

/** `claude-opus-5-5`, `claude-haiku-4-5-20251001`, `claude-opus-5` — with or without `[1m]`. */
const MODEL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/;

/** "Opus 5.5 · …", "Opus 5.5 with 1M context · …", "… (currently Opus 5.5 (1M context)) · …". */
const NAMED_IN_DESCRIPTION = /^(?:.*?\bcurrently )?([A-Z][a-z]+ \d+(?:\.\d+)?)\b/;

const RECOMMENDED = /\(recommended\)/i;

/** `claude-haiku-4-5-20251001` → `Haiku 4.5`; anything else → undefined. */
export const nameOfModelId = (id: string): string | undefined => {
  const match = MODEL_ID.exec(id);
  if (match === null) return undefined;
  const [, family, major, minor] = match;
  const name = family!.charAt(0).toUpperCase() + family!.slice(1);
  return `${name} ${major}${minor === undefined ? "" : `.${minor}`}`;
};

/** The model a row runs as, versioned: from its `resolvedModel`, else its description. */
const runsAs = (info: ClaudeModelInfo): string | undefined =>
  (info.resolvedModel === undefined ? undefined : nameOfModelId(info.resolvedModel)) ??
  NAMED_IN_DESCRIPTION.exec(info.description?.trim() ?? "")?.[1];

/**
 * The row's label: the CLI's name when it carries a version, else the name
 * with the version it runs as put after the family ("Opus (1M context)" →
 * "Opus 5.5 (1M context)"). `default` names what it runs as instead of the
 * CLI's "(recommended)", which `describe` keeps.
 */
const labelOf = (info: ClaudeModelInfo): string => {
  const name = info.displayName.trim() === "" ? info.value : info.displayName.trim();
  const versioned = runsAs(info);
  if (info.value === DEFAULT_MODEL) {
    return versioned === undefined ? name : `Default (${versioned})`;
  }
  if (hasVersion(name) || versioned === undefined) return name;
  const family = versioned.split(" ")[0]!;
  return name === family || name.startsWith(`${family} `)
    ? `${versioned}${name.slice(family.length)}`
    : name;
};

/**
 * The row's secondary text. The contract refuses an empty description, so a
 * blank one is left out — unless the label dropped the CLI's "(recommended)",
 * which then leads the description instead.
 */
const describe = (info: ClaudeModelInfo, label: string): string | undefined => {
  const description = info.description?.trim() ?? "";
  if (info.value !== DEFAULT_MODEL || label === info.displayName.trim()) {
    return description === "" ? undefined : description;
  }
  if (!RECOMMENDED.test(info.displayName)) return description === "" ? undefined : description;
  return description === "" ? "Recommended" : `Recommended · ${description}`;
};

/**
 * Whether this is the list compiled into the CLI rather than its account's
 * catalog: some row other than `default` names no version. Signed out the CLI
 * has no catalog to load, so only a signed-in answer of this shape is one to
 * ask again for.
 */
export const isCompiledList = (models: ReadonlyArray<ClaudeModelInfo>): boolean =>
  models.some(
    (info) => info.value !== "" && info.value !== DEFAULT_MODEL && !hasVersion(info.displayName),
  );

export const toModelOptions = (
  models: ReadonlyArray<ClaudeModelInfo>,
): ReadonlyArray<ModelOption> =>
  models
    .filter((info) => info.value !== "")
    .map((info) => {
      const label = labelOf(info);
      const description = describe(info, label);
      return {
        id: info.value,
        label,
        family: MODEL_FAMILY,
        efforts: effortsOf(info),
        ...(description === undefined ? {} : { description }),
      };
    });

/**
 * What the SDK's `model` option should be for a thread's model: nothing for
 * `default`, so the CLI picks its own, and the id otherwise.
 */
export const sdkModelFor = (model: string): string | undefined =>
  model === DEFAULT_MODEL ? undefined : model;
