/**
 * The Poseidon plugins this server knows: the built-in ones the app ships
 * (written into `POSEIDON_HOME/builtin-plugins` at boot) and the global ones
 * the user put in `POSEIDON_HOME/plugins/<name>`.
 *
 * Both folders are rescanned on every call rather than cached. They are small,
 * and a rescan is what makes a plugin dropped into the folder show up without
 * a restart, and a switch flipped on the plugins page reach the very next
 * session a connector starts, never one already running.
 *
 * Whether a plugin is on lives in the settings document's `plugins` record,
 * keyed by plugin id, and only for a plugin the user switched: every other one
 * keeps its default (on). A plugin that failed validation is listed with its
 * error, is never on, and is never handed to a session.
 */

import { mkdir, readdir, stat } from "node:fs/promises";
import * as NodePath from "node:path";

import type { SessionPlugin } from "@poseidon/connector-sdk/plugins";
import type { ThreadId } from "@poseidon/contracts/ids";
import type { PluginSource, PluginsState } from "@poseidon/contracts/plugins";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import { builtinPluginsDir, pluginsDir } from "@poseidon/shared/paths";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { openInFileManager } from "../editors/EditorLauncher";
import { SettingsStore } from "../rpc/services";
import { materializeBuiltins } from "./builtin/materialize";
import { readPlugin, type LoadedPlugin } from "./manifest";

/** The built-in Browser plugin's id; its switch gates the in-app browser tools. */
export const BROWSER_PLUGIN_ID = "builtin:browser";

export interface PluginRegistryOptions {
  /** Where the built-in plugins were written at boot. */
  readonly builtinDir: string;
  /** Where global plugins live, one directory each. */
  readonly globalDir: string;
  /** Opens a folder in the file manager; the platform's own by default. */
  readonly openFolder?: (folder: string) => Effect.Effect<void, PoseidonRpcError>;
}

const failure = (code: PoseidonRpcError["code"], message: string) =>
  new PoseidonRpcError({ code, message });

/** Every plugin directory under `dir`, sorted, skipping dotfiles and plain files. */
const scan = (dir: string, source: PluginSource) =>
  Effect.promise(async (): Promise<ReadonlyArray<LoadedPlugin>> => {
    const entries = (await readdir(dir).catch(() => [] as Array<string>))
      .filter((entry) => !entry.startsWith("."))
      .sort();
    const found: Array<LoadedPlugin> = [];
    for (const entry of entries) {
      const path = NodePath.join(dir, entry);
      const info = await stat(path).catch(() => null);
      if (info?.isDirectory() === true) {
        found.push(await readPlugin(path, source));
      }
    }
    return found;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`could not scan the plugins in ${dir}`, cause).pipe(
        Effect.as([] as ReadonlyArray<LoadedPlugin>),
      ),
    ),
  );

export class PluginRegistry extends Context.Service<
  PluginRegistry,
  {
    /** Rescans both folders and answers every plugin, built-in first. */
    readonly list: Effect.Effect<PluginsState>;
    /**
     * Records the user's switch for one plugin in the settings document, so
     * `settings.subscribe` hears it, and answers the state after it.
     */
    readonly setEnabled: (
      pluginId: string,
      enabled: boolean,
    ) => Effect.Effect<PluginsState, PoseidonRpcError>;
    /** Creates the global plugins folder when missing and opens it in the file manager. */
    readonly openFolder: Effect.Effect<void, PoseidonRpcError>;
    /**
     * The enabled, valid plugins as a connector loads them, read afresh on
     * every call. Never fails: a scan that breaks answers none.
     */
    readonly sessionPlugins: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<SessionPlugin>>;
    /**
     * Whether the built-in Browser plugin is on. Read from the settings alone,
     * so it answers without touching the disk and is on when nothing says
     * otherwise.
     */
    readonly browserEnabled: Effect.Effect<boolean>;
    /**
     * Writes the plugins that ship with the app into the built-in folder. The
     * booted server calls it once; a failure is logged, never fatal.
     */
    readonly materializeBuiltins: Effect.Effect<void>;
  }
