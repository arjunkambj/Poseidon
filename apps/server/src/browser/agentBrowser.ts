/**
 * The `agent-browser` CLI: binary discovery, the browser bridge handoff, one
 * `--json` invocation against a named session, and the envelope parse.
 *
 * Everything here is argv-form `execFile` — never a shell. A session is just a
 * `--session <name>` argument; the Rust daemon underneath persists between
 * invocations, which is what makes per-call CLI commands cheap.
 *
 * Which browser a session drives is decided once, at layer build, from what
 * the desktop shell handed over (`bridgeConfig`):
 *
 * - **in-app** — the shell runs the browser bridge and gave us its origin and
 *   launch key. A thread's session carries its bridge URL in
 *   `AGENT_BROWSER_CDP`, so the daemon drives that thread's pane webviews and
 *   nothing else. The URL is a capability and never goes in argv, where any
 *   local process can read it.
 * - **disabled** — the shell ran with `POSEIDON_REMOTE_DEBUG=0`. There is no
 *   bridge and no fallback: every call reports the in-app browser disabled.
 * - **owned-chromium** — no desktop at all (the web renderer, or
 *   `pnpm -F server dev`): agent-browser runs its own headless Chrome,
 *   launched with `OWNED_CHROME_ARGS` so it never asks for the OS keychain.
 *
 * Every daemon we start lives in our own agent-browser namespace,
 * `poseidon-<hash of POSEIDON_HOME>` (`namespaceFor`), so `close --all` reaps
 * ours and never the user's own sessions, and two Poseidon homes never share a
 * daemon. `reap` is that `close --all`; a session's `shutdown` is `close`, and
 * when the daemon does not answer even that, a SIGKILL of the pid it wrote to
 * its socket directory.
 *
 * Discovery order: `POSEIDON_AGENT_BROWSER` → `agent-browser` on PATH. The probe
 * runs `--version` once at layer build; a missing binary is not fatal — the
 * service reports `binary: null` and every exec fails with
 * `AgentBrowserUnavailable`, which the pane renders as an install prompt.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { BrowserState } from "@poseidon/contracts/rpc";
import {
  BRIDGE_DISABLED,
  BRIDGE_ENV,
  BRIDGE_KEY_ENV,
  bridgeThreadUrl,
} from "@poseidon/shared/browserBridge";
import { configDir } from "@poseidon/shared/paths";

/**
 * The opening clause of what the pane reads when the binary is missing. The
 * renderer keys its install prompt off it (see
 * `apps/web/src/components/panes/browser/install.ts`), so it is one constant
 * here rather than a sentence written twice.
 */
export const AGENT_BROWSER_MISSING_MESSAGE = "agent-browser is not installed";

/**
 * The whole sentence, naming only what the mode needs: in-app drives the
 * pane's own webviews, so the CLI is enough; owned Chromium also needs the
 * Chrome that `agent-browser install` downloads.
 */
export const agentBrowserMissingMessage = (mode: BrowserState["mode"]): string =>
  mode === "owned-chromium"
    ? `${AGENT_BROWSER_MISSING_MESSAGE}. Install it with \`npm install -g agent-browser\`, ` +
      "then run `agent-browser install` to download the browser it drives."
    : `${AGENT_BROWSER_MISSING_MESSAGE}. Install it with \`npm install -g agent-browser\`.`;

/** What every browser tool answers while the shell has the bridge switched off. */
export const BROWSER_DISABLED_MESSAGE = "the in-app browser is disabled (POSEIDON_REMOTE_DEBUG=0)";

/** A short, stable hex digest: names that end up in a socket path. */
const digest = (text: string, length: number): string =>
  createHash("sha256").update(text).digest("hex").slice(0, length);

/**
 * The daemon session name for a thread: `ade-<12 hex of its id>`.
 *
 * Not the id itself. The daemon's socket is
 * `~/.agent-browser/namespaces/<ns>/run/<session>.sock`, and a Unix socket
 * path is capped at 103 bytes on macOS: a 36-character thread id in our
 * namespace came to 109 on a short home directory, and the CLI refused it.
 * Hashed, the path is about 80 bytes for `/Users/<name>` with a short name.
 */
export const sessionNameFor = (threadId: string): string => `ade-${digest(threadId, 12)}`;

