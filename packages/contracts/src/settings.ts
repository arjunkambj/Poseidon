/**
 * The persisted settings document and the defaults a fresh install starts from.
 *
 * Settings are server-owned: the renderer reads them over RPC and patches them
 * over RPC, so a change made in one window shows up in the other. Every field
 * the settings pages render carries a `settingsForm` key annotation describing
 * how to render it — label, help text, control — which keeps the form and the
 * schema from drifting apart as fields are added.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

import { IsoDateTime, NonEmptyString } from "./base";
import { DEFAULT_RUNTIME_MODE, Effort, RuntimeMode } from "./enums";
import { ConnectorInstanceId, ConnectorKind, ProjectId, ThreadId } from "./ids";
import { ProjectScript } from "./scripts";

/** Every control a settings field can be rendered with. `hidden` renders nothing. */
export const SettingsFormControl = Schema.Literals([
  "text",
  "path",
  "select",
  "toggle",
  "keyValue",
  "shortcut",
  "hidden",
]);
export type SettingsFormControl = typeof SettingsFormControl.Type;

/** How one settings field is presented. Read by the settings pages, never by the server. */
export interface SettingsFormField {
  readonly label: string;
  readonly description?: string;
  readonly control: SettingsFormControl;
  readonly placeholder?: string;
}

/**
 * Attaches a `settingsForm` annotation to the field a schema is used as. The
 * returned function stays generic so that piping through it preserves the
 * schema's own type, optionality included. Exported so a connector package can
 * annotate its own config schema the same way the documents here are.
 */
export const settingsForm =
  (field: SettingsFormField) =>
  <S extends Schema.Top>(self: S): S["Rebuild"] =>
    self.annotateKey({ settingsForm: field });

/**
 * One annotated field of a struct, read off its `settingsForm` annotation:
 * what a form needs to render it without holding the schema. `optional` says
 * the key may be absent, which is how a form knows that clearing it removes the
 * key rather than writing an empty value.
 */
export interface SettingsFormFieldDescriptor extends SettingsFormField {
  readonly key: string;
  readonly optional: boolean;
}

/**
 * Every field of `struct` that carries a `settingsForm` annotation, in
 * declaration order, hidden ones included — the renderer skips those. A field
 * with no annotation is left out: nothing says how to render it.
 */
export const settingsFormFields = (struct: {
  readonly fields: Schema.Struct.Fields;
}): ReadonlyArray<SettingsFormFieldDescriptor> =>
  Object.entries(struct.fields).flatMap(([key, field]) => {
    const form = Schema.resolveAnnotationsKey(field)?.["settingsForm"] as
      | SettingsFormField
      | undefined;
    if (form === undefined) {
      return [];
    }
    return [
      {
        key,
        label: form.label,
        ...(form.description === undefined ? {} : { description: form.description }),
        control: form.control,
        ...(form.placeholder === undefined ? {} : { placeholder: form.placeholder }),
        optional: SchemaAST.isOptional(field.ast),
      },
    ];
  });

// ── Connector configuration ────────────────────────────────────

/**
 * One configured connector. `config` is the connector's own settings document,
 * unmodelled here so that adding a connector does not widen this union — the
 * connector's definition owns its schema, validates it on load, and describes
 * its form over `connectors.describe`.
 */
export const ConnectorInstanceConfig = Schema.Struct({
  connectorInstanceId: ConnectorInstanceId.pipe(
    settingsForm({ label: "Instance id", control: "hidden" }),
  ),
  kind: ConnectorKind.pipe(
    settingsForm({
      label: "Connector",
      description: "Which harness this instance runs.",
      control: "select",
    }),
  ),
  displayName: NonEmptyString.pipe(
    settingsForm({
      label: "Name",
      description: "How this instance is listed in the model picker.",
      control: "text",
    }),
  ),
  enabled: Schema.Boolean.pipe(
    settingsForm({
      label: "Enabled",
      description: "Disabled instances stay configured but start no sessions.",
      control: "toggle",
    }),
  ),
  config: Schema.Unknown.pipe(settingsForm({ label: "Connector settings", control: "hidden" })),
});
export type ConnectorInstanceConfig = typeof ConnectorInstanceConfig.Type;

// ── Permissions ────────────────────────────────────────────────

/** How far a permission rule reaches. */
export const PermissionScope = Schema.Literals(["global", "project", "session"]);
export type PermissionScope = typeof PermissionScope.Type;

