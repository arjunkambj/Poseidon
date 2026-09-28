/**
 * Finding and interrogating the `cmd` binary.
 *
 * Resolution lives in `binary.ts` and is shared with the session: the probe
 * used to resolve the binary, report it, and let every turn spawn the bare
 * string `"cmd"` against the server's own PATH instead.
 *
 * **Version policy.** We run whatever the user has installed, at whatever
 * version it is, and we never prefer a pinned copy of our own: the CLI
 * self-updates and the harness is the user's, not ours. Nothing is pinned
 * anywhere — the npx fallback asks for `@latest`, and `OLDEST_TESTED_VERSION`
 * is only the floor our recordings were made at. Below it the probe warns;
 * equal or above it says nothing, today and for every release after.
 *
 * `status --json` answers auth, account and version; `--list-models` feeds the
 * model picker. Both run against the resolved binary with a timeout, and both
 * deliberately go without `--no-auto-update`: a probe is the one moment where
 * letting the CLI upgrade itself is safe and wanted. Turn spawns keep
 * `--no-auto-update` (`buildArgs`), because an upgrade in the middle of a turn
 * would swap the binary under a running conversation.
 */

import { execFile } from "node:child_process";
import type { ModelOption } from "@poseidon/contracts/connectors";
import type { ConnectorProbe } from "@poseidon/connector-sdk/definition";
import { ProbeFailed } from "@poseidon/connector-sdk/definition";
import * as Effect from "effect/Effect";

import { resolveBinary, type ResolvedBinary, terminalCommand } from "./binary";
import type { CmdConnectorConfig } from "./configSchema";
import { EXIT_MESSAGES } from "./exitCodes";
import { modelNameFromId } from "./modelNames";
import { envAllowlist } from "./spawn";

/**
 * Where an insufficient-credits probe sends the user: the page the CLI's own
 * exit-10 message names (`exitCodes.ts`). Only this connector knows it.
 */
export const CMD_ACCOUNT_HELP_URL = "https://commandcode.ai/billing";

/**
 * How a signed-out `cmd` is signed in: the subcommand the CLI's own `--help`
 * lists for it (`fixtures/cmd/probe/help.stdout.txt`) and its exit-3 message
 * names (`exitCodes.ts`). The probe reports it spelled against the binary it
 * resolved (`terminalCommand`), so an npx fallback or a configured path gets a
 * line that runs.
 */
export const CMD_LOGIN_SUBCOMMAND = "login";

/**
 * How a machine without `cmd` gets it: a global install of the npm package the
 * npx fallback runs (`NPX_PACKAGE`). The probe only reports it when nothing
 * resolves, which means `npx` is missing as well — usually Node itself — so
 * the line is what to run once Node is there.
 */
export const CMD_INSTALL_COMMAND = "npm install -g command-code";

/**
 * The oldest release the connector has been recorded against — the floor the
 * probe warns below, never a version it asks for. A newer `cmd` is always fine.
 */
export const OLDEST_TESTED_VERSION = "1.54.0";

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runBinary = (
  binary: ResolvedBinary,
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs: number; readonly env: Record<string, string> },
): Effect.Effect<RunResult, ProbeFailed> =>
  Effect.callback<RunResult, ProbeFailed>((resume) => {
    const child = execFile(
      binary.command,
      [...binary.prefixArgs, ...args],
      {
        timeout: options.timeoutMs,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: options.env,
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof (error as { code?: unknown }).code !== "number") {
          resume(
            Effect.fail(
              new ProbeFailed({
                kind: "cmd",
                message: `${binary.display}: ${error.message}`,
              }),
            ),
          );
          return;
        }
        resume(
          Effect.succeed({
            code: error === null ? 0 : ((error as { code: number }).code ?? 1),
            stdout,
            stderr,
          }),
        );
      },
    );
    return Effect.sync(() => child.kill());
  });

// ── output parsing ─────────────────────────────────────────────

interface StatusJson {
  readonly authenticated?: boolean;
  readonly version?: string;
  readonly user?: string;
  readonly provider?: string;
  readonly model?: string;
  /** Tokens the account's current model can hold — 1048576 on the 1.55.1 capture. */
  readonly context_window?: number;
}

