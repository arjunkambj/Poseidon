/**
 * Codex's MCP servers, read and written for the Customize page through the
 * CLI's own `codex mcp` commands. This is the `mcpServers` extension.
 *
 * Codex keeps its servers in `<CODEX_HOME>/config.toml`, a file it owns and
 * rewrites itself. Poseidon never parses or writes that TOML: `list` is
 * `codex mcp list --json`, `add` is `codex mcp add`, `remove` is
 * `codex mcp remove`, each spawned with the connector's default-deny
 * environment and the instance's `CODEX_HOME` (`env.ts`).
 *
 * Ownership. The CLI has no way to carry a marker on an entry the way
 * Command Code's `mcp.json` carries `_poseidon`, so the names Poseidon added
 * are kept in a small ledger beside the config, `<CODEX_HOME>/poseidon-mcp.json`.
 * A server is `managed` when its name is in the ledger. `add` refuses to
 * overwrite a server of that name the user configured themselves (`codex mcp
 * add` would replace it silently), and `remove` refuses to delete one — both
 * with `conflict`. A ledger that cannot be read counts as empty, so the
 * failure mode is refusing to remove, never removing a hand-made server.
 *
 * What the CLI cannot express is refused with `invalid`, naming what to edit
 * by hand, rather than half-written:
 *
 * - the project scope — the CLI writes the user config only;
 * - a disabled server — `codex mcp add` always writes an enabled one;
 * - HTTP headers other than `Authorization: Bearer ${VAR}`, which is the
 *   CLI's `--bearer-token-env-var VAR`.
 *
 * Everything the CLI prints comes from codex-cli 0.156.1
 * (`fixtures/codex/mcp-servers/`).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";
import type { ExtensionScope, McpServersExtension } from "@poseidon/connector-sdk/extensions";
import type { McpServerConfig } from "@poseidon/contracts/connectors";
import * as Effect from "effect/Effect";
import { isObject, isString } from "effect/Predicate";
import type * as Semaphore from "effect/Semaphore";

import { cliError, failed, runCodex, type CodexCli } from "./cli";

/** The ledger of names Poseidon added, beside the CLI's own config. */
export const LEDGER_FILE = "poseidon-mcp.json";

// ── `codex mcp list --json` → McpServerConfig ──────────────────

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
 * One row of the CLI's JSON list. `transport.type` is `stdio` (command, args,
 * env) or `streamable_http` (url, and headers three ways: literal
 * `http_headers`, `env_http_headers` naming a variable per header, and
 * `bearer_token_env_var`). The variable forms are shown the way our contract
 * spells a variable, `${VAR}`. Anything else is not a server we can show.
 */