/**
 * One persisted permission rule, in Poseidon's pattern vocabulary
 * (`Shell(npm run *)`, `Edit(/src/**)`, `Mcp(github.*)`; see
 * `@poseidon/shared/permissionPattern`). Deny wins over
 * ask, ask wins over allow, so a rule can only ever be made stricter by adding
 * another one. `projectId` and `threadId` narrow the rule to its scope.
 */
export const PermissionRule = Schema.Struct({
  scope: PermissionScope.pipe(
    settingsForm({
      label: "Scope",
      description: "Where this rule applies.",
      control: "select",
    }),
  ),
  projectId: Schema.optional(ProjectId).pipe(settingsForm({ label: "Project", control: "hidden" })),
  threadId: Schema.optional(ThreadId).pipe(settingsForm({ label: "Thread", control: "hidden" })),
  pattern: NonEmptyString.pipe(
    settingsForm({
      label: "Pattern",
      description: "A pattern, e.g. Shell(git push *), Edit(/src/**) or Mcp(github.*).",
      control: "text",
      placeholder: "Shell(npm run *)",
    }),
  ),
  decision: Schema.Literals(["allow", "deny"]).pipe(
    settingsForm({ label: "Decision", control: "select" }),
  ),
  createdAt: IsoDateTime.pipe(settingsForm({ label: "Created", control: "hidden" })),
});
export type PermissionRule = typeof PermissionRule.Type;

// ── Keybindings ────────────────────────────────────────────────

/**
 * One shortcut. `command` is the action id the renderer dispatches; `shortcut`
 * is the chord in the table's own notation (`Mod+Shift+B`, where `Mod` is Cmd on
 * macOS and Ctrl elsewhere, and `Cmd` is accepted as an alias of it),
 * normalised per platform at the point of use. `when` narrows a binding to a context, the way
 * VS Code's `when` clauses do. In the stored document a `-X` command unbinds
 * `X`; the defaults and how overrides layer on them live in `./keybindings`.
 */
export const Keybinding = Schema.Struct({
  command: NonEmptyString.pipe(settingsForm({ label: "Command", control: "hidden" })),
  shortcut: NonEmptyString.pipe(settingsForm({ label: "Shortcut", control: "shortcut" })),
  when: Schema.optional(NonEmptyString).pipe(
    settingsForm({
      label: "When",
      description: "Context this binding applies in.",
      control: "text",
    }),
  ),
});
export type Keybinding = typeof Keybinding.Type;

/**
 * What `Settings.keybindings` holds. `"overrides"` is the user's changes on top
 * of the shipped defaults; an absent marker is a document written before that,
 * whose table is the whole keymap and is migrated on load.
 */
const KeybindingsFormat = Schema.Literal("overrides");

// ── Git and worktrees ──────────────────────────────────────────

/** What a thread's worktree branch starts with unless the user says otherwise. */
export const DEFAULT_BRANCH_PREFIX = "poseidon/";

/**
 * How Poseidon names the branches it cuts. A new worktree's branch is
 * `branchPrefix` followed by a slug of the thread's first message; the prefix
 * may hold `/` (`poseidon/`, `me/`) or be empty.
 */
export const GitSettings = Schema.Struct({
  branchPrefix: Schema.String.pipe(
    settingsForm({
      label: "Branch prefix",
      description: "Put in front of every branch a new worktree is created on.",
      control: "text",
      placeholder: DEFAULT_BRANCH_PREFIX,
    }),
  ),
});
export type GitSettings = typeof GitSettings.Type;

/**
 * One project's own settings. `setupScript` runs with `/bin/sh` in every new
 * worktree of the project — `pnpm install`, copying an `.env` — and is only
 * ever read from here, never taken from a client. `scripts` are the ones the
 * Run button offers, edited from its menu rather than a settings page.
 */
export const ProjectSettings = Schema.Struct({
  setupScript: Schema.optional(Schema.String).pipe(
    settingsForm({
      label: "Setup script",
      description: "Runs in each new worktree of this project, before the first turn.",
      control: "text",
      placeholder: "pnpm install",
    }),
  ),
  scripts: Schema.optional(Schema.Array(ProjectScript)).pipe(
    settingsForm({ label: "Scripts", control: "hidden" }),
  ),
});
export type ProjectSettings = typeof ProjectSettings.Type;

// ── The document ───────────────────────────────────────────────