/** Every call gets this long before the child is SIGKILLed (spec: 30s ceiling). */
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * How long `close` gets before the daemon is killed instead. Short: the
 * desktop gives the server 5s between SIGINT and SIGKILL on quit, and every
 * open session closes inside that.
 */
const CLOSE_TIMEOUT_MS = 3_000;

/** How long the boot-time `close --all` gets before it kills what is listed. */
const REAP_TIMEOUT_MS = 5_000;

/** `session list` reads socket files and never waits on a daemon. */
const LIST_TIMEOUT_MS = 2_000;

/** How long the reap waits for closed daemons to exit, and how often it looks. */
const REAP_SETTLE_MS = 3_000;
const SETTLE_POLL_MS = 100;

const now = Effect.clockWith((clock) => clock.currentTimeMillis);

/** A daemon exits this long after its last command if we never close it. */
export const IDLE_TIMEOUT_MS = 300_000;

/** `AgentBrowserError.code` for a child that ran past its timeout and was killed. */
export const TIMEOUT_CODE = "timeout";

/**
 * Our agent-browser namespace for one Poseidon home. The daemon keeps its
 * sockets, pids and per-session state under `~/.agent-browser/namespaces/<ns>`,
 * so everything we start stays out of the user's own default namespace, and
 * `close --all` in it closes ours alone.
 */
export const namespaceFor = (home: string): string => `poseidon-${digest(home, 8)}`;

/** Everything agent-browser keeps for one namespace. */
const namespaceDir = (home: string, namespace: string): string =>
  join(home, ".agent-browser", "namespaces", namespace);

/**
 * Where a daemon writes its pid: `<socketDir>/<session>.pid`, with the socket
 * directory `session info` reports (recorded in
 * `packages/testkit/fixtures/agent-browser/cli-reap`). The child never
 * inherits an `AGENT_BROWSER_*` that could move it.
 */
export const daemonPidPath = (home: string, namespace: string, session: string): string =>
  join(namespaceDir(home, namespace), "run", `${session}.pid`);

/**
 * The config file every invocation is pointed at, under the Poseidon home.
 *
 * Left to itself agent-browser reads `~/.agent-browser/config.json` and then
 * `./agent-browser.json` on every run, and those carry the knobs the env
 * allowlist below refuses (`autoConnect`, `allowFileAccess`) and stronger
 * ones: `executablePath`, `args`, `extensions`, `initScripts`, `headers` and
 * `plugins`. Naming a file in `AGENT_BROWSER_CONFIG` replaces both lookups
 * (checked against 0.38.1: a broken user config is then never read). The
 * file must exist and parse, so `ensureOwnConfig` writes it before a run
 * whenever it holds anything but `{}` — an edit to it does not carry over.
 */
export const ownConfigPath = (poseidonHome: string): string =>
  join(poseidonHome, "agent-browser.json");

const OWN_CONFIG = "{}\n";

/** Puts `{}` at `path` unless it is already there; the swap is a rename. */
export const ensureOwnConfig = (path: string): Effect.Effect<void> =>
  Effect.tryPromise(async () => {
    const current = await readFile(path, "utf8").catch(() => null);
    if (current === OWN_CONFIG) return;
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temp, OWN_CONFIG, { mode: 0o600 });
    await rename(temp, path);
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`browser: could not write ${path}: ${String(error)}`),
    ),
  );

/**
 * The env one session's invocations run with, beyond the allowlist.
 *
 * The idle timeout is the safety net behind `close`: a daemon we never got to
 * close (a crashed server) still reaps itself. The config is ours alone
 * (`ownConfigPath`).
 */
