import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DEFAULT_RUNTIME_MODE } from "./enums";
import {
  BrowserSettings,
  ConnectorInstanceConfig,
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_CHAT_WIDTH,
  DEFAULT_DIFF_VIEW_SETTINGS,
  DEFAULT_FONT_SIZE,
  DEFAULT_NOTIFICATION_SETTINGS,
  MAX_FONT_SIZE,
  PermissionRule,
  Settings,
  SettingsPatch,
  defaultSettings,
  settingsFormFields,
} from "./settings";

/** Every field of a struct, with the `settingsForm` annotation it carries. */
const formAnnotations = (struct: Schema.Struct<Schema.Struct.Fields>) =>
  Object.entries(struct.fields).map(([name, field]) => [
    name,
    field.ast.context?.annotations?.["settingsForm"],
  ]);

describe("defaultSettings", () => {
  it.effect("asks before acting, like DEFAULT_RUNTIME_MODE says", () =>
    Effect.gen(function* () {
      const settings = yield* Effect.sync(defaultSettings);
      expect(DEFAULT_RUNTIME_MODE).toBe("approval-required");
      expect(settings.defaults.runtimeMode).toBe("approval-required");
    }),
  );

  it.effect("is a valid Settings document", () =>
    Effect.gen(function* () {
      const settings = yield* Effect.sync(defaultSettings);
      const encoded = yield* Effect.sync(() => Schema.encodeUnknownSync(Settings)(settings));
      const decoded = yield* Effect.sync(() => Schema.decodeUnknownSync(Settings)(encoded));
      expect(decoded).toEqual(settings);
    }),
  );

  it.effect("overrides no keybinding, and says the table is overrides", () =>
    Effect.gen(function* () {
      const settings = yield* Effect.sync(defaultSettings);
      expect(settings.keybindings).toEqual([]);
      expect(settings.keybindingsFormat).toBe("overrides");
    }),
  );

  it.effect("configures no connector, so it names no model", () =>
    Effect.gen(function* () {
      const settings = yield* Effect.sync(defaultSettings);
      expect(settings.connectors).toEqual([]);
      expect(settings.defaults.model).toBeNull();
    }),
  );
});

describe("settingsForm annotations", () => {
  it.effect("cover every field the settings pages can reach", () =>
    Effect.gen(function* () {
      const structs = yield* Effect.succeed([
        ["Settings", Settings],
        ["ConnectorInstanceConfig", ConnectorInstanceConfig],
        ["PermissionRule", PermissionRule],
        ["BrowserSettings", BrowserSettings],
      ] as const);
      for (const [name, struct] of structs) {
        for (const [field, annotation] of formAnnotations(struct)) {
          expect(
            annotation,
            `${name}.${String(field)} has no settingsForm annotation`,
          ).toBeDefined();
        }
      }
    }),
  );

  it.effect("settingsFormFields reads them in declaration order, optionality included", () =>
    Effect.gen(function* () {
      const fields = yield* Effect.sync(() => settingsFormFields(ConnectorInstanceConfig));
      expect(fields.map((field) => [field.key, field.control, field.optional])).toEqual([
        ["connectorInstanceId", "hidden", false],
        ["kind", "select", false],
        ["displayName", "text", false],
        ["enabled", "toggle", false],
        ["config", "hidden", false],
      ]);
      expect(fields[2]).toEqual({
        key: "displayName",
        label: "Name",
        description: "How this instance is listed in the model picker.",
        control: "text",
        optional: false,
      });
      const rule = settingsFormFields(PermissionRule);
      expect(rule.find((field) => field.key === "projectId")?.optional).toBe(true);
      expect(rule.find((field) => field.key === "pattern")?.placeholder).toBe("Shell(npm run *)");
    }),
  );

  it.effect("settingsFormFields leaves out a field nothing says how to render", () =>
    Effect.gen(function* () {
      const fields = yield* Effect.sync(() =>
        settingsFormFields(Schema.Struct({ bare: Schema.String })),
      );
      expect(fields).toEqual([]);
    }),
  );

  it.effect("keeps the annotation out of the encoded document", () =>
    Effect.gen(function* () {
      const encoded = yield* Effect.sync(() =>
        Schema.encodeUnknownSync(Settings)(defaultSettings()),
      );
      expect(Object.keys(encoded as object).sort()).toEqual([
        "browser",
        "chatWidth",
        "connectors",
        "defaults",
        "diffView",
        "git",
        "keybindings",
        "keybindingsFormat",
        "mainFontSize",
        "notifications",
        "permissions",
        "plugins",
        "projectSettings",
        "sidebarFontSize",
        "theme",
      ]);
    }),
  );
});