/** Follow the OS, or pin one appearance. */
export const Theme = Schema.Literals(["system", "light", "dark"]);
export type Theme = typeof Theme.Type;

/**
 * A region's base text size in px, in half-px steps. Every text step in that
 * region scales by `size / DEFAULT_FONT_SIZE`, and so does the spacing unit, so
 * icons, row heights and padding grow with the text.
 */
export const MIN_FONT_SIZE = 11;
export const MAX_FONT_SIZE = 20;
export const DEFAULT_FONT_SIZE = 14;
export const FONT_SIZE_STEP = 0.5;
export const FontSize = Schema.Finite.check(
  Schema.isBetween({ minimum: MIN_FONT_SIZE, maximum: MAX_FONT_SIZE }),
  Schema.isMultipleOf(FONT_SIZE_STEP),
);
export type FontSize = typeof FontSize.Type;

/** How wide the thread column (timeline, composer, start screen) runs. */
export const ChatWidth = Schema.Literals(["comfortable", "wide", "full"]);
export type ChatWidth = typeof ChatWidth.Type;
export const DEFAULT_CHAT_WIDTH: ChatWidth = "comfortable";

/**
 * What a new thread starts with. `model` is null until a connector has been
 * probed and reported its models — writing a guessed model id here would make
 * the first turn fail in a way the user cannot read.
 */
export const SettingsDefaults = Schema.Struct({
  model: Schema.NullOr(NonEmptyString).pipe(
    settingsForm({
      label: "Default model",
      description: "Model new threads start with.",
      control: "select",
    }),
  ),
  effort: Effort.pipe(
    settingsForm({
      label: "Default effort",
      description: "Reasoning effort new threads start with, where the model accepts one.",
      control: "select",
    }),
  ),
  runtimeMode: RuntimeMode.pipe(
    settingsForm({
      label: "Default runtime mode",
      description: "How much a new thread may do before asking.",
      control: "select",
    }),
  ),
});
export type SettingsDefaults = typeof SettingsDefaults.Type;

/**
 * The in-app browser. The pane never opens by itself unless this says so: the
 * agent's first browser call creates the thread's tab hidden and the thread
 * header shows "Agent is using the browser — Show".
 */
export const BrowserSettings = Schema.Struct({
  openPaneOnAgentUse: Schema.Boolean.pipe(
    settingsForm({
      label: "Open the browser pane when the agent uses it",
      description:
        "Show the thread's browser as soon as the agent starts using it. A pane you close stays closed.",
      control: "toggle",
    }),
  ),
});
export type BrowserSettings = typeof BrowserSettings.Type;

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = { openPaneOnAgentUse: false };

const toggle = (label: string, description: string) =>
  Schema.Boolean.pipe(settingsForm({ label, description, control: "toggle" }));

/**
 * Attention: which thread transitions post a system notification, whether they
 * play a sound, the Dock badge counting threads that need you, and holding the
 * machine awake while an agent runs.
 */
export const NotificationSettings = Schema.Struct({
  finished: toggle(
    "When a thread finishes",
    "Notify when a thread you are not looking at finishes.",
  ),
  failed: toggle("When a thread fails", "Notify when a thread you are not looking at fails."),
  needsYou: toggle(
    "When a thread needs you",
    "Notify when a thread waits on an approval, a question or a ready plan.",
  ),
  sound: toggle("Play a sound", "A short sound with each notification."),
  dockBadge: toggle("Show a badge on the Dock icon", "Count the threads that need you."),
  keepAwake: toggle(
    "Keep the Mac awake while agents run",
    "Stop the machine sleeping while any thread is running.",
  ),
});
export type NotificationSettings = typeof NotificationSettings.Type;

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  finished: true,
  failed: true,
  needsYou: true,
  sound: false,
  dockBadge: true,
  keepAwake: true,
};

