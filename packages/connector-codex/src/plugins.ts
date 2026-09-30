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
 *   `thread/resume`, `thread/fork`) as `mcp_servers.plugin-<plugin>-<server>`,
 *   which the CLI merges into the user's own table for this thread only:
 *   nothing is written to `config.toml`, and nothing goes on the argv, where
 *   `ps` would show a header's or a variable's value. The thread starts them
 *   and reports each in `mcpServer/startupStatus/updated` (`plugin-skill`).
 *   The prefix keeps a plugin from ever taking over the `poseidon` entry, and
 *   each part is kept to the letters, digits, `-` and `_` the CLI allows in a
 *   server name.
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
 * The thread's `config` for the enabled plugins' MCP servers, or undefined
 * when they have none; the first of a repeated key wins.
 */
export const pluginThreadConfig = (
  plugins: ReadonlyArray<SessionPlugin>,
): { readonly mcp_servers: Record<string, Record<string, unknown>> } | undefined => {
  const servers: Record<string, Record<string, unknown>> = {};
  for (const plugin of plugins) {
    for (const server of plugin.mcpServers) {
      const key = pluginMcpKey(plugin.name, server.name);
      const config = codexMcpServerFor(server);
      if (config !== null && !(key in servers)) servers[key] = config;
    }
  }
  return Object.keys(servers).length === 0 ? undefined : { mcp_servers: servers };
};
