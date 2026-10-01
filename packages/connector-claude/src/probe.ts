/**
 * Finding and interrogating the `claude` binary.
 *
 * **Version policy.** The connector runs whatever the user has installed and
 * never a copy of its own: the CLI updates itself and the harness is the
 * user's. `OLDEST_TESTED_VERSION` is only the release the recordings were
 * made at. Below it the probe warns; at or above it, it says nothing.
 *
 * Three questions, asked of the binary the session will spawn and under the
 * environment it will spawn it with (`env.ts`):
 *
 * - `claude --version` — `2.1.280 (Claude Code)`;
 * - `claude auth status --json` — `loggedIn`, `authMethod`, `apiProvider`, and
 *   the account's email once signed in. It exits 1 when signed out and still
 *   prints the document, so the output is read whatever the exit code;
 * - the model list, which only the CLI's SDK handshake carries: a query whose
 *   prompt never yields a message starts the CLI, completes its initialize
 *   exchange — models, slash commands, account — and is torn down. Nothing is sent to the
 *   API, so it costs nothing (`fixtures/claude/probe/`).
 */

import * as NodeOS from "node:os";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ModelOption } from "@poseidon/contracts/connectors";
import type { HarnessCommand } from "@poseidon/contracts/harnessCommands";
import type { ConnectorProbe } from "@poseidon/connector-sdk/definition";
import { ProbeFailed } from "@poseidon/connector-sdk/definition";
import * as Effect from "effect/Effect";

import { resolveBinary, terminalCommand, type ResolvedBinary } from "./binary";
import { execClaude, type Ran } from "./cli";
import { toHarnessCommands } from "./commands";
import type { ClaudeConnectorConfig } from "./configSchema";
import { childEnv } from "./env";
import { CLAUDE_KIND } from "./kind";
import { toModelOptions } from "./models";
import { makeProcessGroup } from "./spawn";

/**
 * The oldest release the connector has been recorded against — the floor the
 * probe warns below, never a version it asks for.
 */
export const OLDEST_TESTED_VERSION = "2.1.280";

/** How a signed-out CLI is signed in, as its own `auth --help` lists it. */
export const LOGIN_ARGS: ReadonlyArray<string> = ["auth", "login"];

/** How a machine without the CLI gets it: the npm package it ships as. */
export const INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code";

/** How long the zero-turn handshake may take before the probe gives up on it. */
const INITIALIZE_TIMEOUT = "20 seconds";

const runBinary = (
  binary: ResolvedBinary,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): Effect.Effect<Ran, ProbeFailed> =>
  // A neutral directory: neither question depends on one, and the server's
  // own working directory is nothing the CLI needs to see.
  execClaude(binary, args, { cwd: NodeOS.tmpdir(), env }).pipe(
    Effect.mapError((message) => new ProbeFailed({ kind: CLAUDE_KIND, message })),
  );

// ── output parsing ─────────────────────────────────────────────

/** `2.1.280 (Claude Code)` → `2.1.280`; anything else → undefined. */
export const parseVersion = (output: string): string | undefined =>
  /(\d+\.\d+\.\d+)/.exec(output)?.[1];

const numbers = (version: string): ReadonlyArray<number> => version.split(".").map(Number);

/**
 * Strictly older than the oldest release we have recordings for. A version
 * that does not parse is fine: refusing an unfamiliar version string would be
 * the pin this connector deliberately does not have.
 */
export const isBelowOldestTested = (version: string): boolean => {
  const parsed = parseVersion(version);
  if (parsed === undefined) return false;
  const have = numbers(parsed);
  const floor = numbers(OLDEST_TESTED_VERSION);
  for (let index = 0; index < 3; index += 1) {
    if (have[index]! !== floor[index]!) return have[index]! < floor[index]!;
  }
  return false;
};

export interface AuthStatus {
  readonly auth: ConnectorProbe["auth"];
  readonly account?: string;
}

/**
 * `auth status --json` → present when `loggedIn` is true, absent when it is
 * false, unknown when the output is not that document.
 */
export const parseAuthStatus = (stdout: string): AuthStatus => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { auth: "unknown" };
  }
  if (typeof parsed !== "object" || parsed === null) return { auth: "unknown" };
  const record = parsed as { loggedIn?: unknown; email?: unknown };
  if (typeof record.loggedIn !== "boolean") return { auth: "unknown" };
  return {
    auth: record.loggedIn ? "present" : "absent",
    ...(typeof record.email === "string" && record.email !== "" ? { account: record.email } : {}),
  };
};

// ── the zero-turn handshake ────────────────────────────────────