/**
 * The context window `status --json` last reported, per resolved binary.
 *
 * `run_end` carries the tokens a turn used (`nextState.modState.compaction`)
 * and nothing carries the ceiling, so the composer's "Context window used"
 * percentage had no denominator and never rendered. The probe is the one place
 * that asks, it runs at startup before any session and again whenever the
 * connectors page reconciles, so the answer is kept here for the sessions that
 * come after it. Unknown means no `context.updated` is emitted at all, which is
 * exactly what happened before.
 */
const contextWindows = new Map<string, number>();

/** What the last probe of this binary said the context window is. */
export const contextWindowFor = (binaryDisplay: string): number | null =>
  contextWindows.get(binaryDisplay) ?? null;

/** `1.55.1` → [1,55,1]; unparseable → null. */
const parseVersion = (raw: string): Array<number> | null => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};

/**
 * Strictly older than the oldest release we have recordings for. Equal is fine,
 * newer is fine — a version we cannot parse is fine too, because refusing to
 * run on a build whose version string we do not recognize would be the pin this
 * connector deliberately does not have.
 */
export const isBelowOldestTested = (version: string): boolean => {
  const parsed = parseVersion(version);
  const floor = parseVersion(OLDEST_TESTED_VERSION);
  if (parsed === null || floor === null) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index]! !== floor[index]!) {
      return parsed[index]! < floor[index]!;
    }
  }
  return false;
};

/**
 * A model row is `<id><two or more spaces><description>`; a section header is a
 * line with no such gap. Splitting on the column gap rather than on a `/` is
 * what keeps the Anthropic and OpenAI rows — whose ids are bare (`claude-opus-5`,
 * `gpt-6-astra`), not `provider/model` — out of the header bucket.
 */
const MODEL_ROW = /^(\S+)\s{2,}(.+)$/;

/**
 * A model id: `provider/model` or a bare `model`, either optionally carrying a
 * `:tag` suffix (`meituan/longcat-2.0:free`). Never a trailing colon — that is
 * a label like `Docs:`.
 */
const MODEL_ID = /^[a-z0-9](?:[a-z0-9._-]|\/(?=[a-z0-9]))*(?::[a-z0-9._-]+)?$/i;

const EFFORT_MARKER = /\[(low|medium|high|xhigh|max)(?:,(low|medium|high|xhigh|max))*\]/i;

/**
 * Every rung Command Code has been seen to use — what a row with no stated
 * ladder offers. The contract's `minimal` is not among them: nothing recorded
 * shows `--effort minimal`, so offering it would invent a rung.
 */
const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The lines that frame the table instead of listing a model. */
const isTableChrome = (line: string): boolean =>
  line.startsWith("Available models") ||
  line.startsWith("Pass the full id") ||
  line.startsWith("cmd ") ||
  line.startsWith("Docs:");

/**
 * `cmd --list-models` → `ModelOption`s, parsed against the real 1.55.1 and 1.66.0 output
 * recorded in `fixtures/cmd/probe/list-models.stdout.txt` and
 * `fixtures/cmd/probe-list-models-1.66.0.stdout.txt`.
 *
 * The table is two columns under section headers (`Open Source`, `Anthropic`,
 * `OpenAI`, …), which become `family`. The first column is the id; the second
 * is a tagline ("Muse Spark 1.2 at ~95% off"), not a name — the table has no
 * name column — so the label is derived from the id (`modelNameFromId`) and
 * the tagline becomes `description`. A model is free when its id carries a
 * `:free` tag or its tagline says `FREE`; `(default)`, `(recommended)` and
 * `FREE` are markers, stripped from the description. The binary does not print
 * effort ladders today, so `[low,medium]` is honoured where it appears and a
 * row without one offers every rung rather than a ladder nobody measured.
 * Rows under a `(headless only)` header (1.66.0's `typesafe/jev`, which
 * answers typed questions with probabilities) cannot run an agent turn, so
 * they arrive hidden: the pickers leave them out unless Settings turns one on.
 */
