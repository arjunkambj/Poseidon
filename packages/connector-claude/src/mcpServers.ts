/**
 * Claude Code's MCP servers, read and written for the Customize page. This is
 * the `mcpServers` extension.
 *
 * The CLI keeps them in two places this maps Poseidon's scopes onto:
 *
 * - user: `mcpServers` in `<config>/.claude.json` — `$CLAUDE_CONFIG_DIR/.claude.json`
 *   for an instance with an account of its own, else `~/.claude.json`;
 * - project: `mcpServers` in `<workspaceRoot>/.mcp.json`.
 *
 * Its third, `local` (a project's entry in `.claude.json`, private to one
 * user), has no Poseidon scope and is not listed.
 *
 * `.claude.json` is the CLI's own file, rewritten by every CLI that runs, and
 * nothing here writes it — or `.mcp.json`. Writes go through the CLI's own
 * commands, spawned with the connector's default-deny environment and the
 * instance's `CLAUDE_CONFIG_DIR` (`cli.ts`): `claude mcp add-json --scope
 * user|project`, and `claude mcp remove --scope user|project`, in the
 * workspace for the project scope, where the CLI finds `.mcp.json`.
 *
 * Reading is a read-only parse of the two files, not `claude mcp list` or
 * `get`: both health-check what they list, starting every stdio server and
 * connecting to every http one, which a page that only shows the entries has
 * no business doing. The files are the same the CLI's sessions read.
 *
 * Ownership. An entry carries no marker the CLI would keep, so the names
 * Poseidon added are kept in a small ledger beside the config,
 * `<config>/poseidon-mcp.json` — `<config>` as for skills and plugins — per
 * scope and, for the project scope, per workspace. A server is `managed` when
 * the ledger names it. `add` refuses a name the user configured themselves in
 * that scope and `remove` refuses to delete one, both with `conflict`. A
 * ledger that cannot be read counts as empty, so the failure mode is refusing
 * to remove, never removing a hand-made server.
 *
 * The CLI refuses to add a name its scope already holds, so editing one of
 * ours is a remove and an add; when the add fails, the entry as it was is
 * added back before the failure is reported.
 *
 * A file that exists but cannot be parsed is listed as holding nothing, and
 * every write to its scope is refused with `conflict`: the CLI, finding its
 * `.claude.json` corrupted, backs it up and starts a fresh one, which would
 * take the user's other servers out of use.
 *
 * What the CLI cannot express is refused with `invalid`, naming what to do
 * instead: a disabled server (the CLI adds servers enabled, and turns one off
 * per project from `/mcp`), and the name `poseidon`, which each session
 * already passes for Poseidon's own MCP server. That server and a plugin's
 * servers are passed per session on the command line (`queryOptions.ts`), so
 * they are in neither file and never listed.
 *
 * Everything the CLI prints comes from Claude Code 2.1.286
 * (`fixtures/claude/mcp-servers/`).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  ConnectorExtensionFailed,
  type ExtensionScope,
  type McpServersExtension,
} from "@poseidon/connector-sdk/extensions";
import type { McpServerConfig, McpServerScope } from "@poseidon/contracts/connectors";
import * as Effect from "effect/Effect";
import { isObject, isString } from "effect/Predicate";
import type * as Semaphore from "effect/Semaphore";

import { cliError, type RunClaude } from "./cli";
import { claudeConfigDir } from "./plugins";
import { POSEIDON_MCP_SERVER } from "./queryOptions";

/** The ledger of names Poseidon added, beside the CLI's own config. */
export const LEDGER_FILE = "poseidon-mcp.json";

type Json = Record<string, unknown>;

const failed = (code: ConnectorExtensionFailed["code"], message: string) =>
  new ConnectorExtensionFailed({ code, message });

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Where the CLI keeps its user-scope config for this environment. */
export const claudeJsonPath = (env: Readonly<Record<string, string | undefined>>): string => {
  const configured = env.CLAUDE_CONFIG_DIR;
  return configured !== undefined && configured !== ""
    ? NodePath.join(configured, ".claude.json")
    : NodePath.join(env.HOME ?? NodeOS.homedir(), ".claude.json");
};

