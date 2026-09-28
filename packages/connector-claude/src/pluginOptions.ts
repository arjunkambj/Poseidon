/**
 * Poseidon's enabled plugins as SDK options.
 *
 * Each plugin directory already has the Claude Code plugin layout, so it goes
 * to the CLI whole as a local plugin (`--plugin-dir`): its skills, commands,
 * agents and hooks load the way the CLI loads any plugin. Its MCP servers do
 * not: the registry has already read them and expanded
 * `${CLAUDE_PLUGIN_ROOT}`, so the CLI is told to skip its own discovery
 * (`skipMcpDiscovery`) and they join `mcpServers` under
 * `plugin-<plugin>-<server>` instead. That prefix is what keeps a plugin from
 * ever taking over the `poseidon` entry.
 */

import type { McpServerConfig, SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import type { SessionMcpServer, SessionPlugin } from "@poseidon/connector-sdk/plugins";

/** The key a plugin's MCP server is registered under in the session. */
export const pluginMcpKey = (plugin: string, server: string): string =>
  `plugin-${plugin}-${server}`;

export const sdkPluginsFor = (plugins: ReadonlyArray<SessionPlugin>): Array<SdkPluginConfig> =>
  plugins.map((plugin) => ({ type: "local", path: plugin.root, skipMcpDiscovery: true }));

const sdkMcpServerFor = (server: SessionMcpServer): McpServerConfig | null => {
  if (server.transport === "http") {
    return server.url === undefined
      ? null
      : {
          type: "http",
          url: server.url,
          ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
        };
  }
  return server.command === undefined
    ? null
    : {
        type: "stdio",
        command: server.command,
        ...(server.args === undefined ? {} : { args: [...server.args] }),
        ...(server.env === undefined ? {} : { env: { ...server.env } }),
      };
};

/** Every enabled plugin's MCP servers, keyed for `mcpServers`; the first of a repeated key wins. */
export const pluginMcpServersFor = (
  plugins: ReadonlyArray<SessionPlugin>,
): Record<string, McpServerConfig> => {
  const servers: Record<string, McpServerConfig> = {};
  for (const plugin of plugins) {
    for (const server of plugin.mcpServers) {
      const key = pluginMcpKey(plugin.name, server.name);
      const config = sdkMcpServerFor(server);
      if (config !== null && !(key in servers)) {
        servers[key] = config;
      }
    }
  }
  return servers;
};