export const parseModelList = (output: string): ReadonlyArray<ModelOption> => {
  const models: Array<ModelOption> = [];
  let family = "";
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || isTableChrome(line)) {
      continue;
    }
    const match = MODEL_ROW.exec(line);
    // A lone token is a section header (`Anthropic`, `OpenAI`, `xAI`) unless it
    // is unmistakably an id — `provider/model` never names a family.
    const lone = match === null && MODEL_ID.test(line) && line.includes("/");
    if (!lone && (match === null || !MODEL_ID.test(match[1]!))) {
      family = line.replace(/:$/, "").trim() || family;
      continue;
    }
    const id = lone ? line : match![1]!;
    const description = lone ? "" : (match![2] ?? "");
    const free = id.endsWith(":free") || /\bFREE\b/.test(description);
    const tagline = description
      .replace(/\((?:default|recommended)\)/gi, "")
      .replace(/\bFREE\b/g, "")
      .replace(EFFORT_MARKER, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    const effortMatch = EFFORT_MARKER.exec(description);
    // No marker means the binary said nothing about this model's ladder, and
    // the recorded output has no marker on any of its 70 rows. Assuming
    // low/medium/high was inventing one: every recorded `model_request_end` on
    // the account default reports `"effort":"xhigh"` and `--effort xhigh` is
    // accepted, so the picker hid two rungs the CLI uses by default and
    // picking "high" silently downgraded the run. An unstated ladder narrows
    // nothing.
    const efforts = (
      effortMatch !== null
        ? effortMatch[0]
            .slice(1, -1)
            .split(",")
            .map((entry) => entry.trim().toLowerCase())
        : ALL_EFFORTS
    ) as ModelOption["efforts"];
    models.push({
      id,
      label: modelNameFromId(id),
      family: family === "" ? (id.split("/")[0] ?? id) : family,
      efforts,
      // The contract rejects an empty description; a bare-id row has none.
      ...(tagline === "" ? {} : { description: tagline }),
      ...(/headless only/i.test(family) ? { hidden: true } : {}),
      ...(free ? { free: true } : {}),
      ...(/\bvision\b|\bmultimodal\b/i.test(description) ? { vision: true } : {}),
    });
  }
  return models;
};

/**
 * `status --json` names one model and its context window; `--list-models`
 * prints neither. So the window is carried onto that one row rather than onto
 * every row, which would claim a ceiling for 69 models nobody measured.
 */
const withContextWindow = (
  models: ReadonlyArray<ModelOption>,
  status: StatusJson,
): ReadonlyArray<ModelOption> => {
  const window_ = status.context_window;
  if (status.model === undefined || typeof window_ !== "number" || !Number.isFinite(window_)) {
    return models;
  }
  return models.map((model) =>
    model.id === status.model ? { ...model, contextWindow: Math.trunc(window_) } : model,
  );
};

/**
 * The model Poseidon starts a new thread on when nobody has picked one. Moved to
 * the front of the list so the server's "first model of the routed instance"
 * fallback lands on it — only when the binary actually lists it, so an account
 * or release without it keeps the CLI's own order.
 */
export const PREFERRED_DEFAULT_MODEL = "meta/muse-spark-1.2-contributor";

export const withPreferredFirst = (
  models: ReadonlyArray<ModelOption>,
): ReadonlyArray<ModelOption> => {
  const preferred = models.find((model) => model.id === PREFERRED_DEFAULT_MODEL);
  return preferred === undefined
    ? models
    : [preferred, ...models.filter((model) => model !== preferred)];
};

// ── the probe ──────────────────────────────────────────────────

/** Exit 10: the account is fine, it has simply run out of credit. */
const INSUFFICIENT_CREDITS = 10;

/** The detail line a failing `status` left behind, if it left one. */
const detailOf = (result: RunResult): string => result.stderr.trim() || result.stdout.trim();