// ── The two files ──────────────────────────────────────────────

/**
 * A file's `mcpServers`, as the file holds it: every key, whatever its value,
 * so a name we cannot show still counts as taken. `unreadable` is set when the
 * file exists but could not be parsed; writes to its scope must refuse.
 */
interface ServersFile {
  readonly path: string;
  readonly servers: Readonly<Record<string, unknown>>;
  readonly unreadable: string | null;
}

const readServersFile = (path: string): Effect.Effect<ServersFile> =>
  Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (cause) => cause }).pipe(
    Effect.map((text): ServersFile => {
      if (text.trim() === "") return { path, servers: {}, unreadable: null };
      try {
        const parsed = JSON.parse(text) as unknown;
        if (!isObject(parsed)) {
          return { path, servers: {}, unreadable: "its top level is not a JSON object" };
        }
        const servers = isObject(parsed.mcpServers) ? (parsed.mcpServers as Json) : {};
        return { path, servers, unreadable: null };
      } catch (cause) {
        return { path, servers: {}, unreadable: describeCause(cause) };
      }
    }),
    Effect.catch((cause) =>
      Effect.succeed<ServersFile>(
        isObject(cause) && cause.code === "ENOENT"
          ? { path, servers: {}, unreadable: null }
          : { path, servers: {}, unreadable: describeCause(cause) },
      ),
    ),
  );

// ── An entry → McpServerConfig ─────────────────────────────────