export const sessionEnvFor = (
  namespace: string,
  configPath: string,
  extra?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => ({
  AGENT_BROWSER_IDLE_TIMEOUT_MS: String(IDLE_TIMEOUT_MS),
  AGENT_BROWSER_NAMESPACE: namespace,
  AGENT_BROWSER_CONFIG: configPath,
  ...extra,
});

/**
 * What the `agent-browser` child — and the Chromium it drives — may inherit.
 *
 * The connector keeps the harness's environment to a named allowlist for
 * exactly one reason, and `agent-browser` is the component that then visits
 * untrusted web pages: it is a third-party CLI with an auto-connect, a plugin
 * system and an auth vault of its own. So the operator's `ANTHROPIC_*` and
 * `OPENAI_*` keys, `AWS_*`, `GITHUB_TOKEN` and every `POSEIDON_*` control-plane
 * variable stay out.
 *
 * So do the operator's own `AGENT_BROWSER_*` and `CHROME_*`. They used to pass
 * by prefix, and several of them redirect or loosen the child:
 * `AGENT_BROWSER_CDP` points the daemon at another browser,
 * `AGENT_BROWSER_AUTO_CONNECT` makes it go looking for one, and
 * `AGENT_BROWSER_ALLOW_FILE_ACCESS` lets pages read local files. The only
 * `AGENT_BROWSER_*` values the child sees are the ones this module sets, and
 * `AGENT_BROWSER_CONFIG` among them keeps the same knobs from coming in
 * through a config file instead.
 *
 * The list is here rather than shared with `packages/connector-cmd/src/spawn.ts`
 * because the two children need different things: this one wants the display
 * variables a browser needs, and none of the harness's credential variables.
 */
const BROWSER_ENV = new Set([
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  // A Chrome that has to find a display: X11 and Wayland on Linux, and the
  // per-session bootstrap socket on macOS.
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XAUTHORITY",
]);

const INHERITED_PREFIXES = ["LC_"];

/** Names only we may set: `extra` passes them, the inherited env never does. */
const OWN_PREFIX = "AGENT_BROWSER_";

/** The environment one invocation runs with: the allowlist, plus our own. */
export const browserEnv = (
  env: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  const inherited = (name: string): boolean =>
    BROWSER_ENV.has(name) || INHERITED_PREFIXES.some((prefix) => name.startsWith(prefix));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && inherited(name)) {
      out[name] = value;
    }
  }
  // `extra` is ours — the idle timeout, the bridge URL — and is not filtered
  // out from under itself, but it cannot smuggle a name the list refuses either.
  for (const [name, value] of Object.entries(extra)) {
    if (inherited(name) || name.startsWith(OWN_PREFIX)) {
      out[name] = value;
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// The bridge handoff

/**
 * What the desktop shell told us about the browser bridge: where it is and the
 * launch key to mint thread URLs with, that it is switched off, or — `null` —
 * nothing, because there is no shell.
 */
export type BridgeConfig =
  | { readonly base: string; readonly key: string }
  | typeof BRIDGE_DISABLED
  | null;

/**
 * Owned Chromium's launch args (`AGENT_BROWSER_ARGS`, comma separated): no
 * macOS "Chromium Safe Storage" keychain prompt, no Linux keyring unlock.
 * agent-browser adds `--headless=new` itself; recent releases add these too.
 */
export const OWNED_CHROME_ARGS = "--use-mock-keychain,--password-store=basic";

/**
 * A session command's launch env: owned Chromium only, and never for `close`,
 * because set args make the CLI send `launch` first — a Chrome only to close.
 */
export const launchEnvFor = (
  bridge: BridgeConfig,
  argv: ReadonlyArray<string>,
): Readonly<Record<string, string>> =>
  bridge === null && argv[0] !== "close" ? { AGENT_BROWSER_ARGS: OWNED_CHROME_ARGS } : {};

const LAUNCH_KEY = /^[0-9a-f]{64}$/;

/**
 * Reads the bridge handoff out of an environment.
 *
 * A shell that announced a bridge but handed over something unusable (no key,
 * a key of the wrong shape, an origin that is not loopback) gets `disabled`,
 * not `null`: `null` means owned Chromium, and a desktop must never fall back
 * to a headless browser the user cannot see.
 */
export const readBridgeConfig = (
  env: Readonly<Record<string, string | undefined>>,
): BridgeConfig => {
  const base = env[BRIDGE_ENV]?.trim();
  if (base === undefined || base === "") return null;
  if (base === BRIDGE_DISABLED) return BRIDGE_DISABLED;
  const key = env[BRIDGE_KEY_ENV]?.trim() ?? "";
  if (!LAUNCH_KEY.test(key)) return BRIDGE_DISABLED;
  try {
    bridgeThreadUrl(base, key, "probe");
  } catch {
    return BRIDGE_DISABLED;
  }
  return { base, key };
};

/**
 * Reads the handoff and removes it from `env`, so nothing this process spawns
 * later — a terminal, a harness — inherits the launch key. The harness spawn
 * drops the `POSEIDON_SERVER_` prefix as well; this is the belt to that brace.
 */
export const takeBridgeConfig = (env: Record<string, string | undefined>): BridgeConfig => {
  const config = readBridgeConfig(env);
  delete env[BRIDGE_ENV];
  delete env[BRIDGE_KEY_ENV];
  return config;
};

/** The service's mode, as `BrowserState` reports it, for a handoff. */
export const modeFor = (bridge: BridgeConfig): BrowserState["mode"] =>
  bridge === null ? "owned-chromium" : bridge === BRIDGE_DISABLED ? "disabled" : "in-app";

// ---------------------------------------------------------------------------
// One invocation

const Envelope = Schema.Struct({
  success: Schema.Boolean,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeEnvelope = Schema.decodeUnknownExit(Schema.fromJsonString(Envelope));

/** The CLI ran and reported failure (`success: false`), or could not be run. */
export class AgentBrowserError extends Data.TaggedError("AgentBrowserError")<{
  readonly command: string;
  readonly message: string;
  /** How the daemon classified the failure — e.g. `tab_gone`. */
  readonly code: string | null;
  readonly data: unknown;
}> {}

/** The binary is not installed — the pane shows the install prompt. */
export class AgentBrowserUnavailable extends Data.TaggedError("AgentBrowserUnavailable")<{
  readonly message: string;
}> {}

/** What one child run left behind; `error` is set when it exited non-zero or died. */
export interface ChildResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string | null;
  /** The child ran past its timeout and was killed. */
  readonly timedOut?: boolean;
}

/**
 * Runs the binary once. Tests replace it to replay recorded envelopes and to
 * see exactly what argv and env the child would have got.
 */
export type ChildRunner = (
  binary: string,
  args: ReadonlyArray<string>,
  options: { readonly env: Record<string, string>; readonly timeoutMs: number },
) => Effect.Effect<ChildResult>;

const runChild: ChildRunner = (binary, args, options) =>
  Effect.callback<ChildResult>((resume) => {
    const child = execFile(
      binary,
      [...args],
      {
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        env: options.env,
      },
      (error, stdout, stderr) =>
        resume(
          Effect.succeed({
            stdout: String(stdout),
            stderr: String(stderr),
            error: error === null ? null : error.message,
            // `killed` is set only by execFile's own timeout here: our
            // interrupt kills the child too, but nobody reads that result.
            timedOut: error !== null && error.killed === true,
          }),
        ),
    );
    return Effect.sync(() => child.kill("SIGKILL"));
  });

/**
 * The daemon's failure class. `data.code` when it sets one; a pinned session
 * whose tab is gone says so only in its message — `tab_gone: bound tab is
 * gone (…)` with `data: {targetId, lastUrl}` (recorded in
 * `packages/testkit/fixtures/agent-browser/cli-tab-gone`).
 */
const codeOf = (error: string | null | undefined, data: unknown): string | null => {
  if (typeof data === "object" && data !== null && "code" in data) {
    return String((data as { code: unknown }).code);
  }
  const prefix = /^([a-z_]+):/.exec(error ?? "");
  return prefix?.[1] === "tab_gone" ? "tab_gone" : null;
};

const toRecord = (data: unknown): Record<string, unknown> =>
  typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : { value: data };

/** One child run's output as the command's result. */
export const decodeResult = (
  command: string,
  result: ChildResult,
): Effect.Effect<Record<string, unknown>, AgentBrowserError> => {
  const parsed = decodeEnvelope(result.stdout);
  if (Exit.isFailure(parsed)) {
    return Effect.fail(
      new AgentBrowserError({
        command,
        message:
          result.error !== null
            ? `${result.error}: ${result.stderr.trim()}`
            : `unparseable output: ${result.stdout.slice(0, 200)}`,
        code: null,
        data: null,
      }),
    );
  }
  const envelope = parsed.value;
  if (!envelope.success) {
    return Effect.fail(
      new AgentBrowserError({
        command,
        message: envelope.error ?? "agent-browser command failed",
        code: codeOf(envelope.error, envelope.data),
        data: envelope.data ?? null,
      }),
    );
  }
  return Effect.succeed(toRecord(envelope.data));
};

export interface ExecOptions {
  readonly timeoutMs?: number;
}

type ExecError = AgentBrowserError | AgentBrowserUnavailable;

/** An exec that failed because the child ran out of time and was killed. */
export const isTimeout = (error: ExecError): boolean =>
  error._tag === "AgentBrowserError" && error.code === TIMEOUT_CODE;

/** One thread's invocation channel: `agent-browser --session <sessionNameFor> --json <argv>`. */
export interface AgentBrowserSession {
  readonly session: string;
  readonly exec: (
    argv: ReadonlyArray<string>,
    options?: ExecOptions,
  ) => Effect.Effect<Record<string, unknown>, ExecError>;
  /**
   * Stops the thread's daemon: `close`, and when the daemon does not answer
   * that in time either, a SIGKILL. Never fails. In in-app mode `close` sends
   * no CDP (spike G), so the pane's tabs survive it: they are the user's.
   */
  readonly shutdown: Effect.Effect<void>;
}

/**
 * Kills the daemon behind a session that will not answer `close`. The real
 * one reads the pid file; tests replace it to see who would have been killed.
 */
export type DaemonKiller = (session: string) => Effect.Effect<void>;

/** The command name of a live pid, or `null` (no such process, or no `ps`). */
const commandOf = (pid: number): Effect.Effect<string | null> =>
  process.platform === "win32"
    ? Effect.succeed(null)
    : runChild("ps", ["-o", "comm=", "-p", String(pid)], {
        env: browserEnv(process.env),
        timeoutMs: LIST_TIMEOUT_MS,
      }).pipe(Effect.map((result) => (result.error === null ? result.stdout.trim() : null)));

/** The direct children of a pid: an owned-mode daemon's Chrome. */
const childrenOf = (pid: number): Effect.Effect<ReadonlyArray<number>> =>
  runChild("pgrep", ["-P", String(pid)], {
    env: browserEnv(process.env),
    timeoutMs: LIST_TIMEOUT_MS,
  }).pipe(
    Effect.map((result) =>
      result.stdout
        .split(/\s+/)
        .map((entry) => Number.parseInt(entry, 10))
        .filter((child) => Number.isInteger(child) && child > 1),
    ),
  );

const sigkill = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone between the check and the kill: what we wanted.
    }
  });

