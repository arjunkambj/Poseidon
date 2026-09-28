/**
 * Finding and interrogating the `codex` binary.
 *
 * **Version policy.** The connector runs whatever the user has installed and
 * never a copy of its own: the CLI is the user's. `OLDEST_TESTED_VERSION` is
 * only the release the recordings were made at. Below it the probe warns; at
 * or above it, it says nothing.
 *
 * Three questions, asked of the binary the session will spawn and under the
 * environment it will spawn it with (`env.ts`):
 *
 * - `codex --version` — `codex-cli 0.156.1`;
 * - `codex login status` — "Logged in using ChatGPT" (or an API key) when
 *   signed in, "Not logged in" otherwise. It prints to stderr and exits 1 when
 *   signed out, so both streams are read whatever the exit code;
 * - the account and the model list, which only the app-server carries: a
 *   connection is opened, `initialize`, `account/read` and `model/list` are
 *   asked, and it is closed again. No thread is started, so nothing is sent
 *   to the model and it costs nothing (`fixtures/codex/probe/`). A handshake
 *   that fails or hangs is a warning, not a failed probe: the two one-shot
 *   answers still say whether the CLI is there and signed in.
 */

import { execFile } from "node:child_process";
import * as NodeOS from "node:os";
import type { ModelOption } from "@poseidon/contracts/connectors";
import type { ConnectorProbe } from "@poseidon/connector-sdk/definition";
import { ProbeFailed } from "@poseidon/connector-sdk/definition";
import * as Effect from "effect/Effect";

import { resolveBinary, terminalCommand, type ResolvedBinary } from "./binary";
import type { CodexConnectorConfig } from "./configSchema";
import { childEnv } from "./env";
import { initialize, readAccount, readModels } from "./handshake";
import { CODEX_KIND } from "./kind";
import { modelFactsOf, toModelOptions, type CodexModelFacts } from "./models";
import type { Account, GetAccountResponse } from "./protocol";
import { makeRpcClient } from "./rpc";
import { makeProcessGroup } from "./spawn";

/**
 * The oldest release the connector has been recorded against — the floor the
 * probe warns below, never a version it asks for.
 */
export const OLDEST_TESTED_VERSION = "0.156.1";

/** How a signed-out CLI is signed in, as its own `--help` lists it. */
export const LOGIN_ARGS: ReadonlyArray<string> = ["login"];

/**
 * The probe's app-server launch. `--stdio` is the CLI's own spelling of the
 * transport it uses by default, so it changes nothing about the run; it is
 * there so a recording, and its replay, can tell the probe's handshake from a
 * session (`STDIO_JSONRPC_PROBE_MARKER` in the testkit).
 */
export const PROBE_SERVER_ARGS: ReadonlyArray<string> = ["app-server", "--stdio"];

/** How long the zero-turn handshake may take before the probe gives up on it. */
const HANDSHAKE_TIMEOUT = "20 seconds";

/** What the probe and a session start say when nothing resolves. */
export const NOT_FOUND = "codex not found on PATH or in the usual install directories";

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runBinary = (
  binary: ResolvedBinary,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): Effect.Effect<RunResult, ProbeFailed> =>
  Effect.callback<RunResult, ProbeFailed>((resume) => {
    const child = execFile(
      binary.command,
      [...args],
      // A neutral directory: neither question depends on one, and the server's
      // own working directory is nothing the CLI needs to see.
      { cwd: NodeOS.tmpdir(), timeout: 30_000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env },
      (error, stdout, stderr) => {
        if (error !== null && typeof (error as { code?: unknown }).code !== "number") {
          resume(
            Effect.fail(
              new ProbeFailed({ kind: CODEX_KIND, message: `${binary.display}: ${error.message}` }),
            ),
          );
          return;
        }
        const code = error === null ? 0 : (error as { code: number }).code;
        resume(Effect.succeed({ code, stdout, stderr }));
      },
    );
    return Effect.sync(() => child.kill());
  });

// ── output parsing ─────────────────────────────────────────────

/** `codex-cli 0.156.1` → `0.156.1`; anything else → undefined. */
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

/**
 * `login status` → present on "Logged in using …", absent on "Not logged in",
 * unknown on anything else — a config error, say, which the probe reports as
 * a warning instead.
 */
export const parseLoginStatus = (output: string): ConnectorProbe["auth"] =>
  /\bLogged in using\b/i.test(output)
    ? "present"
    : /\bNot logged in\b/i.test(output)
      ? "absent"
      : "unknown";

