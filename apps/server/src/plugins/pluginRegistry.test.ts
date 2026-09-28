/**
 * The registry over temporary built-in and global folders and an in-memory
 * settings store: what it lists, what a switch persists, and what a session
 * is handed.
 */

import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { makeThreadId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { runMigrations } from "../persistence/Migrations";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { SettingsStore } from "../rpc/services";
import { BROWSER_PLUGIN_ID, PluginRegistry } from "./PluginRegistry";

const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};

const skill = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill\n---\n`;

/** A built-in `browser`, a valid global `alpha`, a broken global `broken`, and noise. */
const makeFolders = () => {
  const root = mkdtempSync(join(tmpdir(), "poseidon-registry-"));
  const builtinDir = join(root, "builtin-plugins");
  const globalDir = join(root, "plugins");
  write(builtinDir, {
    "browser/.claude-plugin/plugin.json": JSON.stringify({ name: "browser" }),
    "browser/skills/browser/SKILL.md": skill("browser"),
  });
  write(globalDir, {
    "alpha/.claude-plugin/plugin.json": JSON.stringify({ name: "alpha", description: "A" }),
    "alpha/skills/one/SKILL.md": skill("one"),
    "alpha/.mcp.json": JSON.stringify({ srv: { command: "${CLAUDE_PLUGIN_ROOT}/srv" } }),
    "broken/.claude-plugin/plugin.json": "{",
    ".hidden/.claude-plugin/plugin.json": JSON.stringify({ name: "hidden" }),
    "stray-file.txt": "not a plugin folder",
  });
  return { builtinDir, globalDir };
};

const registryAt = (folders: { builtinDir: string; globalDir: string }, opened?: Array<string>) =>
  Effect.gen(function* () {
    const sqlite = Layer.succeedContext(yield* Layer.build(sqliteTestLayer()));
    yield* runMigrations.pipe(Effect.provide(sqlite));
    const context = yield* Layer.build(
      PluginRegistry.layerAt({
        ...folders,
        openFolder: (folder) => Effect.sync(() => void opened?.push(folder)),
      }).pipe(Layer.provideMerge(SettingsStore.layer), Layer.provide(sqlite)),
    );
    return {
      registry: Context.get(context, PluginRegistry),
      settings: Context.get(context, SettingsStore),
    };
  });

describe("PluginRegistry", () => {
  it.effect("lists the built-in and global plugins, the invalid one with its error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folders = makeFolders();
        const { registry } = yield* registryAt(folders);

        const state = yield* registry.list;

        expect(state.globalDir).toBe(folders.globalDir);
        expect(
          state.plugins.map(({ pluginId, source, enabled }) => ({ pluginId, source, enabled })),
        ).toEqual([
          { pluginId: "builtin:browser", source: "builtin", enabled: true },
          { pluginId: "global:alpha", source: "global", enabled: true },
          { pluginId: "global:broken", source: "global", enabled: false },
        ]);
        expect(state.plugins[2]?.error).toMatch(/^invalid plugin\.json/);
      }),
    ),
  );

  it.effect("lists nothing when neither folder exists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), "poseidon-registry-"));
        const { registry } = yield* registryAt({
          builtinDir: join(root, "missing-a"),
          globalDir: join(root, "missing-b"),
        });

        expect((yield* registry.list).plugins).toEqual([]);
      }),
    ),
  );

  it.effect("persists a switch in the settings and flips enabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, settings } = yield* registryAt(makeFolders());

        const off = yield* registry.setEnabled("global:alpha", false);
        expect(off.plugins.find((plugin) => plugin.pluginId === "global:alpha")?.enabled).toBe(
          false,
        );
        expect((yield* settings.get).plugins).toEqual({ "global:alpha": false });

        yield* registry.setEnabled(BROWSER_PLUGIN_ID, false);
        expect(yield* registry.browserEnabled).toBe(false);
        expect((yield* settings.get).plugins).toEqual({
          "global:alpha": false,
          [BROWSER_PLUGIN_ID]: false,
        });

        const on = yield* registry.setEnabled("global:alpha", true);
        expect(on.plugins.find((plugin) => plugin.pluginId === "global:alpha")?.enabled).toBe(true);
      }),
    ),
  );

  it.effect("fails not-found for an unknown id and invalid for turning on a broken plugin", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry } = yield* registryAt(makeFolders());

        const unknown = yield* Effect.exit(registry.setEnabled("global:nope", true));
        expect(unknown).toEqual(Exit.fail(expect.objectContaining({ code: "not-found" })));
        const broken = yield* Effect.exit(registry.setEnabled("global:broken", true));
        expect(broken).toEqual(Exit.fail(expect.objectContaining({ code: "invalid" })));
      }),
    ),
  );

  it.effect("hands a session the enabled, valid plugins with resolved paths", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folders = makeFolders();
        const { registry } = yield* registryAt(folders);
        const threadId = makeThreadId();

        const all = yield* registry.sessionPlugins(threadId);
        expect(all.map((plugin) => plugin.name)).toEqual(["browser", "alpha"]);
        const alpha = all[1]!;
        expect(alpha.root).toBe(join(folders.globalDir, "alpha"));
        expect(alpha.skillsDirs).toEqual([join(folders.globalDir, "alpha", "skills")]);
        expect(alpha.mcpServers).toEqual([
          {
            name: "srv",
            transport: "stdio",
            command: join(folders.globalDir, "alpha", "srv"),
            args: [],
            env: {},
          },
        ]);

        yield* registry.setEnabled(BROWSER_PLUGIN_ID, false);
        const withoutBrowser = yield* registry.sessionPlugins(threadId);
        expect(withoutBrowser.map((plugin) => plugin.name)).toEqual(["alpha"]);
      }),
    ),
  );

  it.effect("picks up a plugin added after the registry was built", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folders = makeFolders();
        const { registry } = yield* registryAt(folders);

        write(folders.globalDir, { "late/skills/late/SKILL.md": skill("late") });

        const names = (yield* registry.sessionPlugins(makeThreadId())).map((plugin) => plugin.name);
        expect(names).toEqual(["browser", "alpha", "late"]);
      }),
    ),
  );

  it.effect("creates the global folder before opening it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), "poseidon-registry-"));
        const folders = { builtinDir: join(root, "b"), globalDir: join(root, "g", "plugins") };
        const opened: Array<string> = [];
        const { registry } = yield* registryAt(folders, opened);

        yield* registry.openFolder;

        expect(opened).toEqual([folders.globalDir]);
        expect(statSync(folders.globalDir).isDirectory()).toBe(true);
      }),
    ),
  );
});