export const Settings = Schema.Struct({
  connectors: Schema.Array(ConnectorInstanceConfig).pipe(
    settingsForm({ label: "Connectors", control: "hidden" }),
  ),
  defaults: SettingsDefaults.pipe(settingsForm({ label: "Defaults", control: "hidden" })),
  theme: Theme.pipe(
    settingsForm({ label: "Theme", description: "Appearance.", control: "select" }),
  ),
  // The font sizes are defaulted on decode: rows written before they existed
  // would otherwise fail to decode and be served as defaults.
  mainFontSize: FontSize.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_FONT_SIZE)),
    settingsForm({
      label: "Main font size",
      description: "Text size in the thread and everywhere outside the sidebars.",
      control: "select",
    }),
  ),
  sidebarFontSize: FontSize.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_FONT_SIZE)),
    settingsForm({
      label: "Sidebar font size",
      description: "Text size in the left sidebar and the right dock.",
      control: "select",
    }),
  ),
  // Defaulted on decode like the font sizes: rows written before it existed
  // still decode, at today's width.
  chatWidth: ChatWidth.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_CHAT_WIDTH)),
    settingsForm({
      label: "Chat width",
      description: "How wide the thread and composer column runs.",
      control: "hidden",
    }),
  ),
  // The user's overrides, layered on `DEFAULT_KEYBINDINGS` — never a copy of
  // them, or a default added later would not reach this install.
  keybindings: Schema.Array(Keybinding).pipe(
    settingsForm({ label: "Keybindings", control: "hidden" }),
  ),
  keybindingsFormat: Schema.optional(KeybindingsFormat).pipe(
    settingsForm({ label: "Keybindings format", control: "hidden" }),
  ),
  permissions: Schema.Array(PermissionRule).pipe(
    settingsForm({ label: "Permission rules", control: "hidden" }),
  ),
  // Defaulted on decode like the font sizes: rows written before these fields
  // existed must still decode, not fall back to the whole default document.
  git: GitSettings.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({ branchPrefix: DEFAULT_BRANCH_PREFIX })),
    settingsForm({ label: "Git", control: "hidden" }),
  ),
  /** Keyed by project id. A project with nothing configured has no entry. */
  projectSettings: Schema.Record(Schema.String, ProjectSettings).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
    settingsForm({ label: "Project settings", control: "hidden" }),
  ),
  // Defaulted on decode, like the font sizes: a row written before it existed
  // still decodes, with the pane kept closed.
  browser: BrowserSettings.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_BROWSER_SETTINGS)),
    settingsForm({ label: "Browser", control: "hidden" }),
  ),
  // Defaulted on decode like `browser`: older rows get the defaults.
  notifications: NotificationSettings.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_NOTIFICATION_SETTINGS)),
    settingsForm({ label: "Notifications", control: "hidden" }),
  ),
  // The editor the thread header's "Open in" button opens, picked from its
  // menu. A plain string rather than `EditorId`, so a stored id a later build
  // drops still decodes; the client treats an id it does not know as unset.
  preferredEditor: Schema.optional(Schema.String).pipe(
    settingsForm({ label: "Preferred editor", control: "hidden" }),
  ),
});
export type Settings = typeof Settings.Type;

/** A partial settings update. Absent fields are left as they are. */
export const SettingsPatch = Schema.Struct({
  connectors: Schema.optional(Schema.Array(ConnectorInstanceConfig)),
  defaults: Schema.optional(SettingsDefaults),
  theme: Schema.optional(Theme),
  mainFontSize: Schema.optional(FontSize),
  sidebarFontSize: Schema.optional(FontSize),
  chatWidth: Schema.optional(ChatWidth),
  keybindings: Schema.optional(Schema.Array(Keybinding)),
  permissions: Schema.optional(Schema.Array(PermissionRule)),
  git: Schema.optional(GitSettings),
  projectSettings: Schema.optional(Schema.Record(Schema.String, ProjectSettings)),
  browser: Schema.optional(BrowserSettings),
  notifications: Schema.optional(NotificationSettings),
  preferredEditor: Schema.optional(Schema.String),
});
export type SettingsPatch = typeof SettingsPatch.Type;

/**
 * The document a fresh install writes. No connectors are configured yet, so no
 * model is chosen, and the runtime mode is the one that asks before acting.
 * No keybinding is overridden, so every shipped default applies.
 */
export const defaultSettings = (): Settings => ({
  connectors: [],
  defaults: { model: null, effort: "medium", runtimeMode: DEFAULT_RUNTIME_MODE },
  theme: "system",
  mainFontSize: DEFAULT_FONT_SIZE,
  sidebarFontSize: DEFAULT_FONT_SIZE,
  chatWidth: DEFAULT_CHAT_WIDTH,
  keybindings: [],
  keybindingsFormat: "overrides",
  permissions: [],
  git: { branchPrefix: DEFAULT_BRANCH_PREFIX },
  projectSettings: {},
  browser: DEFAULT_BROWSER_SETTINGS,
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
});
