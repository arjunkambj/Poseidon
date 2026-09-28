/**
 * How a session's app-server is launched: its argv and its environment.
 *
 * Poseidon's per-thread MCP server (`services.mcpEndpoint`) is handed to the
 * CLI as an HTTP MCP server named `poseidon`, through `-c` overrides of the
 * CLI's own config: its URL, and the name of an environment variable holding
 * the bearer (`bearer_token_env_var`). The bearer itself is set only in the
 * child's environment, so it never appears in argv — where `ps` would show it
 * to every user of the machine — nor in a recording. Recorded against
 * 0.156.1: the server announces `poseidon` in `mcpServer/startupStatus/updated`.
 *
 * The variable's name holds `TOKEN` on purpose: the CLI's default shell
 * environment policy leaves variables named like secrets out of the commands
 * the model runs, so the bearer stays with the MCP client.
 */

import type { ConnectorEndpoint } from "@poseidon/connector-sdk/definition";

/** The MCP server name the CLI lists Poseidon's tools under. */
export const MCP_SERVER_NAME = "poseidon";

/** The child-only variable the CLI reads the MCP bearer from. */
export const MCP_BEARER_ENV = "POSEIDON_CODEX_MCP_TOKEN";

/** A TOML basic string, which is what a `-c` value is parsed as. */
const tomlString = (value: string): string => JSON.stringify(value);

export const sessionServerArgs = (mcp: ConnectorEndpoint): ReadonlyArray<string> => [
  "app-server",
  "-c",
  `mcp_servers.${MCP_SERVER_NAME}.url=${tomlString(mcp.url)}`,
  "-c",
  `mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var=${tomlString(MCP_BEARER_ENV)}`,
];

export const sessionEnv = (
  env: Readonly<Record<string, string>>,
  mcp: ConnectorEndpoint,
): Record<string, string> => ({ ...env, [MCP_BEARER_ENV]: mcp.bearer });