/**
 * SIGKILLs the daemon whose pid is in `pidPath`, and its children first — in
 * owned mode that is the Chrome it launched, which would otherwise outlive
 * it. A pid file outlives its daemon, and the pid may since have been reused,
 * so only a process that is still agent-browser is killed. Anything else is
 * logged and left to the daemon's idle timeout.
 */
const killDaemonAt = (pidPath: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise(() => readFile(pidPath, "utf8")).pipe(Effect.option);
    const pid = text._tag === "Some" ? Number.parseInt(text.value.trim(), 10) : Number.NaN;
    if (!Number.isInteger(pid) || pid <= 1) {
      yield* Effect.logWarning(`browser: no daemon pid at ${pidPath}; left to its idle timeout`);
      return;
    }
    const command = yield* commandOf(pid);
    if (command === null || !command.includes("agent-browser")) {
      yield* Effect.logWarning(`browser: pid ${pid} is not an agent-browser daemon; not killed`);
      return;
    }
    const children = yield* childrenOf(pid);
    yield* Effect.forEach(children, sigkill, { discard: true });
    yield* sigkill(pid);
    yield* Effect.logWarning(`browser: killed agent-browser daemon ${pid}, which did not close`);
  });

export class AgentBrowser extends Context.Service<
  AgentBrowser,
  {
    /** Absolute path or bare name when found, `null` when the probe failed. */
    readonly binary: string | null;
    readonly version: string | null;
    /** Which browser every session drives; fixed for the server's life. */
    readonly mode: BrowserState["mode"];
    /** The agent-browser namespace every daemon of ours runs in. */
    readonly namespace: string;
    /** The thread's session: its own bridge URL in in-app mode. */
    readonly session: (threadId: string) => AgentBrowserSession;
    /**
     * `close --all` in our namespace: the daemons a crashed or killed run left
     * behind. Waits for them to exit, kills what does not close in time, and
     * clears the namespace's leftover files. Bounded; never fails.
     */
    readonly reap: Effect.Effect<void>;
  }
