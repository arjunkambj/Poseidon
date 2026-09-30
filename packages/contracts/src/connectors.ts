/**
 * The connector-facing wire shapes: what the renderer learns about a
 * connector — its models, its probe, its configured instances, its metadata
 * and config form — and what the per-instance extensions list and edit
 * (skills, plugins, MCP servers). The RPCs that carry them are in `rpc.ts`.
 */

import * as Schema from "effect/Schema";

import { IsoDateTime, NonEmptyString, NonNegativeInt } from "./base";
import { Effort } from "./enums";
import { ConnectorInstanceId, ConnectorKind } from "./ids";
import { ConnectorCapabilities } from "./runtime";
import { SettingsFormControl } from "./settings";

/**
 * One entry in the model picker. `efforts` is the ladder this specific model
 * accepts, which is why `Effort` is a superset rather than a promise, and
 * `family` is the group header the connector's model list came under.
 */
export const ModelOption = Schema.Struct({
  id: NonEmptyString,
  label: NonEmptyString,
  family: NonEmptyString,
  efforts: Schema.Array(Effort),
  contextWindow: Schema.optional(NonNegativeInt),
  vision: Schema.optional(Schema.Boolean),
  free: Schema.optional(Schema.Boolean),
  /**
   * A model the connector lists but does not want offered by default. The
   * pickers leave it out until the user switches it on in Settings → Models.
   * Optional, so a payload recorded before it existed still decodes.
   */
  hidden: Schema.optional(Schema.Boolean),
  /**
   * The connector's one-line tagline for the model, e.g. "Pro-level coding
   * proficiency, parallel agentic execution". Secondary text only: the name is
   * always `label`. Optional, so a payload recorded before it existed still
   * decodes. A connector leaves it out rather than send "", which would fail
   * decoding of the whole model list.
   */
  description: Schema.optional(NonEmptyString),
});
export type ModelOption = typeof ModelOption.Type;

/**
 * What happened when the server last went looking for a connector's CLI. The
 * connectors page renders this directly, so the failure states are named rather
 * than folded into a message string.
 *
 * `installed` and `authenticated` are the two health facts the renderer reads
 * without knowing any harness: `installed` is absent only on the `probing`
 * stand-in and on a probe that never ran, and `authenticated` is absent when
 * the probe could not tell. `loginCommand` and `installCommand` are the shell
 * commands the connector itself names for fixing each — the renderer shows
 * them, and never spells one of its own.
 */
export const ConnectorProbe = Schema.Struct({
  status: Schema.Literals(["ready", "not-installed", "not-authenticated", "error", "probing"]),
  binaryPath: Schema.optional(NonEmptyString),
  version: Schema.optional(NonEmptyString),
  installed: Schema.optional(Schema.Boolean),
  authenticated: Schema.optional(Schema.Boolean),
  loginCommand: Schema.optional(NonEmptyString),
  installCommand: Schema.optional(NonEmptyString),
  /** Whether the harness reported usable credentials: present, absent, unknown. */
  auth: Schema.optional(Schema.Literals(["present", "absent", "unknown"])),
  /** The account the probe saw, e.g. the login email — for the settings page. */
  account: Schema.optional(Schema.String),
  /** How many models the probe reported — the settings page's "N models" line. */
  modelCount: Schema.optional(NonNegativeInt),
  /** A link that fixes what the probe found, e.g. the billing page on auth/credit failures. */
  helpUrl: Schema.optional(NonEmptyString),
  message: Schema.optional(Schema.String),
  probedAt: IsoDateTime,
});
export type ConnectorProbe = typeof ConnectorProbe.Type;

/**
 * Whether a probe leaves its harness able to run a turn, as far as the default
 * rule is concerned: a thread that chose no instance goes to the first enabled
 * one that can, on the server (`connectorRouting.ts`) and in the renderer
 * (`connector-routing.ts`) alike, so the two must read a probe the same way.
 *
 * Only a probe that says so rules a harness out: not installed, or signed out.
 * `probing` and anything the probe could not tell count as able, so the
 * default does not move while probes are still running. That includes an
 * `error` probe's `installed: false`: the connector manager writes it for a
 * probe that timed out or crashed, which found nothing either way, and a slow
 * machine must not route every new thread off an installed harness. Takes the
 * server's probe as well as the wire's, which share these fields.
 */
export const probeCanRun = (probe: {
  readonly status: ConnectorProbe["status"];
  readonly installed?: boolean;
  readonly auth?: ConnectorProbe["auth"];
}): boolean =>
  probe.status !== "not-installed" &&
  probe.status !== "not-authenticated" &&
  (probe.installed !== false || probe.status === "error") &&
  probe.auth !== "absent";

