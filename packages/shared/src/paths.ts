import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Where Poseidon keeps everything it owns on disk: the SQLite database, the
 * generated Command Code hook script, the threads' git worktrees, the dev
 * connection file. `~/.poseidon` by default; set `POSEIDON_HOME` to point a test,
 * a sandbox or a second install somewhere else.
 */

export const CONFIG_DIR_NAME = ".poseidon";

export const POSEIDON_HOME_ENV = "POSEIDON_HOME";

type Env = Readonly<Record<string, string | undefined>>;

const defaultEnv = (): Env => globalThis.process?.env ?? {};

/** Absolute path of the Poseidon configuration directory. */
export const configDir = (env: Env = defaultEnv()): string => {
  const override = env[POSEIDON_HOME_ENV]?.trim();
  if (override !== undefined && override !== "") {
    return NodePath.resolve(override);
  }
  return NodePath.join(NodeOS.homedir(), CONFIG_DIR_NAME);
};

/** Joins `segments` onto the configuration directory. */
export const configPath = (segments: ReadonlyArray<string>, env: Env = defaultEnv()): string =>
  NodePath.join(configDir(env), ...segments);

/** The SQLite database the server owns. */
export const databasePath = (env: Env = defaultEnv()): string => configPath(["state.sqlite"], env);

/** Directory for generated executables, such as the Command Code hook script. */
export const binDir = (env: Env = defaultEnv()): string => configPath(["bin"], env);

/**
 * Where a thread's own git worktree is created:
 * `<worktreesDir>/<project slug>/<thread slug>`.
 */
export const worktreesDir = (env: Env = defaultEnv()): string => configPath(["worktrees"], env);

/** Dev-mode connection descriptor written by `apps/server` in dev mode. */
export const devConnectionPath = (env: Env = defaultEnv()): string =>
  configPath(["dev", "connection.json"], env);

/**
 * Global Poseidon plugins, one directory each in the Claude Code plugin layout:
 * `<pluginsDir>/<name>/.claude-plugin/plugin.json`, `skills/`, `.mcp.json`, ….
 */
export const pluginsDir = (env: Env = defaultEnv()): string => configPath(["plugins"], env);

/**
 * Where the server writes the plugins that ship with the app when it boots, so
 * a harness that loads a plugin directory can be handed one on disk.
 */
export const builtinPluginsDir = (env: Env = defaultEnv()): string =>
  configPath(["builtin-plugins"], env);