>()("server/browser/AgentBrowser") {
  static readonly layer = Layer.effect(
    AgentBrowser,
    Effect.gen(function* () {
      const announced = process.env[BRIDGE_ENV]?.trim();
      const bridge = takeBridgeConfig(process.env);
      if (bridge === BRIDGE_DISABLED && announced !== BRIDGE_DISABLED) {
        yield* Effect.logWarning("browser: the shell's bridge handoff was unusable; disabled");
      }
      const binaryOverride = process.env.POSEIDON_AGENT_BROWSER?.trim();
      const probe = yield* runChild(binaryOverride ?? "agent-browser", ["--version"], {
        env: browserEnv(process.env),
        timeoutMs: 10_000,
      });
      const found = probe.error === null;
      return makeAgentBrowser({
        binary: binaryOverride ?? (found ? "agent-browser" : null),
        version: found ? probe.stdout.trim() : null,
        bridge,
        prepare: ensureOwnConfig,
      });
    }),
  );
}

/**
 * The service over an explicit binary, handoff and runner. The layer builds it
 * from the process; tests build it over a recording.
 */
export const makeAgentBrowser = (options: {
  readonly binary: string | null;
  readonly version: string | null;
  readonly bridge: BridgeConfig;
  /** The environment the allowlist filters; the server's own by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Our namespace; by default the one for the environment's `POSEIDON_HOME`. */
  readonly namespace?: string;
  /** The config every run is pointed at; by default `ownConfigPath` of `POSEIDON_HOME`. */
  readonly configPath?: string;
  /**
   * Runs before every invocation: the layer puts `{}` at `configPath`
   * (`ensureOwnConfig`). Nothing by default, so tests over a recorded runner
   * write no files.
   */
  readonly prepare?: (configPath: string) => Effect.Effect<void>;
  readonly run?: ChildRunner;
  readonly kill?: DaemonKiller;
}): AgentBrowser["Service"] => {
  const run = options.run ?? runChild;
  const bridge = options.bridge;
  const env = options.env ?? process.env;
  const namespace = options.namespace ?? namespaceFor(configDir(env));
  const configPath = options.configPath ?? ownConfigPath(configDir(env));
  const prepare = options.prepare?.(configPath) ?? Effect.void;
  const home = env.HOME ?? homedir();
  const kill: DaemonKiller =
    options.kill ?? ((session) => killDaemonAt(daemonPidPath(home, namespace, session)));
  const missingMessage = agentBrowserMissingMessage(modeFor(bridge));

  /** One run of the binary in our namespace; `extra` is our own session env. */
  const invoke = (
    argv: ReadonlyArray<string>,
    invocation: {
      readonly session?: string;
      readonly extra?: Readonly<Record<string, string>>;
      readonly timeoutMs: number;
    },
  ): Effect.Effect<Record<string, unknown>, ExecError> =>
    Effect.suspend((): Effect.Effect<Record<string, unknown>, ExecError> => {
      const binary = options.binary;
      if (binary === null) {
        return Effect.fail(new AgentBrowserUnavailable({ message: missingMessage }));
      }
      const command = `agent-browser ${argv.join(" ")}`;
      const args = [
        ...(invocation.session === undefined ? [] : ["--session", invocation.session]),
        "--json",
        ...argv,
      ];
      return Effect.andThen(
        prepare,
        run(binary, args, {
          env: browserEnv(env, sessionEnvFor(namespace, configPath, invocation.extra)),
          timeoutMs: invocation.timeoutMs,
        }),
      ).pipe(
        Effect.flatMap((result) =>
          result.timedOut === true
            ? Effect.fail(
                new AgentBrowserError({
                  command,
                  message: `${command} timed out after ${Math.round(invocation.timeoutMs / 1000)}s`,
                  code: TIMEOUT_CODE,
                  data: null,
                }),
              )
            : decodeResult(command, result),
        ),
      );
    });

  const session = (threadId: string): AgentBrowserSession => {
    const name = sessionNameFor(threadId);
    const exec = (
      argv: ReadonlyArray<string>,
      execOptions: ExecOptions = {},
    ): Effect.Effect<Record<string, unknown>, ExecError> =>
      Effect.suspend((): Effect.Effect<Record<string, unknown>, ExecError> => {
        if (bridge === BRIDGE_DISABLED) {
          return Effect.fail(
            new AgentBrowserError({
              command: `agent-browser ${argv.join(" ")}`,
              message: BROWSER_DISABLED_MESSAGE,
              code: null,
              data: null,
            }),
          );
        }
        // The bridge URL goes in the child's env, never its argv.
        let cdp: string | undefined;
        if (bridge !== null) {
          try {
            cdp = bridgeThreadUrl(bridge.base, bridge.key, threadId);
          } catch (error) {
            return Effect.fail(
              new AgentBrowserError({
                command: `agent-browser ${argv.join(" ")}`,
                message: String(error),
                code: null,
                data: null,
              }),
            );
          }
        }
        return invoke(argv, {
          session: name,
          extra: cdp === undefined ? launchEnvFor(bridge, argv) : { AGENT_BROWSER_CDP: cdp },
          timeoutMs: execOptions.timeoutMs ?? COMMAND_TIMEOUT_MS,
        });
      });
    const shutdown = exec(["close"], { timeoutMs: CLOSE_TIMEOUT_MS }).pipe(
      Effect.asVoid,
      Effect.catch((error) => (isTimeout(error) ? kill(name) : Effect.void)),
    );
    return { session: name, exec, shutdown };
  };

  /** The sessions `session list` names; it reads socket files, not daemons. */
  const listed = invoke(["session", "list"], { timeoutMs: LIST_TIMEOUT_MS }).pipe(
    Effect.map((data) =>
      Array.isArray(data.sessions)
        ? data.sessions.filter((entry): entry is string => typeof entry === "string")
        : [],
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  const killAll = (names: ReadonlyArray<string>) =>
    Effect.forEach(names, kill, { concurrency: "unbounded", discard: true });

  /**
   * Waits for `names` to leave `session list`. `close --all` answers before
   * its daemons have exited (recorded in `cli-reap`), and a thread's first
   * call after a restart would start a daemon under the same session name
   * while the old one was still removing its socket. What is still listed
   * when the time is up is returned.
   */
  const settle = (names: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const deadline = (yield* now) + REAP_SETTLE_MS;
      while (true) {
        const live = new Set(yield* listed);
        const remaining = names.filter((name) => live.has(name));
        if (remaining.length === 0 || (yield* now) >= deadline) return remaining;
        yield* Effect.sleep(SETTLE_POLL_MS);
      }
    });

  const closeAll: Effect.Effect<void> = invoke(["close", "--all"], {
    timeoutMs: REAP_TIMEOUT_MS,
  }).pipe(
    Effect.flatMap((data) => {
      const closed = Array.isArray(data.sessions)
        ? data.sessions.filter((entry): entry is string => typeof entry === "string")
        : [];
      if (closed.length === 0) return Effect.void;
      return Effect.andThen(
        Effect.logInfo(`browser: closed ${closed.length} agent-browser daemon(s) left running`),
        Effect.flatMap(settle(closed), killAll),
      );
    }),
    Effect.catch((error) =>
      isTimeout(error)
        ? Effect.flatMap(listed, killAll)
        : Effect.logWarning(`browser: close --all failed: ${error.message}`),
    ),
  );

  // With nothing left running, the namespace's leftovers go too: `close`
  // leaves each session's `.config` and `.target` behind, and the whole
  // directory is ours.
  const reap: Effect.Effect<void> =
    options.binary === null
      ? Effect.void
      : closeAll.pipe(
          Effect.andThen(listed),
          Effect.flatMap((live) =>
            live.length > 0
              ? Effect.void
              : Effect.tryPromise(() =>
                  rm(namespaceDir(home, namespace), { recursive: true, force: true }),
                ).pipe(Effect.ignore),
          ),
        );

  return AgentBrowser.of({
    binary: options.binary,
    version: options.version,
    mode: modeFor(bridge),
    namespace,
    session,
    reap,
  });
};
