/**
 * Claude Code's MCP servers, read and written for the Customize page. This is
 * the `mcpServers` extension.
 *
 * The CLI keeps them in two places this maps Poseidon's scopes onto:
 *
 * - user: `mcpServers` in `<config>/.claude.json` —
 *   `$CLAUDE_CONFIG_DIR/.claude.json` for an instance with an account of its
 *   own, else `~/.claude.json` — or in the legacy `<config>/.config.json`,
 *   which the CLI reads instead while it exists;
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
 * Ownership. An entry carries no marker the CLI would keep, so the servers
 * Poseidon added are kept in a small ledger beside the config,
 * `<config>/poseidon-mcp.json` — `<config>` as for skills and plugins — per
 * file the CLI keeps them in, each name with a fingerprint of the entry the
 * CLI stored for it. A server is `managed` while the ledger names it for that
 * file and its entry still has that fingerprint: one the user removed and
 * added again by hand, edited by hand, or that a checkout of `.mcp.json`
 * replaced, is theirs, and every write drops such names from the ledger.
 * `add` refuses a name the user configured themselves in that scope and
 * `remove` refuses to delete one, both with `conflict`. A ledger that cannot
 * be read lists nothing as ours and refuses every write, so it is never
 * replaced by one that forgot what it held.
 *
 * The CLI refuses to add a name its scope already holds, so editing one of
 * ours is a remove and an add, run uninterruptibly: when the add fails or
 * cannot run, the entry as it was is added back before the failure is
 * reported.
 *
 * A file that exists but cannot be parsed is listed as holding nothing, and
 * every write to its scope is refused with `conflict`: the CLI, finding its
 * `.claude.json` corrupted, backs it up and starts a fresh one, which would
 * take the user's other servers out of use. So is a write to a `.mcp.json`
 * with top-level keys besides `mcpServers` (`$schema`, say), which the CLI
 * drops when it rewrites the file.
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

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
import * as Result from "effect/Result";
import type * as Semaphore from "effect/Semaphore";

import { cliError, type Ran, type RunClaude } from "./cli";
import { claudeConfigDir } from "./plugins";
import { POSEIDON_MCP_SERVER } from "./queryOptions";

/** The ledger of names Poseidon added, beside the CLI's own config. */
export const LEDGER_FILE = "poseidon-mcp.json";

type Json = Record<string, unknown>;

const failed = (code: ConnectorExtensionFailed["code"], message: string) =>
  new ConnectorExtensionFailed({ code, message });

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Where the CLI keeps its user-scope config for this environment: the legacy
 * `<config>/.config.json` while it exists, as the CLI itself decides, else
 * `.claude.json` in `CLAUDE_CONFIG_DIR` or the home directory.
 */
export const claudeJsonPath = (env: Readonly<Record<string, string | undefined>>): string => {
  const legacy = NodePath.join(claudeConfigDir(env), ".config.json");
  if (existsSync(legacy)) return legacy;
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
 * `otherKeys` are its top-level keys besides `mcpServers`.
 */
interface ServersFile {
  readonly path: string;
  readonly servers: Readonly<Record<string, unknown>>;
  readonly otherKeys: ReadonlyArray<string>;
  readonly unreadable: string | null;
}

const emptyFile = (path: string, unreadable: string | null): ServersFile => ({
  path,
  servers: {},
  otherKeys: [],
  unreadable,
});

/** The entry `file` holds for `name`: its own key only, never `toString` and the like. */
const entryOf = (file: ServersFile, name: string): unknown =>
  Object.hasOwn(file.servers, name) ? file.servers[name] : undefined;

const readServersFile = (path: string): Effect.Effect<ServersFile> =>
  Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (cause) => cause }).pipe(
    Effect.map((text): ServersFile => {
      if (text.trim() === "") return emptyFile(path, null);
      try {
        const parsed = JSON.parse(text) as unknown;
        if (!isObject(parsed)) return emptyFile(path, "its top level is not a JSON object");
        const servers = isObject(parsed.mcpServers) ? (parsed.mcpServers as Json) : {};
        const otherKeys = Object.keys(parsed).filter((key) => key !== "mcpServers");
        return { path, servers, otherKeys, unreadable: null };
      } catch (cause) {
        return emptyFile(path, describeCause(cause));
      }
    }),
    Effect.catch((cause) =>
      Effect.succeed(
        emptyFile(path, isObject(cause) && cause.code === "ENOENT" ? null : describeCause(cause)),
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

/**
 * An entry's fingerprint: a hash of its JSON with keys sorted and empty lists
 * and maps left out, so the CLI writing `args: []` or reordering keys keeps
 * it, and nothing of a header or env value is copied into the ledger.
 */
export const fingerprint = (entry: unknown): string => {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!isObject(value)) return value;
    const out: Json = {};
    for (const key of Object.keys(value).toSorted()) {
      const item = value[key];
      if (Array.isArray(item) && item.length === 0) continue;
      if (isObject(item) && !Array.isArray(item) && Object.keys(item).length === 0) continue;
      out[key] = canonical(item);
    }
    return out;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(entry)))
    .digest("hex");
};

