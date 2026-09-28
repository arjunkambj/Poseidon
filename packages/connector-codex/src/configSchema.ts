/**
 * Codex's own settings document — what `settings.connectors[].config` holds
 * for an instance of this connector. The `settingsForm` annotations are the
 * form the connectors page renders for it, served over `connectors.describe`,
 * so nothing above this package spells it out.
 */

import { NonEmptyString } from "@poseidon/contracts/base";
import { settingsForm } from "@poseidon/contracts/settings";
import * as Schema from "effect/Schema";

/**
 * Codex's own knobs. `binaryPath` is empty until the user overrides the
 * probe. `codexHome` points one instance at a second account: the CLI keeps
 * its login, config and sessions under `CODEX_HOME` (`~/.codex` when unset),
 * so the connector sets that and never moves `HOME`. `defaultModel` is what a
 * new thread on this instance starts with when the app-wide default is unset.
 */
export const CodexConnectorConfig = Schema.Struct({
  binaryPath: Schema.optional(NonEmptyString).pipe(
    settingsForm({
      label: "Binary path",
      description: "Path to the codex binary. Leave empty to use the discovered one.",
      control: "path",
      placeholder: "codex",
    }),
  ),
  codexHome: Schema.optional(NonEmptyString).pipe(
    settingsForm({
      label: "Codex home",
      description:
        "CODEX_HOME — a separate Codex account for this instance. Leave empty to use ~/.codex. HOME is never changed.",
      control: "path",
      placeholder: "~/.codex",
    }),
  ),
  defaultModel: Schema.optional(NonEmptyString).pipe(
    settingsForm({
      label: "Default model",
      description: "Model new threads on this instance start with.",
      control: "select",
    }),
  ),
});
export type CodexConnectorConfig = typeof CodexConnectorConfig.Type;
