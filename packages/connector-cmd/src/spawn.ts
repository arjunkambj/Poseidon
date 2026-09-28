/**
 * Spawning the Command Code CLI for one headless turn.
 *
 * Print mode is one turn per process — `cmd -p "<prompt>"
 * --output-format json --verbose -t --skip-onboarding --no-auto-update` plus
 * the flags a turn's settings ask for. The process runs `detached` so it leads
 * its own process group: interrupt and close signal the group (`kill(-pid)`),
 * which is the only way to take the harness's own children with it.
 *
 * `envAllowlist` is the leak guard: of the *inherited*
 * environment the child sees only the handful of variables a CLI legitimately
 * needs; the operator's `extraEnv` passes by name, because naming it is the
 * decision; and the session's own `POSEIDON_*` control plane is applied last so
 * nothing can override it. Nothing starting with `POSEIDON_SERVER_`,
 * `ANTHROPIC_` or `OPENAI_` reaches the child by any of the three routes.
 */

import { execFile, spawn } from "node:child_process";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

// ── argv ───────────────────────────────────────────────────────

export interface BuildArgsInput {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly effort?: string;
  /** approvals run through our hook; `permissionMode: "plan"` replaces it. */
  readonly yolo?: boolean;
  readonly permissionMode?: "standard" | "plan" | "auto-accept";
  readonly maxTurns?: number;
  readonly addDir?: ReadonlyArray<string>;
  /**
   * Tools a headless run withholds unless asked for by name (`--tools-enable`).
   * `ask_user_question` is the one we need: see `TOOLS_ENABLED`.
   */
  readonly toolsEnable?: ReadonlyArray<string>;
  /** Omit the session record entirely (`--no-session`, probe turns). */
  readonly noSession?: boolean;
  /**
   * Extra skill directories, each a directory of `<name>/SKILL.md` folders
   * (`--skill <path>`, repeatable): the enabled plugins' skills.
   */
  readonly skills?: ReadonlyArray<string>;
}

/**
 * The withheld tools every turn asks for.
 *
 * `cmd --help`: "--tools-enable <names>  -p: enable specific withheld tools by
 * name". `ask_user_question` is withheld, and the recordings show exactly what
 * that costs: in `fixtures/cmd/question/` — the connector's own argv — the model
 * is told to use the tool, cannot, and asks its question as prose that no card
 * ever renders. With the flag (`fixtures/cmd/question-tools/`) the tool fires,
 * PreToolUse receives the real `questions[]` payload, and the deny-with-answers
 * bridge answers it with the user's own words.
 *
 * Only this one is listed. `--tools-all` would also un-withhold whatever else a
 * headless run hides, sight unseen.
 */
export const TOOLS_ENABLED: ReadonlyArray<string> = ["ask_user_question"];

/** The headless argv, in a stable order tests can assert. */
export const buildArgs = (input: BuildArgsInput): Array<string> => {
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "json",
    "--verbose",
    "-t",
    "--skip-onboarding",
    "--no-auto-update",
  ];
  if (input.noSession === true) {
    args.push("--no-session");
  } else if (input.sessionId !== undefined) {
    args.push("--session", input.sessionId);
  }
  if (input.model !== undefined) {
    args.push("--model", input.model);
  }
  if (input.effort !== undefined) {
    args.push("--effort", input.effort);
  }
  if (input.permissionMode !== undefined) {
    args.push("--permission-mode", input.permissionMode);
  }
  if (input.yolo === true) {
    args.push("--yolo");
  }
  if (input.maxTurns !== undefined) {
    args.push("--max-turns", String(input.maxTurns));
  }
  for (const dir of input.addDir ?? []) {
    args.push("--add-dir", dir);
  }
  for (const tool of input.toolsEnable ?? []) {
    args.push("--tools-enable", tool);
  }
  for (const dir of input.skills ?? []) {
    args.push("--skill", dir);
  }
  return args;
};

// ── environment ────────────────────────────────────────────────

/**
 * Exact names the child always keeps. The second row is what a CLI needs to
 * reach the network and git in the real world: the ssh agent for git-over-ssh
 * inside shell commands, and the corporate-proxy variables its own API calls
 * depend on.
 */
const BASE_ENV = new Set([
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
]);

/**
 * Prefixes that pass the allowlist — `LC_*` locales, Command Code's own
 * credential override, and our `POSEIDON_*` control plane.
 */
