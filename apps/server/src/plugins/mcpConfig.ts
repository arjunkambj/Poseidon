/**
 * The MCP servers a plugin declares, from a `.mcp.json` file or the manifest's
 * `mcpServers` entry, in the shapes Claude Code accepts: a flat map of server
 * name to entry, or the same map under `mcpServers`.
 *
 * `${CLAUDE_PLUGIN_ROOT}` and `${POSEIDON_PLUGIN_ROOT}` are expanded to the
 * plugin's directory in every string a harness would run or dial, so a
 * connector never has to know the convention. Any other `${VAR}` is left for
 * the harness to expand, as Claude Code does.
 *
 * Pure: a server Poseidon cannot load (an `sse` or unknown transport, an entry
 * with no command or url) becomes a warning and is skipped, and nothing here
 * throws.
 */

import type { SessionMcpServer } from "@poseidon/connector-sdk/plugins";

export interface McpServersRead {
  readonly servers: ReadonlyArray<SessionMcpServer>;
  readonly warnings: ReadonlyArray<string>;
}

const ROOT_VARIABLES = ["${CLAUDE_PLUGIN_ROOT}", "${POSEIDON_PLUGIN_ROOT}"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Replaces the plugin-root variables in `value` with `root`. */
const expandPluginRoot = (value: string, root: string): string =>
  ROOT_VARIABLES.reduce((text, variable) => text.split(variable).join(root), value);

/** A map of strings, expanded; null when any value is not a string. */
const stringMap = (value: unknown, root: string): Record<string, string> | null => {
  if (!isRecord(value)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      return null;
    }
    out[key] = expandPluginRoot(entry, root);
  }
  return out;
};

type ServerRead = { readonly server: SessionMcpServer } | { readonly warning: string };

const readServer = (name: string, entry: unknown, root: string): ServerRead => {
  if (!isRecord(entry)) {
    return { warning: `MCP server "${name}" is not an object and was skipped` };
  }
  const declared = entry.type ?? entry.transport;
  const transport =
    declared === undefined
      ? typeof entry.command === "string"
        ? "stdio"
        : typeof entry.url === "string"
          ? "http"
          : undefined
      : declared;
  if (transport === "sse") {
    return {
      warning: `MCP server "${name}" uses the sse transport, which Poseidon does not load`,
    };
  }
  if (transport === "stdio") {
    if (typeof entry.command !== "string" || entry.command.trim() === "") {
      return { warning: `MCP server "${name}" has no command and was skipped` };
    }
    const args = entry.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      return { warning: `MCP server "${name}" has args that are not strings and was skipped` };
    }
    const env = entry.env === undefined ? {} : stringMap(entry.env, root);
    if (env === null) {
      return { warning: `MCP server "${name}" has an env that is not strings and was skipped` };
    }
    return {
      server: {
        name,
        transport: "stdio",
        command: expandPluginRoot(entry.command, root),
        args: (args as ReadonlyArray<string>).map((arg) => expandPluginRoot(arg, root)),
        env,
      },
    };
  }
  if (transport === "http") {
    if (typeof entry.url !== "string" || entry.url.trim() === "") {
      return { warning: `MCP server "${name}" has no url and was skipped` };
    }
    const headers = entry.headers === undefined ? {} : stringMap(entry.headers, root);
    if (headers === null) {
      return {
        warning: `MCP server "${name}" has headers that are not strings and was skipped`,
      };
    }
    return {
      server: { name, transport: "http", url: expandPluginRoot(entry.url, root), headers },
    };
  }
  return transport === undefined
    ? { warning: `MCP server "${name}" has neither a command nor a url and was skipped` }
    : {
        warning: `MCP server "${name}" uses the ${String(transport)} transport, which Poseidon does not load`,
      };
};

/**
 * The servers in one MCP config value, or an error when the value is not an
 * object at all. `origin` names where it came from for the messages.
 */
export const readMcpServers = (
  config: unknown,
  root: string,
  origin: string,
): McpServersRead | { readonly error: string } => {
  if (!isRecord(config)) {
    return { error: "it must be an object of MCP servers" };
  }
  const map = isRecord(config.mcpServers) ? config.mcpServers : config;
  const servers: Array<SessionMcpServer> = [];
  const warnings: Array<string> = [];
  for (const [name, entry] of Object.entries(map)) {
    if (name.trim() === "") {
      warnings.push(`${origin} has an MCP server with an empty name`);
      continue;
    }
    const read = readServer(name, entry, root);
    if ("warning" in read) {
      warnings.push(read.warning);
    } else {
      servers.push(read.server);
    }
  }
  return { servers, warnings };
};
