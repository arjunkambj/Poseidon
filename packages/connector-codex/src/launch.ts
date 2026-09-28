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
 * The commands the model runs must not inherit the bearer: one that held it
 * could print it into the timeline, or call the MCP endpoint directly and so
 * skip the elicitation that puts Poseidon's tools behind the ladder
 * (`mcpApprovals.ts`). The CLI's default shell environment policy does not
 * filter it — on 0.156.1, with no `shell_environment_policy` configured,
 * variables named like secrets reach every command. So a third override sets
 * the variable to the empty string in every command's environment
 * (`shell_environment_policy.set`); the CLI's own MCP client still reads the
 * real value from the process. A key under `set` leaves the rest of the
 * user's policy as `config.toml` has it; an `exclude` list would replace the
 * user's own list.
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
  "-c",
  `shell_environment_policy.set.${MCP_BEARER_ENV}=${tomlString("")}`,
];

export const sessionEnv = (
  env: Readonly<Record<string, string>>,
  mcp: ConnectorEndpoint,
): Record<string, string> => ({ ...env, [MCP_BEARER_ENV]: mcp.bearer });