/** What Poseidon added: per file the CLI keeps servers in, each name's fingerprint. */
type Ledger = Map<string, Map<string, string>>;

const ledgerFrom = (parsed: unknown): Ledger => {
  const ledger: Ledger = new Map();
  if (!isObject(parsed) || !isObject(parsed.files)) return ledger;
  for (const [path, names] of Object.entries(parsed.files)) {
    if (!isObject(names)) continue;
    const kept = new Map<string, string>();
    for (const [name, print] of Object.entries(names)) if (isString(print)) kept.set(name, print);
    ledger.set(path, kept);
  }
  return ledger;
};

const ledgerJson = (ledger: Ledger): string => {
  const files: Record<string, Record<string, string>> = {};
  for (const [path, names] of [...ledger].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (names.size === 0) continue;
    files[path] = Object.fromEntries([...names].toSorted(([a], [b]) => a.localeCompare(b)));
  }
  return `${JSON.stringify({ files }, null, 2)}\n`;
};

/** Whether `file`'s entry for `name` is the one Poseidon added. */
const isOurs = (names: ReadonlyMap<string, string>, file: ServersFile, name: string) => {
  const entry = entryOf(file, name);
  return entry !== undefined && names.get(name) === fingerprint(entry);
};

/**
 * Drops the names whose entry is no longer the one Poseidon added: gone from
 * the file, or changed by hand. `true` when any was dropped.
 */
