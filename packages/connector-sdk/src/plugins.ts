/**
 * The Poseidon plugins a session loads, as the server hands them to a
 * connector.
 *
 * A plugin is a directory in the Claude Code plugin layout
 * (`.claude-plugin/plugin.json`, `skills/`, `commands/`, `agents/`, `hooks/`,
 * `.mcp.json`). The server's registry has already validated it and resolved
 * everything a connector needs to absolute paths, so a connector never reads a
 * manifest itself: it either hands the whole directory to a harness that
 * understands the layout, or loads the skills and MCP servers listed here.
 */

/**
 * One MCP server a plugin declares in its `.mcp.json`, with
 * `${CLAUDE_PLUGIN_ROOT}` already expanded to the plugin's directory in every
 * string. `http` servers carry `url` and `headers`; `stdio` servers carry
 * `command`, `args` and `env`.
 */
export interface SessionMcpServer {
  readonly name: string;
  readonly transport: "http" | "stdio";
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

/** One skill a plugin carries: `path` is the absolute directory holding its `SKILL.md`. */
export interface SessionPluginSkill {
  readonly name: string;
  readonly description?: string;
  readonly path: string;
}

/**
 * One enabled plugin, ready for a session. `root` is its absolute directory;
 * `builtin` is true for a plugin that ships with the app. `skillsDirs` are the
 * absolute directories that hold its skills (each a directory of
 * `<name>/SKILL.md` folders), for a harness that takes a skills directory
 * rather than one skill at a time.
 */
export interface SessionPlugin {
  readonly name: string;
  readonly root: string;
  readonly builtin: boolean;
  readonly skills: ReadonlyArray<SessionPluginSkill>;
  readonly skillsDirs: ReadonlyArray<string>;
  readonly mcpServers: ReadonlyArray<SessionMcpServer>;
}