const PASS_PREFIXES = ["LC_", "POSEIDON_"];

/**
 * What must never reach the harness, even through `extraEnv`: our own server
 * internals and other vendors' credentials.
 */
const DROP_PREFIXES = ["POSEIDON_SERVER_", "ANTHROPIC_", "OPENAI_"];

/**
 * Names only the session gets to set.
 *
 * `POSEIDON_HOOK_URL`, `POSEIDON_HOOK_TICKET_FILE` and `POSEIDON_MCP_TOKEN` are
 * the approval gate's control plane, and `extraEnv` is not a local-only file:
 * it is part of the connector config and is written through the `settings`
 * RPC from the connectors page. Pointing `POSEIDON_HOOK_TICKET_FILE` at a path
 * that does not exist makes the hook script read no bearer, take its "no
 * Poseidon session owns this run" path and exit silently — and under `--yolo`
 * that is every tool call running unapproved while the header still says
 * `approval-required`. So an operator-supplied value of one of these names is
 * dropped the way `POSEIDON_SERVER_` is, and the session's own value is
 * applied last besides.
 */
const RESERVED_PREFIXES = ["POSEIDON_HOOK_", "POSEIDON_MCP_"];
const RESERVED_NAMES = new Set(["POSEIDON_THREAD_ID"]);

const isReserved = (name: string): boolean =>
  RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));

const isDropped = (name: string): boolean =>
  DROP_PREFIXES.some((prefix) => name.startsWith(prefix));

const isAllowed = (name: string): boolean =>
  !isDropped(name) &&
  (BASE_ENV.has(name) ||
    name === "COMMAND_CODE_API_KEY" ||
    PASS_PREFIXES.some((prefix) => name.startsWith(prefix)));

/**
 * The spawn environment: allowlisted inherited variables, then the operator's
 * `extraEnv`, then the session's own control plane — in that order, so
 * Poseidon's keys always win. `extraEnv` used to be spread *after* them, which
 * made one setting on the connectors page enough to switch the approval gate
 * off.
 */
export const envAllowlist = (
  env: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
  /** The session's own `POSEIDON_*` variables. Applied last and never filtered. */
  control: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && isAllowed(name)) {
      out[name] = value;
    }
  }
  // The operator naming a variable *is* the decision, so `extra` is filtered by
  // the deny half only. Running it through the inherited-env allowlist as well
  // silently dropped everything outside the ten-name base list — including
  // `CMD_LOCAL_ONLY=1`, the env form of `--local-only`, which an operator sets
  // precisely to keep their traffic off Command Code and which went on being
  // sent there anyway; and `NODE_OPTIONS`, `GH_TOKEN`, `TZ` and every corporate
  // variable besides. The leak guard the docstring promises is `isDropped`, and
  // it still applies.
  for (const [name, value] of Object.entries(extra)) {
    if (!isDropped(name) && !isReserved(name)) {
      out[name] = value;
    }
  }
  for (const [name, value] of Object.entries(control)) {
    if (!isDropped(name)) {
      out[name] = value;
    }
  }
  return out;
};

// ── the process handle ─────────────────────────────────────────

/** The process refused to spawn or its pipes could not be wired. */
export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly message: string;
}> {}

export interface SpawnSpec {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface CmdProcess {
  readonly pid: number;
  /** Decoded UTF-8 chunks — the NDJSON stream. */
  readonly stdout: Stream.Stream<string, SpawnError>;
  /** `--verbose` progress and the `session: <id>` line; drained, not parsed here. */
  readonly stderr: Stream.Stream<string, SpawnError>;
  /** Sends a signal to the whole process group. */
  readonly signal: (signal: "SIGINT" | "SIGTERM" | "SIGKILL") => Effect.Effect<void>;
  /** Resolves once with the exit code (`-1` when the process died on a signal/error). */
  readonly exitCode: Effect.Effect<number>;
  /** SIGINT to the group, SIGKILL after 5s, then a descendant sweep. */
  readonly kill: Effect.Effect<void>;
}

const KILL_GRACE = "5 seconds";

/** `kill(-pid)` reaches the group; a process that was not group leader gets the direct kill. */
const signalGroup = (pid: number, signal: "SIGINT" | "SIGTERM" | "SIGKILL"): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    }
  });

/** A `pgrep` that hangs must not hang the server with it. */
const PGREP_TIMEOUT_MS = 5_000;