const prune = (names: Map<string, string>, file: ServersFile): boolean => {
  let dropped = false;
  // Deleting the entry being visited is safe in a Map's iteration.
  for (const name of names.keys()) {
    if (!isOurs(names, file, name)) {
      names.delete(name);
      dropped = true;
    }
  }
  return dropped;
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
  const configDir = claudeConfigDir(options.env);
  const ledgerPath = NodePath.join(configDir, LEDGER_FILE);

  /** The ledger, and why it could not be read when it exists but does not parse. */
  const readLedger = Effect.tryPromise({
    try: () => readFile(ledgerPath, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.flatMap((text) => Effect.try(() => ledgerFrom(JSON.parse(text) as unknown))),
    Effect.map((ledger) => ({ ledger, unreadable: null as string | null })),
    Effect.catch((cause) =>
      Effect.succeed({
        ledger: ledgerFrom(null),
        unreadable: isObject(cause) && cause.code === "ENOENT" ? null : describeCause(cause),
      }),
    ),
  );

  /** The ledger for a write, refused when it cannot be read: a fresh one would forget ours. */
  const writableLedger = Effect.gen(function* () {
    const read = yield* readLedger;
    if (read.unreadable !== null) {
      return yield* failed(
        "conflict",
        `cannot read ${ledgerPath} (${read.unreadable}); fix or delete it by hand first — it names the servers Poseidon added`,
      );
    }
    return read.ledger;
  });

  /** Writes the ledger whole, through a temporary file, so a crash never leaves half of one. */
  const writeLedger = (ledger: Ledger) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(configDir, { recursive: true });
        const temporary = `${ledgerPath}.${process.pid}.tmp`;
        await writeFile(temporary, ledgerJson(ledger));
        await rename(temporary, ledgerPath);
      },
      catch: (cause) => failed("internal", `cannot write ${ledgerPath}: ${describeCause(cause)}`),
    });

  /** The names the ledger holds for one file, created on demand. */
  const ledgerNames = (ledger: Ledger, path: string) => {
    const names = ledger.get(path) ?? new Map<string, string>();
    ledger.set(path, names);
    return names;
  };

  /** Where a scope's servers live and where its CLI runs; `null` for a project scope without a project. */
  const target = (serverScope: McpServerScope, root: string | null) =>
    serverScope === "user"
      ? { path: claudeJsonPath(options.env), cwd: NodeOS.tmpdir() }
      : root === null
        ? null
        : { path: NodePath.resolve(root, ".mcp.json"), cwd: root };

  const list = (scope: ExtensionScope) =>
    Effect.gen(function* () {
      const read = yield* readLedger;
      if (read.unreadable !== null) {
        yield* Effect.logWarning(`claude mcp: cannot read ${ledgerPath} (${read.unreadable})`);
      }
      const scopes: Array<McpServerScope> =
        scope.workspaceRoot === null ? ["user"] : ["user", "project"];
      const out: Array<McpServerConfig> = [];
      for (const serverScope of scopes) {
        const at = target(serverScope, scope.workspaceRoot)!;
        const file = yield* readServersFile(at.path);
        if (file.unreadable !== null) {
          yield* Effect.logWarning(`claude mcp: cannot read ${at.path} (${file.unreadable})`);
        }
        const names = read.ledger.get(at.path) ?? new Map<string, string>();
        for (const [name, entry] of Object.entries(file.servers)) {
          const config = toMcpServerConfig(name, serverScope, entry, isOurs(names, file, name));
          if (config !== null) out.push(config);
        }
      }
      return out;
    });

  /**
   * The file for a write, its ledger names pruned (and the ledger saved when
   * any were), refused when it has no project, cannot be read, or would lose
   * keys to the CLI's rewrite.
   */
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
      if (serverScope === "project" && file.otherKeys.length > 0) {
        return yield* failed(
          "conflict",
          `${at.path} holds ${file.otherKeys.map((key) => `"${key}"`).join(", ")} besides mcpServers, which the CLI drops when it rewrites the file; edit it by hand instead`,
        );
      }
      const ledger = yield* writableLedger;
      const names = ledgerNames(ledger, at.path);
      if (prune(names, file)) yield* writeLedger(ledger);
      return { ...at, file, ledger, names };
    });

  /**
   * After a write: the ledger names `name` with the fingerprint of the entry
   * the file now holds when `ours`, and not at all otherwise.
   */
  const settle = (
    at: { readonly path: string; readonly ledger: Ledger; readonly names: Map<string, string> },
    name: string,
    ours: boolean,
  ) =>
    Effect.gen(function* () {
      const entry = entryOf(yield* readServersFile(at.path), name);
      if (ours && entry !== undefined) at.names.set(name, fingerprint(entry));
      else at.names.delete(name);
      yield* writeLedger(at.ledger);
    });

  /** What a run that failed or exited non-zero said, or `null` for a clean exit. */
  const runError = (ran: Result.Result<Ran, ConnectorExtensionFailed>): string | null =>
    Result.isFailure(ran)
      ? ran.failure.message
      : ran.success.code === 0
        ? null
        : cliError(ran.success);

  const add = (scope: ExtensionScope, server: McpServerConfig) =>
    options.writeMutex.withPermits(1)(
      Effect.gen(function* () {
        const refused = refusal(server);
        if (refused !== null) return yield* failed("invalid", refused);
        const at = yield* writable(server.scope, scope.workspaceRoot);
        const existing = entryOf(at.file, server.name);
        if (existing !== undefined && !at.names.has(server.name)) {
          return yield* failed(
            "conflict",
            `"${server.name}" is already in ${at.path} and was not added by Poseidon; edit it by hand or pick another name`,
          );
        }
        // Once an edit's remove has run, its add — or putting the entry back —
        // runs too, whatever interrupts or fails in between.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (existing !== undefined) {
              const removed = yield* options.run(removeArgs(server.scope, server.name), at.cwd);
              if (removed.code !== 0) return yield* failed("internal", cliError(removed));
            }
            const added = yield* Effect.result(
              options.run(addArgs(server.scope, server.name, addJson(server)), at.cwd),
            );
            const addError = runError(added);
            if (addError === null) return yield* settle(at, server.name, true);
            if (existing !== undefined) {
              // The edit's remove went through: put the entry back as it was.
              const restored = yield* Effect.result(
                options.run(addArgs(server.scope, server.name, JSON.stringify(existing)), at.cwd),
              );
              const restoreError = runError(restored);
              yield* settle(at, server.name, restoreError === null);
              if (restoreError !== null) {
                return yield* failed(
                  "internal",
                  `${addError}; and "${server.name}" could not be put back: ${restoreError}`,
                );
              }
            }
            // The CLI refused the entry; a run that could not finish is ours to report.
            return yield* failed(Result.isFailure(added) ? "internal" : "invalid", addError);
          }),
        );
        return yield* list(scope);
      }),
    );

  const remove = (scope: ExtensionScope, serverScope: McpServerScope, name: string) =>
    options.writeMutex.withPermits(1)(
      Effect.gen(function* () {
        const at = yield* writable(serverScope, scope.workspaceRoot);
        if (entryOf(at.file, name) === undefined) {
          return yield* failed("not-found", `no server "${name}" in ${at.path}`);
        }
        if (!at.names.has(name)) {
          return yield* failed(
            "conflict",
            `"${name}" was not added by Poseidon; refusing to remove it (claude mcp remove --scope ${serverScope} ${name} does it by hand)`,
          );
        }
        const ran = yield* options.run(removeArgs(serverScope, name), at.cwd);
        if (ran.code !== 0) return yield* failed("internal", cliError(ran));
        at.names.delete(name);
        yield* writeLedger(at.ledger);
        return yield* list(scope);
      }),
    );

  return { list, add, remove };
};