describe("font sizes", () => {
  it.effect("default to 14 px when a stored document predates them", () =>
    Effect.gen(function* () {
      const {
        mainFontSize: _main,
        sidebarFontSize: _sidebar,
        ...older
      } = Schema.encodeUnknownSync(Settings)(defaultSettings()) as Record<string, unknown>;
      const decoded = yield* Schema.decodeUnknownEffect(Settings)(older);
      expect(decoded.mainFontSize).toBe(DEFAULT_FONT_SIZE);
      expect(decoded.sidebarFontSize).toBe(DEFAULT_FONT_SIZE);
    }),
  );

  it.effect("reject a size outside the px range", () =>
    Effect.gen(function* () {
      const tooBig = { ...defaultSettings(), mainFontSize: MAX_FONT_SIZE + 1 };
      const exit = yield* Effect.exit(Schema.decodeUnknownEffect(Settings)(tooBig));
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("accept half-px steps and reject anything finer", () =>
    Effect.gen(function* () {
      const half = { ...defaultSettings(), mainFontSize: 14.5 };
      const decoded = yield* Schema.decodeUnknownEffect(Settings)(half);
      expect(decoded.mainFontSize).toBe(14.5);
      const finer = { ...defaultSettings(), sidebarFontSize: 14.25 };
      const exit = yield* Effect.exit(Schema.decodeUnknownEffect(Settings)(finer));
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("chat width", () => {
  it.effect("defaults to comfortable when a stored document predates it", () =>
    Effect.gen(function* () {
      const { chatWidth: _width, ...older } = Schema.encodeUnknownSync(Settings)(
        defaultSettings(),
      ) as Record<string, unknown>;
      const decoded = yield* Schema.decodeUnknownEffect(Settings)(older);
      expect(DEFAULT_CHAT_WIDTH).toBe("comfortable");
      expect(decoded.chatWidth).toBe("comfortable");
    }),
  );

  it.effect("round-trips wide and full", () =>
    Effect.gen(function* () {
      for (const chatWidth of ["wide", "full"] as const) {
        const settings = { ...defaultSettings(), chatWidth };
        const encoded = Schema.encodeUnknownSync(Settings)(settings);
        const decoded = yield* Schema.decodeUnknownEffect(Settings)(encoded);
        expect(decoded.chatWidth).toBe(chatWidth);
      }
    }),
  );

  it.effect("rejects a width it does not know", () =>
    Effect.gen(function* () {
      const unknown = { ...defaultSettings(), chatWidth: "huge" };
      const exit = yield* Effect.exit(Schema.decodeUnknownEffect(Settings)(unknown));
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("decodes a patch that only sets it", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(SettingsPatch)({ chatWidth: "full" });
      expect(decoded).toEqual({ chatWidth: "full" });
    }),
  );
});

describe("git settings", () => {
  it.effect(
    "default to the poseidon/ prefix and no project settings when a row predates them",
    () =>
      Effect.gen(function* () {
        const {
          git: _git,
          projectSettings: _projects,
          ...older
        } = Schema.encodeUnknownSync(Settings)(defaultSettings()) as Record<string, unknown>;
        const decoded = yield* Schema.decodeUnknownEffect(Settings)(older);
        expect(decoded.git).toEqual({ branchPrefix: DEFAULT_BRANCH_PREFIX });
        expect(DEFAULT_BRANCH_PREFIX).toBe("poseidon/");
        expect(decoded.projectSettings).toEqual({});
      }),
  );

  it.effect("carry a project's setup script and an empty prefix through a round-trip", () =>
    Effect.gen(function* () {
      const settings = {
        ...defaultSettings(),
        git: { branchPrefix: "" },
        projectSettings: { "0199c0de-0001-7000-8000-000000000001": { setupScript: "pnpm i" } },
      };
      const encoded = Schema.encodeUnknownSync(Settings)(settings);
      const decoded = yield* Schema.decodeUnknownEffect(Settings)(encoded);
      expect(decoded).toEqual(settings);
    }),
  );

  it.effect("decode a project without saved scripts, and round-trip one with them", () =>
    Effect.gen(function* () {
      const projectId = "0199c0de-0001-7000-8000-000000000001";
      const stored = Schema.encodeUnknownSync(Settings)({
        ...defaultSettings(),
        projectSettings: { [projectId]: { setupScript: "pnpm i" } },
      });
      const older = yield* Schema.decodeUnknownEffect(Settings)(stored);
      expect(older.projectSettings[projectId]?.scripts).toBeUndefined();
      const settings = {
        ...defaultSettings(),
        projectSettings: {
          [projectId]: {
            scripts: [
              { id: "s1", name: "dev", command: "pnpm dev", primary: true },
              { id: "s2", name: "test", command: "pnpm test" },
            ],
          },
        },
      };
      const encoded = Schema.encodeUnknownSync(Settings)(settings);
      expect(yield* Schema.decodeUnknownEffect(Settings)(encoded)).toEqual(settings);
      const empty = Schema.decodeUnknownExit(SettingsPatch)({
        projectSettings: { [projectId]: { scripts: [{ id: "s1", name: "dev", command: "" }] } },
      });
      expect(empty._tag).toBe("Failure");
    }),
  );

  it.effect("hide both from the generic form: a page of their own renders them", () =>
    Effect.gen(function* () {
      const fields = yield* Effect.sync(() => settingsFormFields(Settings));
      const hidden = fields.filter((field) => field.control === "hidden").map((field) => field.key);
      expect(hidden).toContain("git");
      expect(hidden).toContain("projectSettings");
    }),
  );
});

describe("browser settings", () => {
  it.effect("keep the pane closed by default", () =>
    Effect.gen(function* () {
      const settings = yield* Effect.sync(defaultSettings);
      expect(settings.browser).toEqual({ openPaneOnAgentUse: false });
    }),
  );

  it.effect("decode a stored document that predates them as closed", () =>
    Effect.gen(function* () {
      const { browser: _browser, ...older } = Schema.encodeUnknownSync(Settings)(
        defaultSettings(),
      ) as Record<string, unknown>;
      const decoded = yield* Schema.decodeUnknownEffect(Settings)(older);
      expect(decoded.browser.openPaneOnAgentUse).toBe(false);
    }),
  );

  it.effect("round-trip through a patch", () =>
    Effect.gen(function* () {
      const patch = { browser: { openPaneOnAgentUse: true } };
      const encoded = yield* Schema.encodeUnknownEffect(SettingsPatch)(patch);
      const decoded = yield* Schema.decodeUnknownEffect(SettingsPatch)(
        JSON.parse(JSON.stringify(encoded)),
      );
      expect(decoded).toEqual(patch);
      const applied = yield* Schema.decodeUnknownEffect(Settings)({
        ...(Schema.encodeUnknownSync(Settings)(defaultSettings()) as object),
        ...decoded,
      });
      expect(applied.browser.openPaneOnAgentUse).toBe(true);
    }),
  );

  it.effect("reject a patch that is not a boolean", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Schema.decodeUnknownEffect(SettingsPatch)({ browser: { openPaneOnAgentUse: "yes" } }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("plugin overrides", () => {
  it.effect("override no plugin on a fresh install", () =>
    Effect.gen(function* () {
      const settings = yield* Effect.sync(defaultSettings);
      expect(settings.plugins).toEqual({});
    }),
  );

  it.effect("decode a stored document that predates them as no overrides", () =>
    Effect.gen(function* () {
      const { plugins: _plugins, ...older } = Schema.encodeUnknownSync(Settings)(
        defaultSettings(),
      ) as Record<string, unknown>;
      const decoded = yield* Schema.decodeUnknownEffect(Settings)(older);
      expect(decoded.plugins).toEqual({});
    }),
  );

  it.effect("round-trip through a patch", () =>
    Effect.gen(function* () {
      const patch = { plugins: { "builtin:browser": false, "global:notes": true } };
      const encoded = yield* Schema.encodeUnknownEffect(SettingsPatch)(patch);
      const decoded = yield* Schema.decodeUnknownEffect(SettingsPatch)(
        JSON.parse(JSON.stringify(encoded)),
      );
      expect(decoded).toEqual(patch);
      const applied = yield* Schema.decodeUnknownEffect(Settings)({
        ...(Schema.encodeUnknownSync(Settings)(defaultSettings()) as object),
        ...decoded,
      });
      expect(applied.plugins).toEqual(patch.plugins);
    }),
  );

  it.effect("reject an override that is not a boolean", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Schema.decodeUnknownEffect(SettingsPatch)({ plugins: { "builtin:browser": "off" } }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("diff view settings", () => {
  it.effect("start with both options off", () =>
    Effect.gen(function* () {
      const settings = yield* Effect.sync(defaultSettings);
      expect(settings.diffView).toEqual({ ignoreWhitespace: false, wrapLines: false });
    }),
  );

  it.effect("decode a stored document that predates them with the defaults", () =>
    Effect.gen(function* () {
      const { diffView: _diffView, ...older } = Schema.encodeUnknownSync(Settings)(
        defaultSettings(),
      ) as Record<string, unknown>;
      const decoded = yield* Schema.decodeUnknownEffect(Settings)(older);
      expect(decoded.diffView).toEqual(DEFAULT_DIFF_VIEW_SETTINGS);
    }),
  );

  it.effect("apply through a patch", () =>
    Effect.gen(function* () {
      const patch = { diffView: { ignoreWhitespace: true, wrapLines: true } };
      const decoded = yield* Schema.decodeUnknownEffect(SettingsPatch)(
        JSON.parse(JSON.stringify(patch)),
      );
      expect(decoded).toEqual(patch);
      const applied = yield* Schema.decodeUnknownEffect(Settings)({
        ...(Schema.encodeUnknownSync(Settings)(defaultSettings()) as object),
        ...decoded,
      });
      expect(applied.diffView).toEqual({ ignoreWhitespace: true, wrapLines: true });
    }),
  );

  it.effect("reject a patch that is not a boolean", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Schema.decodeUnknownEffect(SettingsPatch)({
          diffView: { ignoreWhitespace: "yes", wrapLines: false },
        }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("notification settings", () => {
  it.effect("notify on every transition, silently, with the badge and keep-awake on", () =>
    Effect.gen(function* () {
      const settings = yield* Effect.sync(defaultSettings);
      expect(settings.notifications).toEqual({
        finished: true,
        failed: true,
        needsYou: true,
        sound: false,
        dockBadge: true,
        keepAwake: true,
      });
    }),
  );

  it.effect("decode a stored document that predates them as the defaults", () =>
    Effect.gen(function* () {
      const { notifications: _notifications, ...older } = Schema.encodeUnknownSync(Settings)(
        defaultSettings(),
      ) as Record<string, unknown>;
      const decoded = yield* Schema.decodeUnknownEffect(Settings)(older);
      expect(decoded.notifications).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    }),
  );

  it.effect("round-trip through a patch", () =>
    Effect.gen(function* () {
      const patch = { notifications: { ...DEFAULT_NOTIFICATION_SETTINGS, sound: true } };
      const encoded = yield* Schema.encodeUnknownEffect(SettingsPatch)(patch);
      const decoded = yield* Schema.decodeUnknownEffect(SettingsPatch)(
        JSON.parse(JSON.stringify(encoded)),
      );
      expect(decoded).toEqual(patch);
      const applied = yield* Schema.decodeUnknownEffect(Settings)({
        ...(Schema.encodeUnknownSync(Settings)(defaultSettings()) as object),
        ...decoded,
      });
      expect(applied.notifications.sound).toBe(true);
    }),
  );

  it.effect("reject a patch that is not a boolean", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Schema.decodeUnknownEffect(SettingsPatch)({
          notifications: { ...DEFAULT_NOTIFICATION_SETTINGS, dockBadge: "yes" },
        }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("preferred editor", () => {
  it.effect("is unset on a fresh install and on a stored document that predates it", () =>
    Effect.gen(function* () {
      expect(defaultSettings().preferredEditor).toBeUndefined();
      const older = Schema.encodeUnknownSync(Settings)(defaultSettings()) as Record<
        string,
        unknown
      >;
      expect("preferredEditor" in older).toBe(false);
      const decoded = yield* Schema.decodeUnknownEffect(Settings)(older);
      expect(decoded.preferredEditor).toBeUndefined();
    }),
  );

  it.effect("round-trips, and keeps an id no build knows", () =>
    Effect.gen(function* () {
      for (const id of ["cursor", "an-editor-since-dropped"]) {
        const settings = { ...defaultSettings(), preferredEditor: id };
        const encoded = Schema.encodeUnknownSync(Settings)(settings);
        const decoded = yield* Schema.decodeUnknownEffect(Settings)(encoded);
        expect(decoded).toEqual(settings);
      }
    }),
  );

  it.effect("applies through a patch", () =>
    Effect.gen(function* () {
      const patch = yield* Schema.decodeUnknownEffect(SettingsPatch)({ preferredEditor: "zed" });
      const applied = yield* Schema.decodeUnknownEffect(Settings)({
        ...(Schema.encodeUnknownSync(Settings)(defaultSettings()) as object),
        ...patch,
      });
      expect(applied.preferredEditor).toBe("zed");
    }),
  );
});

describe("auto-done", () => {
  it.effect("is off on a fresh install and on a stored document that predates it", () =>
    Effect.gen(function* () {
      expect(defaultSettings().autoDoneAfterDays).toBeUndefined();
      const older = Schema.encodeUnknownSync(Settings)(defaultSettings()) as Record<
        string,
        unknown
      >;
      expect("autoDoneAfterDays" in older).toBe(false);
      const decoded = yield* Schema.decodeUnknownEffect(Settings)(older);
      expect(decoded.autoDoneAfterDays).toBeUndefined();
    }),
  );

  it.effect("applies through a patch, and a null patch turns it off", () =>
    Effect.gen(function* () {
      const base = Schema.encodeUnknownSync(Settings)(defaultSettings()) as object;
      const on = yield* Schema.decodeUnknownEffect(SettingsPatch)({ autoDoneAfterDays: 7 });
      const applied = yield* Schema.decodeUnknownEffect(Settings)({ ...base, ...on });
      expect(applied.autoDoneAfterDays).toBe(7);
      const off = yield* Schema.decodeUnknownEffect(SettingsPatch)({ autoDoneAfterDays: null });
      const cleared = yield* Schema.decodeUnknownEffect(Settings)({ ...applied, ...off });
      expect(cleared.autoDoneAfterDays).toBeNull();
    }),
  );

  it.effect("rejects zero, a negative or a fractional day count", () =>
    Effect.gen(function* () {
      for (const days of [0, -3, 1.5]) {
        const exit = yield* Effect.exit(
          Schema.decodeUnknownEffect(SettingsPatch)({ autoDoneAfterDays: days }),
        );
        expect(exit._tag, String(days)).toBe("Failure");
      }
    }),
  );
});