>()("server/plugins/PluginRegistry") {
  /** The registry over the given folders; tests point it at temporary ones. */
  static readonly layerAt = (options: PluginRegistryOptions) =>
    Layer.effect(
      PluginRegistry,
      Effect.gen(function* () {
        const settings = yield* SettingsStore;
        const writeMutex = yield* Semaphore.make(1);
        const openFolder = options.openFolder ?? openInFileManager;

        const loadAll = Effect.gen(function* () {
          const builtins = yield* scan(options.builtinDir, "builtin");
          const globals = yield* scan(options.globalDir, "global");
          const overrides = (yield* settings.get).plugins;
          return [...builtins, ...globals].map((loaded): LoadedPlugin => ({
            ...loaded,
            plugin: {
              ...loaded.plugin,
              enabled:
                loaded.plugin.error === undefined &&
                (overrides[loaded.plugin.pluginId] ?? loaded.plugin.enabled),
            },
          }));
        });

        const list = Effect.map(loadAll, (loaded): PluginsState => ({
          globalDir: options.globalDir,
          plugins: loaded.map((entry) => entry.plugin),
        }));

        return PluginRegistry.of({
          list,
          materializeBuiltins: Effect.promise(() => materializeBuiltins(options.builtinDir)).pipe(
            Effect.ignoreCause({
              log: "Warn",
              message: `could not write the built-in plugins into ${options.builtinDir}`,
            }),
          ),
          setEnabled: (pluginId, enabled) =>
            writeMutex.withPermits(1)(
              Effect.gen(function* () {
                const found = (yield* loadAll).find((entry) => entry.plugin.pluginId === pluginId);
                if (found === undefined) {
                  return yield* failure("not-found", `unknown plugin ${pluginId}`);
                }
                if (enabled && found.plugin.error !== undefined) {
                  return yield* failure(
                    "invalid",
                    `${found.plugin.name} cannot be turned on: ${found.plugin.error}`,
                  );
                }
                const current = (yield* settings.get).plugins;
                yield* settings
                  .update({ plugins: { ...current, [pluginId]: enabled } })
                  .pipe(
                    Effect.mapError(() => failure("internal", "could not save the plugin setting")),
                  );
                return yield* list;
              }),
            ),
          openFolder: Effect.tryPromise({
            try: () => mkdir(options.globalDir, { recursive: true }),
            catch: () => failure("internal", "could not create the plugins folder"),
          }).pipe(Effect.andThen(openFolder(options.globalDir))),
          sessionPlugins: (_threadId) =>
            Effect.map(loadAll, (loaded) => {
              const plugins: Array<SessionPlugin> = [];
              for (const { plugin, session } of loaded) {
                // Built-ins come first, so a global plugin that reuses a
                // built-in's name cannot shadow it inside a harness.
                if (
                  plugin.enabled &&
                  session !== null &&
                  plugins.every((known) => known.name !== session.name)
                ) {
                  plugins.push(session);
                }
              }
              return plugins;
            }),
          browserEnabled: Effect.map(settings.get, (doc) => doc.plugins[BROWSER_PLUGIN_ID] ?? true),
        });
      }),
    );

  /** The registry over `POSEIDON_HOME`'s folders, resolved when the layer is built. */
  static readonly layer = Layer.unwrap(
    Effect.sync(() =>
      PluginRegistry.layerAt({ builtinDir: builtinPluginsDir(), globalDir: pluginsDir() }),
    ),
  );

  /** No plugins at all, for tests that wire the handlers without a registry. */
  static readonly empty = Layer.succeed(
    PluginRegistry,
    PluginRegistry.of({
      list: Effect.succeed({ globalDir: "", plugins: [] }),
      setEnabled: (pluginId) => Effect.fail(failure("not-found", `unknown plugin ${pluginId}`)),
      openFolder: Effect.fail(failure("unavailable", "there is no plugins folder")),
      sessionPlugins: () => Effect.succeed([]),
      browserEnabled: Effect.succeed(true),
      materializeBuiltins: Effect.void,
    }),
  );
}