export const probe = (
  config: CmdConnectorConfig,
  /** How the binary is found; a test swaps in a narrower search. */
  resolve: (config: CmdConnectorConfig) => ResolvedBinary | null = (options) =>
    resolveBinary(options, process.env),
): Effect.Effect<ConnectorProbe, ProbeFailed> =>
  Effect.gen(function* () {
    const probedAt = new Date().toISOString();
    const binary = resolve(config);
    // The probe's children get the same leak guard the turns do: no
    // POSEIDON_SERVER_*, ANTHROPIC_* or OPENAI_* reaches them — and the
    // operator's extraEnv does, so a COMMAND_CODE_API_KEY supplied there is
    // not reported as "not authenticated" while turns work fine.
    const env = envAllowlist(process.env, config.extraEnv ?? {});
    if (binary === null) {
      return {
        status: "not-installed" as const,
        probedAt,
        installed: false,
        message: "cmd not found on PATH and npx is unavailable",
        installCommand: CMD_INSTALL_COMMAND,
        auth: "unknown" as const,
        models: [],
        warnings: [],
      };
    }

    const loginCommand = terminalCommand(binary, [CMD_LOGIN_SUBCOMMAND]);
    const status = yield* runBinary(binary, ["status", "--json"], { timeoutMs: 30_000, env });
    if (status.code === 3) {
      return {
        status: "not-authenticated" as const,
        probedAt,
        binaryPath: binary.display,
        installed: true,
        message: `not logged in — run \`${loginCommand}\``,
        auth: "absent" as const,
        loginCommand,
        models: [],
        warnings: [],
      };
    }

    if (status.code === INSUFFICIENT_CREDITS) {
      // Distinct from the generic failure below on purpose. The credentials are
      // good — `auth: "unknown"` sent the welcome flow to an error with nothing
      // to do about it — and what fixes this is a billing page, which only the
      // connector knows the address of. Listing models is skipped for the same
      // reason exit 3 skips it: no turn can run until this is resolved.
      return {
        status: "error" as const,
        probedAt,
        binaryPath: binary.display,
        installed: true,
        message: EXIT_MESSAGES[INSUFFICIENT_CREDITS]!.message,
        auth: "present" as const,
        helpUrl: CMD_ACCOUNT_HELP_URL,
        models: [],
        warnings: [],
      };
    }

    let parsed: StatusJson = {};
    try {
      const json: unknown = JSON.parse(status.stdout);
      if (typeof json === "object" && json !== null) {
        parsed = json as StatusJson;
      }
    } catch {
      // A non-JSON status is still a running binary — keep probing.
    }

    if (typeof parsed.context_window === "number" && Number.isFinite(parsed.context_window)) {
      contextWindows.set(binary.display, Math.max(0, Math.trunc(parsed.context_window)));
    }

    const warnings: Array<string> = [];
    if (parsed.version !== undefined && isBelowOldestTested(parsed.version)) {
      warnings.push(
        `cmd ${parsed.version} is older than ${OLDEST_TESTED_VERSION}, the oldest release Poseidon has been tested against`,
      );
    }

    const models = yield* runBinary(binary, ["--list-models"], {
      timeoutMs: 60_000,
      env,
    }).pipe(
      Effect.map((result) =>
        result.code === 0
          ? withPreferredFirst(withContextWindow(parseModelList(result.stdout), parsed))
          : [],
      ),
      Effect.catch((error) => {
        warnings.push(`--list-models failed: ${error.message}`);
        return Effect.succeed([] as ReadonlyArray<ModelOption>);
      }),
    );

    if (status.code !== 0 && parsed.authenticated === undefined) {
      // A code the table names reads as the sentence it was written for; the
      // raw detail is kept in brackets rather than dropped, because "rate
      // limited" without the harness's own wording is hard to act on.
      const known = EXIT_MESSAGES[status.code];
      const detail = detailOf(status);
      return {
        status: "error" as const,
        probedAt,
        binaryPath: binary.display,
        installed: true,
        message:
          known === undefined
            ? `status exited ${status.code}: ${detail}`
            : detail === ""
              ? known.message
              : `${known.message} (${detail})`,
        auth: "unknown" as const,
        models,
        warnings,
      };
    }

    return {
      status: parsed.authenticated === false ? ("not-authenticated" as const) : ("ready" as const),
      probedAt,
      binaryPath: binary.display,
      installed: true,
      ...(parsed.version === undefined ? {} : { version: parsed.version }),
      ...(parsed.authenticated === false
        ? {
            message: `not logged in — run \`${loginCommand}\``,
            loginCommand,
          }
        : {}),
      auth: parsed.authenticated === false ? ("absent" as const) : ("present" as const),
      ...(parsed.user === undefined ? {} : { account: parsed.user }),
      models,
      warnings,
    };
  });
