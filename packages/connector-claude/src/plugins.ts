/**
 * Claude Code's own installed plugins, for the composer's `@` menu and the
 * Customize page. This is the `plugins` extension, and it only reads: the CLI
 * installs, enables and removes plugins, and nothing here writes to its
 * config. It reads files rather than running `claude plugin list`, so it
 * spawns nothing and works while the CLI is signed out.
 *
 * The files, as the CLI writes them (`fixtures/claude/plugins/`):
 *
 * - `<config>/plugins/installed_plugins.json`, `version: 2`: `plugins` maps
 *   `name@marketplace` to its installs, each `{ scope, installPath,
 *   projectPath? }`. A `project` or `local` install carries the project it
 *   belongs to.
 * - `enabledPlugins` in `<config>/settings.json`, overlaid for a project by
 *   its `.claude/settings.json` and then `.claude/settings.local.json`. A
 *   plugin no file names is enabled.
 * - `<installPath>/.claude-plugin/plugin.json`, whose `description` is shown.
 *
 * `<config>` is `CLAUDE_CONFIG_DIR` from the instance's environment — the
 * account the instance's sessions use — else `~/.claude`.
 */

import { readFile } from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ConnectorExtensionFailed } from "@poseidon/connector-sdk/extensions";
import type { ExtensionScope, PluginsExtension } from "@poseidon/connector-sdk/extensions";
import type { PluginSummary } from "@poseidon/contracts/connectors";
import * as Effect from "effect/Effect";

export interface ClaudePluginsOptions {
  /** The environment the instance's sessions run with (`childEnv`). */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Where the CLI keeps its config for this environment. */
export const claudeConfigDir = (env: Readonly<Record<string, string | undefined>>): string => {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (configured !== undefined && configured !== "") {
    return configured;
  }
  return NodePath.join(env.HOME ?? NodeOS.homedir(), ".claude");
};

/** One install of a plugin, as `installed_plugins.json` records it. */
interface PluginInstall {
  readonly scope: string;
  readonly installPath: string;
  readonly projectPath?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asInstall = (value: unknown): PluginInstall | null => {
  if (!isRecord(value) || typeof value.installPath !== "string" || value.installPath === "") {
    return null;
  }
  return {
    scope: typeof value.scope === "string" && value.scope !== "" ? value.scope : "user",
    installPath: value.installPath,
    ...(typeof value.projectPath === "string" ? { projectPath: value.projectPath } : {}),
  };
};

/** A file's text, or `null` when there is none to read. */
const readText = (path: string): Effect.Effect<string | null> =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(Effect.orElseSucceed(() => null));

/** A JSON document that may be missing or broken; either reads as `null`. */
const readJsonLenient = (path: string): Effect.Effect<unknown> =>
  Effect.map(readText(path), (text) => {
    if (text === null) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  });

/** The `enabledPlugins` overrides one settings file holds. */
const enabledOverrides = (path: string): Effect.Effect<ReadonlyMap<string, boolean>> =>
  Effect.map(readJsonLenient(path), (settings) => {
    const out = new Map<string, boolean>();
    if (isRecord(settings) && isRecord(settings.enabledPlugins)) {
      for (const [key, value] of Object.entries(settings.enabledPlugins)) {
        if (typeof value === "boolean") {
          out.set(key, value);
        }
      }
    }
    return out;
  });

/** `name@marketplace`, split at the last `@`; a bare name has no marketplace. */
const splitKey = (key: string): { readonly name: string; readonly marketplace?: string } => {
  const at = key.lastIndexOf("@");
  return at > 0 && at < key.length - 1
    ? { name: key.slice(0, at), marketplace: key.slice(at + 1) }
    : { name: key };
};

const samePath = (left: string, right: string): boolean =>
  NodePath.resolve(left) === NodePath.resolve(right);

export const makeClaudePlugins = (options: ClaudePluginsOptions): PluginsExtension => {
  const configDir = claudeConfigDir(options.env);
  const installedPath = NodePath.join(configDir, "plugins", "installed_plugins.json");

  /** Every install, by plugin key; `[]` when the file is missing or unknown. */
  const readInstalled = Effect.gen(function* () {
    const text = yield* readText(installedPath);
    if (text === null) {
      return [] as ReadonlyArray<readonly [string, ReadonlyArray<PluginInstall>]>;
    }
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (error) =>
        new ConnectorExtensionFailed({
          code: "internal",
          message: `could not read Claude Code's installed plugins (${installedPath}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
    });
    if (!isRecord(parsed) || parsed.version !== 2 || !isRecord(parsed.plugins)) {
      yield* Effect.logDebug(
        `claude plugins: ${installedPath} is not the version 2 layout; listing none`,
      );
      return [];
    }
    return Object.entries(parsed.plugins).map(
      ([key, installs]) =>
        [
          key,
          Array.isArray(installs)
            ? installs.flatMap((install) => {
                const read = asInstall(install);
                return read === null ? [] : [read];
              })
            : [],
        ] as const,
    );
  });

  /** A plugin's description from its own manifest, when it has one. */
  const describe = (installPath: string): Effect.Effect<string | undefined> =>
    Effect.map(
      readJsonLenient(NodePath.join(installPath, ".claude-plugin", "plugin.json")),
      (manifest) =>
        isRecord(manifest) && typeof manifest.description === "string" && manifest.description
          ? manifest.description
          : undefined,
    );

  const list = (scope: ExtensionScope) =>
    Effect.gen(function* () {
      const installed = yield* readInstalled;
      const settingsFiles = [NodePath.join(configDir, "settings.json")];
      if (scope.workspaceRoot !== null) {
        settingsFiles.push(
          NodePath.join(scope.workspaceRoot, ".claude", "settings.json"),
          NodePath.join(scope.workspaceRoot, ".claude", "settings.local.json"),
        );
      }
      // Later files win, the same order the CLI layers its settings in.
      const enabled = new Map<string, boolean>();
      for (const file of settingsFiles) {
        for (const [key, value] of yield* enabledOverrides(file)) {
          enabled.set(key, value);
        }
      }
      const out: Array<PluginSummary> = [];
      for (const [key, installs] of installed) {
        const { name, marketplace } = splitKey(key);
        if (name === "") {
          continue;
        }
        for (const install of installs) {
          // An install that belongs to a project shows in that project only.
          if (
            install.projectPath !== undefined &&
            (scope.workspaceRoot === null || !samePath(install.projectPath, scope.workspaceRoot))
          ) {
            continue;
          }
          const description = yield* describe(install.installPath);
          out.push({
            name,
            ...(description === undefined ? {} : { description }),
            ...(marketplace === undefined ? {} : { source: marketplace }),
            scope: install.scope,
            enabled: enabled.get(key) ?? true,
          });
        }
      }
      return out.sort((left, right) => left.name.localeCompare(right.name));
    });

  return { list };
};