/** A configured connector as the settings page and the model picker see it. */
export const ConnectorSummary = Schema.Struct({
  connectorInstanceId: ConnectorInstanceId,
  kind: ConnectorKind,
  displayName: NonEmptyString,
  enabled: Schema.Boolean,
  capabilities: Schema.NullOr(ConnectorCapabilities),
  /** Which per-instance extensions the open instance carries; all false when not open. */
  extensions: Schema.Struct({
    skills: Schema.Boolean,
    plugins: Schema.Boolean,
    mcpServers: Schema.Boolean,
  }),
  probe: ConnectorProbe,
});
export type ConnectorSummary = typeof ConnectorSummary.Type;

/**
 * How a connector presents itself, from its own definition. `iconKey` is a
 * key the renderer maps to a logo or glyph it ships (`"claude-code"`,
 * `"terminal"`), falling back to a generic glyph for a key it does not know;
 * `accent` is a CSS colour; `docsUrl` is where the connector's own
 * documentation lives, and the fallback help link for a probe that failed on
 * the account.
 */
export const ConnectorMetadata = Schema.Struct({
  displayName: NonEmptyString,
  iconKey: NonEmptyString,
  accent: NonEmptyString,
  docsUrl: Schema.optional(NonEmptyString),
});
export type ConnectorMetadata = typeof ConnectorMetadata.Type;

/**
 * One field of a connector's config form, read off the `settingsForm`
 * annotation on its config schema (`settingsFormFields`). The schema itself
 * stays on the server; this is all the renderer needs to draw the form.
 */
export const ConnectorConfigField = Schema.Struct({
  key: NonEmptyString,
  label: NonEmptyString,
  description: Schema.optional(Schema.String),
  control: SettingsFormControl,
  placeholder: Schema.optional(Schema.String),
  optional: Schema.Boolean,
});
export type ConnectorConfigField = typeof ConnectorConfigField.Type;

/**
 * A connector this build ships, whether or not an instance of it is
 * configured: what the connectors page offers to add, and the form it renders
 * for an instance of that kind.
 */
export const ConnectorDescriptor = Schema.Struct({
  kind: ConnectorKind,
  metadata: ConnectorMetadata,
  configFields: Schema.Array(ConnectorConfigField),
});
export type ConnectorDescriptor = typeof ConnectorDescriptor.Type;

/** Where an MCP server entry is written in the harness's own config. */
export const McpServerScope = Schema.Literals(["user", "project"]);
export type McpServerScope = typeof McpServerScope.Type;

/**
 * One MCP server, in the shape a harness's `mcp.json` commonly stores. `${VAR}`
 * references in headers and env are resolved at spawn time, so a per-session
 * bearer never reaches disk.
 */
export const McpServerConfig = Schema.Struct({
  name: NonEmptyString,
  scope: McpServerScope,
  enabled: Schema.Boolean,
  /**
   * Read-side hint: `true` when the entry carries our `_poseidon` marker, so
   * the editor knows upsert/remove will be accepted. The server ignores it on
   * write — ownership is decided by the marker on disk, not by the payload.
   */
  managed: Schema.optional(Schema.Boolean),
  transport: Schema.Literals(["http", "stdio"]),
  url: Schema.optional(NonEmptyString),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  command: Schema.optional(NonEmptyString),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type McpServerConfig = typeof McpServerConfig.Type;

/** One skill found under the connector's skills directory. */
export const SkillSummary = Schema.Struct({
  name: NonEmptyString,
  path: NonEmptyString,
  description: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
});
export type SkillSummary = typeof SkillSummary.Type;

/**
 * A skill in the shared agents folder (`~/.agents/skills`) that the connector
 * does not load yet. `entry` is its directory or file name there — what a link
 * points at — and can differ from the frontmatter `name`.
 */
export const AgentSkill = Schema.Struct({
  entry: NonEmptyString,
  name: NonEmptyString,
  path: NonEmptyString,
  description: Schema.optional(Schema.String),
});
export type AgentSkill = typeof AgentSkill.Type;

/**
 * One plugin the harness has installed. `source` is where it came from (a
 * marketplace, a directory) and `scope` which level installed it (`user`,
 * `project`), both in the harness's own words; the renderer shows them as-is.
 */
export const PluginSummary = Schema.Struct({
  name: NonEmptyString,
  description: Schema.optional(Schema.String),
  source: Schema.optional(NonEmptyString),
  scope: Schema.optional(NonEmptyString),
  enabled: Schema.Boolean,
});
export type PluginSummary = typeof PluginSummary.Type;