/** How the account reads on the connectors page: the email, or how it signs in. */
export const describeAccount = (account: Account): string => {
  if (typeof account.email === "string" && account.email !== "") return account.email;
  switch (account.type) {
    case "chatgpt":
      return "ChatGPT";
    case "apiKey":
      return "API key";
    case "amazonBedrock":
      return "Amazon Bedrock";
    default:
      return account.type;
  }
};

/**
 * What `account/read` says about credentials: an account is present; no
 * account is absent when the provider needs an OpenAI login, and present when
 * it needs none.
 */
const authOf = (response: GetAccountResponse): ConnectorProbe["auth"] =>
  response.account !== null ? "present" : response.requiresOpenaiAuth ? "absent" : "present";

// ── the zero-turn handshake ────────────────────────────────────

export interface Handshake {
  readonly models: ReadonlyArray<ModelOption>;
  /** Each model's efforts and default, for the sessions choosing a turn's effort. */
  readonly modelFacts: ReadonlyMap<string, CodexModelFacts>;
  readonly auth: ConnectorProbe["auth"];
  readonly account?: string;
}

/**
 * Opens an app-server connection, asks it for the account and the models, and
 * closes it again — its whole process group, waited for, before this returns.
 */
export const readHandshake = (input: {
  readonly binary: ResolvedBinary;
  readonly env: Record<string, string>;
  readonly cwd: string;
}): Effect.Effect<Handshake, ProbeFailed> =>
  Effect.gen(function* () {
    const group = makeProcessGroup();
    const child = group.spawn({
      command: input.binary.command,
      args: PROBE_SERVER_ARGS,
      cwd: input.cwd,
      env: input.env,
    });
    const rpc = makeRpcClient(child);
    return yield* Effect.gen(function* () {
      yield* initialize(rpc);
      const account = yield* readAccount(rpc);
      const rows = yield* readModels(rpc);
      return {
        models: toModelOptions(rows),
        modelFacts: modelFactsOf(rows),
        auth: authOf(account),
        ...(account.account === null ? {} : { account: describeAccount(account.account) }),
      };
    }).pipe(
      Effect.mapError(
        (error) =>
          new ProbeFailed({ kind: CODEX_KIND, message: `app-server handshake: ${error.message}` }),
      ),
      Effect.timeoutOrElse({
        duration: HANDSHAKE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ProbeFailed({ kind: CODEX_KIND, message: "app-server handshake timed out" }),
          ),
      }),
      Effect.ensuring(group.stop),
    );
  });

// ── the probe ──────────────────────────────────────────────────

const detailOf = (result: RunResult): string => result.stderr.trim() || result.stdout.trim();

export const probe = (
  config: CodexConnectorConfig,
  /** How the binary is found; a test swaps in a narrower search. */
  resolve: (config: CodexConnectorConfig) => ResolvedBinary | null = (options) =>
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
        message: NOT_FOUND,
        auth: "unknown" as const,
        models: [],
        warnings: [],
      };
    }
    const env = childEnv(process.env, config);
    const loginCommand = terminalCommand(binary, LOGIN_ARGS, env.CODEX_HOME);

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
        `codex ${version} is older than ${OLDEST_TESTED_VERSION}, the oldest release Poseidon has been tested against`,
      );
    }

    const loginRun = yield* runBinary(binary, ["login", "status"], env);
    const loggedIn = parseLoginStatus(`${loginRun.stdout}\n${loginRun.stderr}`);
    if (loggedIn === "unknown") {
      warnings.push(`login status exited ${loginRun.code}: ${detailOf(loginRun)}`);
    }

    const handshake = yield* readHandshake({ binary, env, cwd: NodeOS.tmpdir() }).pipe(
      Effect.catch((error) => {
        warnings.push(error.message);
        return Effect.succeed<Handshake>({ models: [], modelFacts: new Map(), auth: "unknown" });
      }),
    );
    const auth = loggedIn === "unknown" ? handshake.auth : loggedIn;

    return {
      status: auth === "absent" ? ("not-authenticated" as const) : ("ready" as const),
      probedAt,
      binaryPath: binary.display,
      installed: true,
      version,
      auth,
      ...(handshake.account === undefined || auth === "absent"
        ? {}
        : { account: handshake.account }),
      loginCommand,
      ...(auth === "absent" ? { message: `not signed in — run \`${loginCommand}\`` } : {}),
      models: handshake.models,
      warnings,
    };
  });