/**
 * Best-effort sweep: anything still in the process group after the leader
 * died gets a direct SIGKILL. `pgrep -g` lists group members on both Linux
 * and macOS; where it does not exist the sweep quietly does nothing.
 *
 * Asynchronous, because this runs on every interrupt and every session close:
 * `execFileSync` blocks the Node event loop, so for its whole duration the
 * WebSocket, the hook bridge and every timer in the server stopped.
 */
const sweepGroup = (pid: number): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const child = execFile(
      "pgrep",
      ["-g", String(pid)],
      { encoding: "utf8", timeout: PGREP_TIMEOUT_MS, killSignal: "SIGKILL" },
      (_error, stdout) => {
        // pgrep exits 1 when the group is already empty and ENOENT when it is
        // not installed; both leave stdout empty and neither is worth saying.
        for (const line of String(stdout).split("\n")) {
          const member = Number.parseInt(line.trim(), 10);
          if (Number.isFinite(member) && member > 0) {
            try {
              process.kill(member, "SIGKILL");
            } catch {
              // raced us to exit
            }
          }
        }
        resume(Effect.void);
      },
    );
    return Effect.sync(() => {
      child.kill("SIGKILL");
    });
  });

/**
 * Spawns `spec` detached with piped stdio. The returned handle owns the
 * process: closing the surrounding scope kills it, so a leaked handle never
 * leaks a harness.
 */
export const spawnProcess = (spec: SpawnSpec): Effect.Effect<CmdProcess, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const child = yield* Effect.try({
      try: () =>
        spawn(spec.binaryPath, [...spec.args], {
          cwd: spec.cwd,
          env: { ...spec.env },
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      catch: (cause) =>
        new SpawnError({
          message: `spawn ${spec.binaryPath} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });

    // ENOENT and friends arrive on the 'error' event, not at spawn() — wait
    // for the explicit 'spawn' acknowledgement before calling it a process.
    yield* Effect.callback<void, SpawnError>((resume) => {
      const onSpawn = () => {
        child.off("error", onError);
        resume(Effect.succeed(undefined));
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        resume(
          Effect.fail(
            new SpawnError({ message: `spawn ${spec.binaryPath} failed: ${error.message}` }),
          ),
        );
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
      return Effect.sync(() => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      });
    });

    const pid = child.pid;
    if (pid === undefined) {
      return yield* new SpawnError({ message: `spawn ${spec.binaryPath}: no pid` });
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    // The listeners go on once, at spawn, and settle a plain promise. An
    // Effect.callback would re-subscribe on every await and drop its listener
    // when one awaiter is interrupted — which is exactly what the kill ladder
    // does when the grace period wins the race, and it left `kill` waiting on
    // an exit that had already fired.
    const exited = new Promise<number>((resolve) => {
      const done = (code: number | null) => resolve(code ?? -1);
      child.once("exit", done);
      child.once("error", () => done(-1));
      // 'exit' normally beats 'close'; if only close fired, signal death
      // reports as -1 just like a missing code does.
      child.once("close", (code) => done(typeof code === "number" ? code : -1));
    });
    const exitCode: Effect.Effect<number> = Effect.promise(() => exited);

    const signal = (signal_: "SIGINT" | "SIGTERM" | "SIGKILL"): Effect.Effect<void> =>
      signalGroup(pid, signal_);

    const kill: Effect.Effect<void> = Effect.gen(function* () {
      yield* signalGroup(pid, "SIGINT");
      const settled = yield* Effect.raceFirst(
        exitCode.pipe(Effect.as(true)),
        Effect.sleep(KILL_GRACE).pipe(Effect.as(false)),
      );
      if (!settled) {
        yield* signalGroup(pid, "SIGKILL");
      }
      yield* exitCode.pipe(Effect.ignore);
      yield* sweepGroup(pid);
    });

    // A scoped-out handle still owes the OS a dead process.
    yield* Effect.addFinalizer(() => kill.pipe(Effect.ignore));

    const toStream = (readable: NodeJS.ReadableStream | null): Stream.Stream<string, SpawnError> =>
      readable === null
        ? Stream.empty
        : Stream.fromAsyncIterable(
            readable as AsyncIterable<string>,
            (cause) =>
              new SpawnError({
                message: `read from ${spec.binaryPath} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          );

    return {
      pid,
      stdout: toStream(child.stdout),
      stderr: toStream(child.stderr),
      signal,
      exitCode,
      kill,
    };
  });
