/**
 * Poseidon's enabled plugins in a Codex session.
 *
 * A Poseidon plugin is a directory in the Claude Code plugin layout, which
 * Codex does not read, so it is not handed over whole. The server's registry
 * has already resolved what a session needs (`SessionPlugin`), and two parts
 * of it have a Codex counterpart:
 *
 * - **Skills.** Every plugin's skill directories go to the app-server with
 *   `skills/extraRoots/set`, once, after the handshake and before the thread
 *   opens, so the thread loads them beside the user's own. The CLI takes a
 *   directory of `<name>/SKILL.md` folders and a single skill folder alike;
 *   checked against 0.159.2's `skills/list`, which then lists the skill.
 * - **MCP servers.** They go in the `config` of `thread/start` (or of
 *   `thread/resume`, `thread/fork`), one dotted key per server,
 *   `mcp_servers.plugin-<plugin>-<server>`, for this thread only: nothing is
 *   written to `config.toml`, and nothing goes on the argv, where `ps` would
 *   show a header's or a variable's value. Dotted, because the CLI lays the
 *   thread's config over the argv's `-c` overrides key by key: a nested
 *   `mcp_servers` table replaced the one those overrides built, and the thread
 *   lost `poseidon` (checked on 0.159.2; `config.toml`'s servers, a layer
 *   below, survived). A dotted key sets its own server and nothing else. The
 *   thread starts them and reports each in `mcpServer/startupStatus/updated`
 *   beside `poseidon` (`plugin-skill`). The prefix keeps a plugin from ever
 *   taking over the `poseidon` entry, and each part is kept to the letters,
 *   digits, `-` and `_` the CLI allows in a server name, so a key holds no
 *   dot of its own.
 *
 * A plugin's hooks, commands and agents have no Codex counterpart and are not
 * loaded.
 */

import type { SessionMcpServer, SessionPlugin } from "@poseidon/connector-sdk/plugins";

/** The key a plugin's MCP server is registered under in the thread's config. */
export const pluginMcpKey = (plugin: string, server: string): string =>
  `plugin-${plugin}-${server}`.replace(/[^A-Za-z0-9_-]/g, "_");

/** Every enabled plugin's skill directories, once each, in the plugins' order. */
export const pluginSkillRoots = (plugins: ReadonlyArray<SessionPlugin>): ReadonlyArray<string> => [
  ...new Set(plugins.flatMap((plugin) => plugin.skillsDirs)),
];

/** One server as the CLI's `mcp_servers` table spells it; null when it names nothing to run. */
const codexMcpServerFor = (server: SessionMcpServer): Record<string, unknown> | null => {
  if (server.transport === "http") {
    return server.url === undefined
      ? null
      : {
          url: server.url,
          ...(server.headers === undefined ? {} : { http_headers: { ...server.headers } }),
        };
  }
  return server.command === undefined
    ? null
    : {
        command: server.command,
        ...(server.args === undefined ? {} : { args: [...server.args] }),
        ...(server.env === undefined ? {} : { env: { ...server.env } }),
      };
};

/**
 * The thread's `config` for the enabled plugins' MCP servers, one
 * `mcp_servers.<key>` entry each, or undefined when they have none; the
 * first of a repeated key wins.
 */
export const pluginThreadConfig = (
  plugins: ReadonlyArray<SessionPlugin>,
): Readonly<Record<string, Record<string, unknown>>> | undefined => {
  const servers: Record<string, Record<string, unknown>> = {};
  for (const plugin of plugins) {
    for (const server of plugin.mcpServers) {
      const key = `mcp_servers.${pluginMcpKey(plugin.name, server.name)}`;
      const config = codexMcpServerFor(server);
      if (config !== null && !(key in servers)) servers[key] = config;
    }
  }
  return Object.keys(servers).length === 0 ? undefined : servers;
};

/**
 * Why a plugin's MCP server is missing from the thread, when another
 * plugin's server took its key first: `a-b`'s `c` and `a`'s `b-c` are both
 * `plugin-a-b-c`, as are two names that differ only in the characters the
 * key replaces. Undefined when no server lost its key.
 */
export const pluginMcpClashWarning = (
  plugins: ReadonlyArray<SessionPlugin>,
): string | undefined => {
  const owners = new Map<string, string>();
  const dropped: Array<string> = [];
  for (const plugin of plugins) {
    for (const server of plugin.mcpServers) {
      if (codexMcpServerFor(server) === null) continue;
      const key = pluginMcpKey(plugin.name, server.name);
      const owner = `${plugin.name}/${server.name}`;
      const taken = owners.get(key);
      if (taken === undefined) owners.set(key, owner);
      else if (taken !== owner) dropped.push(`${owner} (${key} is ${taken}'s)`);
    }
  }
  return dropped.length === 0
    ? undefined
    : `Codex did not start these plugin MCP servers, whose names clash with another's: ${dropped.join(", ")}.`;
};