export const toMcpServerConfig = (row: unknown, managed: boolean): McpServerConfig | null => {
  if (!isObject(row)) return null;
  const name = nonEmpty(row.name);
  const transport = isObject(row.transport) ? row.transport : null;
  if (name === undefined || transport === null) return null;
  const base = { name, scope: "user" as const, enabled: row.enabled !== false, managed };
  if (transport.type === "stdio") {
    const command = nonEmpty(transport.command);
    if (command === undefined) return null;
    const args = stringArray(transport.args);
    const env = stringRecord(transport.env);
    return {
      ...base,
      transport: "stdio",
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  if (transport.type === "streamable_http") {
    const url = nonEmpty(transport.url);
    if (url === undefined) return null;
    const headers: Record<string, string> = { ...stringRecord(transport.http_headers) };
    for (const [header, variable] of Object.entries(stringRecord(transport.env_http_headers))) {
      headers[header] = `\${${variable}}`;
    }
    const bearer = nonEmpty(transport.bearer_token_env_var);
    if (bearer !== undefined) headers.Authorization = `Bearer \${${bearer}}`;
    return {
      ...base,
      transport: "http",
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  return null;
};

// ── McpServerConfig → `codex mcp add` ──────────────────────────

const BEARER_HEADER = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * The argv that adds `server`, or why the CLI cannot write it. The command
 * follows `--`, so an argument that looks like a flag stays the server's.
 */
export const addArgs = (server: McpServerConfig): ReadonlyArray<string> | string => {
  if (server.scope !== "user") {
    return "Codex's CLI writes MCP servers to the user config only; add a project server to .codex/config.toml by hand";
  }
  if (!server.enabled) {
    return `Codex's CLI adds servers enabled; to disable one, set enabled = false under [mcp_servers.${server.name}] in config.toml`;
  }
  if (server.transport === "stdio") {
    if (server.command === undefined) return "a stdio server needs a command";
    const env = Object.entries(server.env ?? {}).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]);
    return ["mcp", "add", server.name, ...env, "--", server.command, ...(server.args ?? [])];
  }
  if (server.url === undefined) return "an http server needs a url";
  const bearer: Array<string> = [];
  for (const [header, value] of Object.entries(server.headers ?? {})) {
    const variable = header.toLowerCase() === "authorization" ? BEARER_HEADER.exec(value) : null;
    if (variable === null) {
      return `Codex's CLI sets no header but "Authorization: Bearer \${VAR}"; add ${header} under [mcp_servers.${server.name}.http_headers] in config.toml by hand`;
    }
    bearer.push("--bearer-token-env-var", variable[1]!);
  }
  return ["mcp", "add", server.name, "--url", server.url, ...bearer];
};

export interface CodexMcpServersOptions extends CodexCli {
  /** The `CODEX_HOME` the CLI will use; the ledger lives there. */
  readonly codexHome: string;
  /** Serialises writers, so two adds never interleave on one config. */
  readonly writeMutex: Semaphore.Semaphore;
}

export const makeCodexMcpServers = (options: CodexMcpServersOptions): McpServersExtension => {
  const ledgerPath = NodePath.join(options.codexHome, LEDGER_FILE);

  const run = runCodex(options);

  const readLedger = Effect.tryPromise(() => readFile(ledgerPath, "utf8")).pipe(
    Effect.map((text) => {
      const parsed = JSON.parse(text) as unknown;
      return new Set(isObject(parsed) ? stringArray(parsed.servers) : []);
    }),
    // Missing or unreadable: nothing is ours, so nothing can be removed.
    Effect.orElseSucceed(() => new Set<string>()),
  );

  const writeLedger = (names: ReadonlySet<string>) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(options.codexHome, { recursive: true });
        await writeFile(
          ledgerPath,
          `${JSON.stringify({ servers: [...names].toSorted() }, null, 2)}\n`,
        );
      },
      catch: (cause) =>
        failed(
          "internal",
          `cannot write ${ledgerPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    });

  /** The CLI's rows, with the ledger's word on which are ours. */
  const listed = Effect.gen(function* () {
    const ran = yield* run(["mcp", "list", "--json"]);
    if (ran.code !== 0) return yield* failed("internal", cliError(ran.stderr));
    const rows = yield* Effect.try({
      try: () => JSON.parse(ran.stdout) as unknown,
      catch: () => failed("internal", "codex mcp list --json printed something that is not JSON"),
    });
    const ledger = yield* readLedger;
    return (Array.isArray(rows) ? rows : []).flatMap((row) => {
      const name = isObject(row) && isString(row.name) ? row.name : "";
      const config = toMcpServerConfig(row, ledger.has(name));
      return config === null ? [] : [config];
    });
  });

  const list = (_scope: ExtensionScope) => listed;

  const add = (_scope: ExtensionScope, server: McpServerConfig) =>
    options.writeMutex.withPermits(1)(
      Effect.gen(function* () {
        const args = addArgs(server);
        if (typeof args === "string") return yield* failed("invalid", args);
        const existing = (yield* listed).find((entry) => entry.name === server.name);
        if (existing !== undefined && existing.managed !== true) {
          return yield* failed(
            "conflict",
            `"${server.name}" is already in Codex's config.toml and was not added by Poseidon; edit it by hand or pick another name`,
          );
        }
        const ran = yield* run(args);
        if (ran.code !== 0) return yield* failed("invalid", cliError(ran.stderr));
        const ledger = yield* readLedger;
        ledger.add(server.name);
        yield* writeLedger(ledger);
        return yield* listed;
      }),
    );

  const remove = (_scope: ExtensionScope, serverScope: McpServerConfig["scope"], name: string) =>
    options.writeMutex.withPermits(1)(
      Effect.gen(function* () {
        if (serverScope !== "user") {
          return yield* failed(
            "invalid",
            "Codex's CLI manages the user config only; there is no project scope to remove from",
          );
        }
        const existing = (yield* listed).find((entry) => entry.name === name);
        if (existing === undefined) {
          return yield* failed("not-found", `no server "${name}" in Codex's config.toml`);
        }
        if (existing.managed !== true) {
          return yield* failed(
            "conflict",
            `"${name}" was not added by Poseidon; refusing to remove it (codex mcp remove ${name} does it by hand)`,
          );
        }
        const ran = yield* run(["mcp", "remove", name]);
        if (ran.code !== 0) return yield* failed("internal", cliError(ran.stderr));
        const ledger = yield* readLedger;
        ledger.delete(name);
        yield* writeLedger(ledger);
        return yield* listed;
      }),
    );

  return { list, add, remove };
};