const stringRecord = (value: unknown): Record<string, string> => {
  if (!isObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (isString(item)) out[key] = item;
  return out;
};

const stringArray = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((item): item is string => isString(item)) : [];

const nonEmpty = (value: unknown): string | undefined =>
  isString(value) && value !== "" ? value : undefined;

/**
 * One entry as the CLI writes it: `type` `stdio` (command, args, env — and a
 * bare `command` with no type is stdio too) or `http` (url, headers). `sse` is
 * shown as http, the url-based family it belongs to. `${VAR}` in headers and
 * env is the CLI's own spelling of a variable, as it is ours. Anything else —
 * `ws`, an entry without its command or url — is not a server we can show.
 */
export const toMcpServerConfig = (
  name: string,
  scope: McpServerScope,
  entry: unknown,
  managed: boolean,
): McpServerConfig | null => {
  if (!isObject(entry) || name === "") return null;
  const type =
    entry.type === undefined ? (entry.command === undefined ? null : "stdio") : entry.type;
  const base = { name, scope, enabled: true, managed };
  if (type === "stdio") {
    const command = nonEmpty(entry.command);
    if (command === undefined) return null;
    const args = stringArray(entry.args);
    const env = stringRecord(entry.env);
    return {
      ...base,
      transport: "stdio",
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  if (type === "http" || type === "sse") {
    const url = nonEmpty(entry.url);
    if (url === undefined) return null;
    const headers = stringRecord(entry.headers);
    return {
      ...base,
      transport: "http",
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  return null;
};

// ── McpServerConfig → `claude mcp add-json` ────────────────────

/** The JSON `claude mcp add-json` takes for `server`, in the shape the CLI stores. */
export const addJson = (server: McpServerConfig): string => {
  if (server.transport === "stdio") {
    return JSON.stringify({
      type: "stdio",
      command: server.command,
      ...(server.args !== undefined && server.args.length > 0 ? { args: server.args } : {}),
      ...(server.env !== undefined && Object.keys(server.env).length > 0
        ? { env: server.env }
        : {}),
    });
  }
  return JSON.stringify({
    type: "http",
    url: server.url,
    ...(server.headers !== undefined && Object.keys(server.headers).length > 0
      ? { headers: server.headers }
      : {}),
  });
};

/** Why the CLI cannot write `server`, or `null` when it can. */
export const refusal = (server: McpServerConfig): string | null => {
  if (server.name === POSEIDON_MCP_SERVER) {
    return `"${POSEIDON_MCP_SERVER}" is the name every session gives Poseidon's own MCP server; pick another name`;
  }
  if (!server.enabled) {
    return "Claude Code's CLI adds servers enabled; turn one off for a project from /mcp in a Claude Code session";
  }
  if (server.transport === "stdio" && server.command === undefined) {
    return "a stdio server needs a command";
  }
  if (server.transport === "http" && server.url === undefined) {
    return "an http server needs a url";
  }
  return null;
};

/**
 * The argv that adds `name` to `scope` from `json`. The name follows `--`, so
 * one that looks like a flag stays the server's.
 */
export const addArgs = (scope: McpServerScope, name: string, json: string) =>
  ["mcp", "add-json", "--scope", scope, "--", name, json] as const;

/** The argv that removes `name` from `scope`. */
export const removeArgs = (scope: McpServerScope, name: string) =>
  ["mcp", "remove", "--scope", scope, "--", name] as const;

// ── The ledger ─────────────────────────────────────────────────

/** The names Poseidon added: the user scope's, and each workspace's project scope's. */
interface Ledger {
  readonly user: Set<string>;
  readonly projects: Map<string, Set<string>>;
}

const ledgerFrom = (parsed: unknown): Ledger => {
  const projects = new Map<string, Set<string>>();
  if (isObject(parsed) && isObject(parsed.projects)) {
    for (const [root, names] of Object.entries(parsed.projects)) {
      projects.set(root, new Set(stringArray(names)));
    }
  }
  return { user: new Set(isObject(parsed) ? stringArray(parsed.user) : []), projects };
};

const ledgerJson = (ledger: Ledger): string => {
  const projects: Record<string, Array<string>> = {};
  for (const [root, names] of [...ledger.projects].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (names.size > 0) projects[root] = [...names].toSorted();
  }
  return `${JSON.stringify({ user: [...ledger.user].toSorted(), projects }, null, 2)}\n`;
};

export interface ClaudeMcpServersOptions {
  /** The environment the instance's sessions run with (`childEnv`): where the config is. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Runs the CLI (`runClaude`). */
  readonly run: RunClaude;
  /** Serialises writers, so two adds never interleave on one config or the ledger. */
  readonly writeMutex: Semaphore.Semaphore;
}

export const makeClaudeMcpServers = (options: ClaudeMcpServersOptions): McpServersExtension => {
  const userPath = claudeJsonPath(options.env);
  const configDir = claudeConfigDir(options.env);
  const ledgerPath = NodePath.join(configDir, LEDGER_FILE);

  const readLedger = Effect.tryPromise(() => readFile(ledgerPath, "utf8")).pipe(
    Effect.flatMap((text) => Effect.try(() => ledgerFrom(JSON.parse(text) as unknown))),
    // Missing or unreadable: nothing is ours, so nothing can be removed.
    Effect.orElseSucceed(() => ledgerFrom(null)),
  );

  const writeLedger = (ledger: Ledger) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(configDir, { recursive: true });
        await writeFile(ledgerPath, ledgerJson(ledger));
      },
      catch: (cause) => failed("internal", `cannot write ${ledgerPath}: ${describeCause(cause)}`),
    });

  /** The names the ledger holds for one scope, created on demand. */
  const ledgerNames = (ledger: Ledger, scope: McpServerScope, root: string | null) => {
    if (scope === "user") return ledger.user;
    const key = NodePath.resolve(root ?? "");
    const names = ledger.projects.get(key) ?? new Set<string>();
    ledger.projects.set(key, names);
    return names;
  };

  /** Where a scope's servers live and where its CLI runs; `null` for a project scope without a project. */
  const target = (serverScope: McpServerScope, root: string | null) =>
    serverScope === "user"
      ? { path: userPath, cwd: NodeOS.tmpdir(), root: null }
      : root === null
        ? null
        : { path: NodePath.join(root, ".mcp.json"), cwd: root, root };

  const list = (scope: ExtensionScope) =>
    Effect.gen(function* () {
      const ledger = yield* readLedger;
      const scopes: Array<McpServerScope> =
        scope.workspaceRoot === null ? ["user"] : ["user", "project"];
      const out: Array<McpServerConfig> = [];
      for (const serverScope of scopes) {
        const at = target(serverScope, scope.workspaceRoot)!;
        const file = yield* readServersFile(at.path);
        if (file.unreadable !== null) {
          yield* Effect.logWarning(`claude mcp: cannot read ${at.path} (${file.unreadable})`);
        }
        const ours = ledgerNames(ledger, serverScope, at.root);
        for (const [name, entry] of Object.entries(file.servers)) {
          const config = toMcpServerConfig(name, serverScope, entry, ours.has(name));
          if (config !== null) out.push(config);
        }
      }
      return out;
    });

  /** The file for a write, refused when it has no project or cannot be read. */
  const writable = (serverScope: McpServerScope, root: string | null) =>
    Effect.gen(function* () {
      const at = target(serverScope, root);
      if (at === null) {
        return yield* failed(
          "not-found",
          "project scope needs a project; pass projectId for a project-scope server",
        );
      }
      const file = yield* readServersFile(at.path);
      if (file.unreadable !== null) {
        return yield* failed(
          "conflict",
          `cannot read ${at.path} (${file.unreadable}); fix it by hand first — refusing to have the CLI rewrite it`,
        );
      }
      return { ...at, file };
    });

  const add = (scope: ExtensionScope, server: McpServerConfig) =>
    options.writeMutex.withPermits(1)(
      Effect.gen(function* () {
        const refused = refusal(server);
        if (refused !== null) return yield* failed("invalid", refused);
        const at = yield* writable(server.scope, scope.workspaceRoot);
        const ledger = yield* readLedger;
        const ours = ledgerNames(ledger, server.scope, at.root);
        const existing = at.file.servers[server.name];
        if (existing !== undefined && !ours.has(server.name)) {
          return yield* failed(
            "conflict",
            `"${server.name}" is already in ${at.path} and was not added by Poseidon; edit it by hand or pick another name`,
          );
        }
        if (existing !== undefined) {
          const removed = yield* options.run(removeArgs(server.scope, server.name), at.cwd);
          if (removed.code !== 0) return yield* failed("internal", cliError(removed));
        }
        const added = yield* options.run(
          addArgs(server.scope, server.name, addJson(server)),
          at.cwd,
        );
        if (added.code !== 0) {
          if (existing !== undefined) {
            // The edit's remove went through: put the entry back as it was.
            const restored = yield* options.run(
              addArgs(server.scope, server.name, JSON.stringify(existing)),
              at.cwd,
            );
            if (restored.code !== 0) {
              ours.delete(server.name);
              yield* writeLedger(ledger);
              return yield* failed(
                "internal",
                `${cliError(added)}; and "${server.name}" could not be put back: ${cliError(restored)}`,
              );
            }
          }
          return yield* failed("invalid", cliError(added));
        }
        ours.add(server.name);
        yield* writeLedger(ledger);
        return yield* list(scope);
      }),
    );

  const remove = (scope: ExtensionScope, serverScope: McpServerScope, name: string) =>
    options.writeMutex.withPermits(1)(
      Effect.gen(function* () {
        const at = yield* writable(serverScope, scope.workspaceRoot);
        if (at.file.servers[name] === undefined) {
          return yield* failed("not-found", `no server "${name}" in ${at.path}`);
        }
        const ledger = yield* readLedger;
        const ours = ledgerNames(ledger, serverScope, at.root);
        if (!ours.has(name)) {
          return yield* failed(
            "conflict",
            `"${name}" was not added by Poseidon; refusing to remove it (claude mcp remove --scope ${serverScope} ${name} does it by hand)`,
          );
        }
        const ran = yield* options.run(removeArgs(serverScope, name), at.cwd);
        if (ran.code !== 0) return yield* failed("internal", cliError(ran));
        ours.delete(name);
        yield* writeLedger(ledger);
        return yield* list(scope);
      }),
    );

  return { list, add, remove };
};