export interface Initialization {
  readonly models: ReadonlyArray<ModelOption>;
  /** The CLI's built-in and bundled slash commands (`commands.ts`). */
  readonly commands: ReadonlyArray<HarnessCommand>;
  readonly account?: string;
}

/**
 * Starts the CLI through the SDK with a prompt that never yields, reads the
 * initialize response, and stops the CLI again — its whole process group,
 * waited for, before this returns.
 */
export const readInitialization = (input: {
  readonly binary: ResolvedBinary;
  readonly env: Record<string, string>;
  readonly cwd: string;
}): Effect.Effect<Initialization, ProbeFailed> =>
  Effect.gen(function* () {
    const group = makeProcessGroup();
    const abort = new AbortController();
    const never: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<SDKUserMessage>>((resolve) =>
            abort.signal.addEventListener(
              "abort",
              () => resolve({ done: true, value: undefined }),
              {
                once: true,
              },
            ),
          ),
      }),
    };
    const release = Effect.gen(function* () {
      abort.abort();
      yield* group.stop;
    });
    return yield* Effect.tryPromise({
      try: async () => {
        const session = query({
          prompt: never,
          options: {
            pathToClaudeCodeExecutable: input.binary.command,
            env: input.env,
            cwd: input.cwd,
            abortController: abort,
            spawnClaudeCodeProcess: group.spawn,
            // A handshake, not a session: none of the user's settings, hooks
            // or project files is loaded, and nothing is written to disk.
            settingSources: [],
            persistSession: false,
          },
        });
        const init = await session.initializationResult();
        const email = init.account?.email;
        return {
          models: toModelOptions(init.models),
          commands: toHarnessCommands(init.commands),
          ...(typeof email === "string" && email !== "" ? { account: email } : {}),
        };
      },
      catch: (cause) =>
        new ProbeFailed({
          kind: CLAUDE_KIND,
          message: `initialize failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: INITIALIZE_TIMEOUT,
        orElse: () =>
          Effect.fail(new ProbeFailed({ kind: CLAUDE_KIND, message: "initialize timed out" })),
      }),
      Effect.ensuring(release),
    );
  });

// ── the probe ──────────────────────────────────────────────────

const detailOf = (result: Ran): string => result.stderr.trim() || result.stdout.trim();

export const probe = (
  config: ClaudeConnectorConfig,
  /** How the binary is found; a test swaps in a narrower search. */
  resolve: (config: ClaudeConnectorConfig) => ResolvedBinary | null = (options) =>
    resolveBinary(options, process.env),
): Effect.Effect<ConnectorProbe, ProbeFailed> =>
  Effect.gen(function* () {
    const probedAt = new Date().toISOString();
    const binary = resolve(config);
    if (binary === null) {
      return {
        status: "not-installed" as const,
        probedAt,
        installed: false,
        message: "claude not found on PATH or in the usual install directories",
        installCommand: INSTALL_COMMAND,
        auth: "unknown" as const,
        models: [],
        warnings: [],
      };
    }
    const env = childEnv(process.env, config);
    const loginCommand = terminalCommand(binary, LOGIN_ARGS, env.CLAUDE_CONFIG_DIR);

    const versionRun = yield* runBinary(binary, ["--version"], env);
    const version = parseVersion(versionRun.stdout);
    if (versionRun.code !== 0 || version === undefined) {
      return {
        status: "error" as const,
        probedAt,
        binaryPath: binary.display,
        installed: true,
        message: `--version exited ${versionRun.code}: ${detailOf(versionRun)}`,
        auth: "unknown" as const,
        models: [],
        warnings: [],
      };
    }
    const warnings: Array<string> = [];
    if (isBelowOldestTested(version)) {
      warnings.push(
        `claude ${version} is older than ${OLDEST_TESTED_VERSION}, the oldest release Poseidon has been tested against`,
      );
    }

    const authRun = yield* runBinary(binary, ["auth", "status", "--json"], env);
    const status = parseAuthStatus(authRun.stdout);

    const initialization = yield* readInitialization({ binary, env, cwd: NodeOS.tmpdir() }).pipe(
      Effect.catch((error) => {
        warnings.push(error.message);
        return Effect.succeed<Initialization>({ models: [], commands: [] });
      }),
    );
    const account = status.account ?? initialization.account;

    return {
      status: status.auth === "absent" ? ("not-authenticated" as const) : ("ready" as const),
      probedAt,
      binaryPath: binary.display,
      installed: true,
      version,
      auth: status.auth,
      ...(account === undefined ? {} : { account }),
      loginCommand,
      ...(status.auth === "absent" ? { message: `not signed in — run \`${loginCommand}\`` } : {}),
      models: initialization.models,
      warnings,
    };
  });
