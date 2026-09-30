/**
 * The Claude Code end-to-end harness: one real server, one real client, and
 * the Claude Code CLI — real, recorded, or being recorded.
 *
 * It is the Command Code harness (`../e2e/harness.ts`) with a different
 * connector underneath: `boot()` builds the product's graph, the client dials
 * it over a real WebSocket, and the renderer's own folds turn the subscription
 * into the view a pane shows. Homes, the client, commands and the view readers
 * are that harness's; what is here is the three ways the connector finds its
 * CLI.
 *
 * - `replay` (the default, what the gate runs) points the instance's binary
 *   path at the testkit's `sdk-stream` replayer for the scenario's recording
 *   in `packages/testkit/fixtures/claude/`. The SDK, the connector, the MCP
 *   gateway, the permission ladder and the approval flow are all real; the CLI
 *   is the recording, and the replayer exits 97 the moment the connector says
 *   something the recorded run was not told.
 * - `live` (`POSEIDON_LIVE_CLAUDE=1`) lets the connector discover the
 *   operator's own `claude`, exactly as the shipped product does, and spends
 *   their subscription. `POSEIDON_LIVE_CLAUDE_CONFIG_DIR` points the instance
 *   at a separate account (the connector's `configDir`), and
 *   `POSEIDON_LIVE_CLAUDE_DEBUG=1` lowers the server's log level to debug, so
 *   the connector's own log lines are printed too.
 * - `record` (`POSEIDON_RECORD_CLAUDE=1`) is `live` through the testkit's stdio
 *   tee, and finalises what the tee saw into the scenario's fixture directory
 *   once the scenario's scope has closed and every process has exited. It is
 *   the only way a Claude recording is made: every recording has been through
 *   the real server.
 *
 * Budget. Every driver runs the thread on the CLI's default model (`default`,
 * which leaves the SDK's `model` option out) and every session under the caps
 * in `CLAUDE_LIMITS`, passed through `BootOptions.claudeCode`. The same caps
 * apply to a replay, so its argv is the recorded one. The live and record
 * drivers refuse any other thread model unless the operator names it in
 * `POSEIDON_CLAUDE_APPROVED_MODEL`.
 *
 * Safety. Every scenario gets a fresh `POSEIDON_HOME` and a throwaway git repo:
 * under the system temp directory for a replay or a live run, and under
 * `/tmp/poseidon-h1` for a recording, whose scrubber takes that root for
 * `<SCRATCH>`. `HOME` is never redirected — the CLI's credentials live there
 * and in the keychain — and a replay writes nothing anywhere but its temp
 * directory.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { claudeConnectorDefinition } from "@poseidon/connector-claude/definition";
import { makeConnectorInstanceId, type ConnectorInstanceId } from "@poseidon/contracts/ids";
import type { ThreadSettingsPatch } from "@poseidon/contracts/orchestration";
import type { ConnectorInstanceConfig } from "@poseidon/contracts/settings";
import { recordingNames } from "@poseidon/testkit/recording";
import { sdkStreamReplayer } from "@poseidon/testkit/replaySdkStream";
import {
  finalizeSdkStreamRecording,
  loadSdkStreamRecording,
  makeTeeLauncher,
} from "@poseidon/testkit/sdkStreamRecording";
import { describe, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as References from "effect/References";
import type * as Scope from "effect/Scope";

import type { BootedServer } from "../../src/boot";
import {
  bootServer,
  makeHome,
  openThread,
  seedSettings,
  type E2EClient,
  type E2EHome,
  type OpenThread,
} from "../e2e/harness";

/** The connector kind, as the settings row names it. */
const KIND = "claude";

/**
 * The thread model every scenario runs on: the CLI's own default, whatever
 * that resolves to on the operator's account. It is the only model the
 * recordings are made on.
 */
const CLAUDE_MODEL = "default";

/**
 * The caps every session runs under. Low enough that a live run or a
 * recording cannot spend more than a few cents a turn; high enough for a
 * scenario that edits a file or starts a subagent to finish.
 */
const CLAUDE_LIMITS = { maxTurns: 4, maxBudgetUsd: 0.5 } as const;

const RECORD = process.env.POSEIDON_RECORD_CLAUDE === "1";
const LIVE = process.env.POSEIDON_LIVE_CLAUDE === "1";
const LIVE_CONFIG_DIR = process.env.POSEIDON_LIVE_CLAUDE_CONFIG_DIR;
const APPROVED_MODEL = process.env.POSEIDON_CLAUDE_APPROVED_MODEL;
const DEBUG = process.env.POSEIDON_LIVE_CLAUDE_DEBUG === "1";

/** Where a recording's homes and raw captures go, per the recording rules. */
const RECORD_ROOT = "/tmp/poseidon-h1";

export type ClaudeDriverName = "replay" | "live" | "record";

// ── What a scenario is ─────────────────────────────────────────

export interface ClaudeScenario {
  /** The recording under `packages/testkit/fixtures/claude/`. */
  readonly scenario: string;
  /** What the recording shows, for its manifest. */
  readonly description: string;
  /** The prompts it sends, in order, for its manifest. */
  readonly prompts: ReadonlyArray<string>;
  /** Files committed into the scratch repo before the first turn. */
  readonly seed?: Readonly<Record<string, string>>;
  /**
   * The scenario is about a CLI that is not signed in. Live, or recording,
   * against the operator's CLI once it is signed in, it could only fail — and
   * would spend a turn doing so — so those drivers skip it, saying why.
   */
  readonly signedOut?: true;
}

export interface ClaudeRun {
  readonly driver: ClaudeDriverName;
  readonly home: E2EHome;
  readonly connectorInstanceId: ConnectorInstanceId;
  /** Boots the real server on this home, in the calling scope, under the caps. */
  readonly boot: Effect.Effect<BootedServer, never, Scope.Scope>;
  /**
   * The explicit id of the model the CLI's `default` runs as — what a switch
   * away from `default` may name without spending on another model. The
   * recording's model under replay; what the CLI's `system/init` named so far
   * when recording, so only after the first turn; and, live, the model the
   * operator named in `POSEIDON_CLAUDE_APPROVED_MODEL`.
   */
  readonly defaultModelId: Effect.Effect<string>;
  /**
   * A project on the scratch repo and a thread on this instance and the CLI's
   * default model, with its subscription already folding.
   */
  readonly openThread: (
    client: E2EClient,
    settings?: ThreadSettingsPatch,
  ) => Effect.Effect<OpenThread, never, Scope.Scope>;
}

// ── The drivers ────────────────────────────────────────────────

/** A connector instance row for this driver, and what to do once the scenario is over. */
interface Prepared {
  readonly config: ConnectorInstanceConfig["config"];
  readonly homeParent: string;
  /** What the CLI's default runs as, when this driver can tell. */
  readonly defaultModelId: () => string | undefined;
  /** Once the scenario passed and every process it started has exited. */
  readonly finish: () => void;
  /** Whatever happened. */
  readonly cleanup: () => void;
}

const instanceRow = (
  connectorInstanceId: ConnectorInstanceId,
  config: ConnectorInstanceConfig["config"],
): ConnectorInstanceConfig => ({
  connectorInstanceId,
  kind: KIND,
  displayName: "Claude Code",
  enabled: true,
  config,
});

/**
 * The replayer for the scenario, its launcher and counter in a temp directory.
 * A green scenario also has to have played its recording out as recorded: a
 * divergence the connector absorbed — a probe that fell back, a crash the
 * supervisor recovered from — fails it here.
 */
const prepareReplay = (spec: ClaudeScenario): Prepared => {
  const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `claude-e2e-${spec.scenario}-`));
  const divergenceLog = NodePath.join(tmpDir, "diverged.log");
  const { binaryPath } = sdkStreamReplayer(KIND).config(spec.scenario, { tmpDir, divergenceLog });
  return {
    config: { binaryPath },
    homeParent: NodeOS.tmpdir(),
    defaultModelId: () => loadSdkStreamRecording(KIND, spec.scenario).manifest.model,
    finish: () => {
      if (NodeFS.existsSync(divergenceLog)) {
        throw new Error(
          `the replay of claude/${spec.scenario} diverged:\n${NodeFS.readFileSync(divergenceLog, "utf8")}`,
        );
      }
    },
    cleanup: () => NodeFS.rmSync(tmpDir, { recursive: true, force: true }),
  };
};

/** The operator's own CLI, discovered by the connector. */
const prepareLive = (): Prepared => ({
  config: LIVE_CONFIG_DIR === undefined ? {} : { configDir: LIVE_CONFIG_DIR },
  homeParent: NodeOS.tmpdir(),
  defaultModelId: () => APPROVED_MODEL,
  finish: () => {},
  cleanup: () => {},
});

/** The SDK version the connector imports, read from its package. */
const sdkVersion = (): string => {
  const connector = NodeURL.fileURLToPath(
    import.meta.resolve("@poseidon/connector-claude/definition"),
  );
  const manifest = NodePath.join(
    NodePath.dirname(connector),
    "..",
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "package.json",
  );
  return (JSON.parse(NodeFS.readFileSync(manifest, "utf8")) as { version: string }).version;
};

/** The model the CLI's `system/init` named in a raw capture: what the default resolved to. */
const initModel = (rawDir: string): string | undefined => {
  for (const name of NodeFS.readdirSync(rawDir).filter((file) => file.endsWith(".ndjson"))) {
    for (const line of NodeFS.readFileSync(NodePath.join(rawDir, name), "utf8").split("\n")) {
      if (!line.includes('"init"')) continue;
      const data = (
        JSON.parse(line) as { data?: { type?: string; subtype?: string; model?: string } }
      ).data;
      if (data?.type === "system" && data.subtype === "init" && data.model !== undefined) {
        return data.model;
      }
    }
  }
  return undefined;
};

/**
 * The real CLI behind the tee. The connector's own probe finds it, so the
 * recording runs the binary a user's install would; its version goes into
 * the manifest.
 */
const prepareRecord = (spec: ClaudeScenario): Effect.Effect<Prepared> =>
  Effect.gen(function* () {
    const probe = yield* claudeConnectorDefinition
      .probe(LIVE_CONFIG_DIR === undefined ? {} : { configDir: LIVE_CONFIG_DIR })
      .pipe(Effect.orDie);
    if (probe.binaryPath === undefined || probe.version === undefined) {
      return yield* Effect.die(new Error(`no claude to record: ${probe.message ?? probe.status}`));
    }
    const realBinary = probe.binaryPath;
    const cliVersion = probe.version;
    NodeFS.mkdirSync(NodePath.join(RECORD_ROOT, "raw"), { recursive: true });
    const rawDir = NodeFS.mkdtempSync(NodePath.join(RECORD_ROOT, "raw", `${spec.scenario}-`));
    const launcher = makeTeeLauncher({ realBinary, rawDir });
    const homeParent = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(RECORD_ROOT, `${spec.scenario}-`)),
    );
    return {
      config: {
        binaryPath: launcher,
        ...(LIVE_CONFIG_DIR === undefined ? {} : { configDir: LIVE_CONFIG_DIR }),
      },
      homeParent,
      defaultModelId: () => initModel(rawDir),
      finish: () => {
        const model = initModel(rawDir);
        if (model === undefined) {
          throw new Error(`${spec.scenario}: the CLI never reported its model; nothing recorded`);
        }
        finalizeSdkStreamRecording({
          kind: KIND,
          scenario: spec.scenario,
          rawDir,
          description: spec.description,
          cliVersion,
          sdkVersion: sdkVersion(),
          model,
          prompts: spec.prompts,
          scratch: homeParent,
          ...(LIVE_CONFIG_DIR === undefined ? {} : { configDir: LIVE_CONFIG_DIR }),
        });
      },
      // The raw capture stays under /tmp/poseidon-h1 for a failed recording to
      // be looked at; a passed one has been finalised from it.
      cleanup: () => {},
    };
  });

const prepare = (driver: ClaudeDriverName, spec: ClaudeScenario): Effect.Effect<Prepared> => {
  switch (driver) {
    case "replay":
      return Effect.sync(() => prepareReplay(spec));
    case "live":
      return Effect.sync(prepareLive);
    case "record":
      return prepareRecord(spec);
  }
};

// ── Running a scenario ─────────────────────────────────────────

/** A thread model the live and record drivers may spend on. */
const spendable = (model: string | undefined): boolean =>
  model === undefined || model === CLAUDE_MODEL || model === APPROVED_MODEL;

const runScenario = (
  driver: ClaudeDriverName,
  spec: ClaudeScenario,
  body: (run: ClaudeRun) => Effect.Effect<void, never, Scope.Scope>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const prepared = yield* prepare(driver, spec);
    const scenario = Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome(spec.scenario, spec.seed ?? {}, prepared.homeParent);
        const connectorInstanceId = makeConnectorInstanceId();
        yield* seedSettings(home, [instanceRow(connectorInstanceId, prepared.config)]);
        yield* body({
          driver,
          home,
          connectorInstanceId,
          boot: bootServer(home, { claudeCode: { limits: CLAUDE_LIMITS } }),
          defaultModelId: Effect.suspend(() => {
            const id = prepared.defaultModelId();
            return id === undefined
              ? Effect.die(
                  new Error(
                    driver === "live"
                      ? "name the default's explicit model id in POSEIDON_CLAUDE_APPROVED_MODEL to switch to it live"
                      : "the CLI has not reported its model yet",
                  ),
                )
              : Effect.succeed(id);
          }),
          openThread: (client, settings = {}) =>
            driver !== "replay" && !spendable(settings.model)
              ? Effect.die(
                  new Error(
                    `${settings.model} is not the CLI's default model; name it in POSEIDON_CLAUDE_APPROVED_MODEL to spend on it`,
                  ),
                )
              : openThread(client, home, {
                  model: CLAUDE_MODEL,
                  connectorInstanceId,
                  ...settings,
                }),
        });
      }),
    );
    // `finish` only once the scope has closed: then every process the
    // scenario started has exited, and the tee has written every frame and
    // every exit.
    const run = scenario.pipe(
      Effect.andThen(Effect.sync(prepared.finish)),
      Effect.ensuring(Effect.sync(prepared.cleanup)),
    );
    yield* DEBUG && driver !== "replay"
      ? Effect.provideService(run, References.MinimumLogLevel, "Debug")
      : run;
  });

/** Which drivers a run of the suite uses: a recording replaces the others. */
const activeDrivers = (): ReadonlyArray<ClaudeDriverName> =>
  RECORD ? ["record"] : ["replay", "live"];

/**
 * Runs one scenario against each active driver.
 *
 * The same body runs against the recording, which is what the gate does, and
 * against the real CLI when it is turned on, which is what says the recording
 * still describes reality. A scenario whose recording has not been made yet
 * is skipped under the replay driver with that said in its title; making it
 * is `POSEIDON_RECORD_CLAUDE=1` on the same file.
 */
export const claudeScenario = (
  title: string,
  spec: ClaudeScenario,
  test: string,
  body: (run: ClaudeRun) => Effect.Effect<void, never, Scope.Scope>,
): void => {
  for (const driver of activeDrivers()) {
    const label = `${title} [claude ${driver}]`;
    if (driver === "live" && !LIVE) {
      describe.skip(label, () => {
        it("is only run with POSEIDON_LIVE_CLAUDE=1 — it spends the operator's subscription", () => {
          // Intentionally empty: the skip itself is the statement.
        });
      });
      continue;
    }
    if (driver === "replay" && !recordingNames(KIND).includes(spec.scenario)) {
      describe.skip(label, () => {
        it(`has no recording yet: record fixtures/claude/${spec.scenario}/ with POSEIDON_RECORD_CLAUDE=1`, () => {
          // Intentionally empty: the skip itself is the statement.
        });
      });
      continue;
    }
    // A replay is several real processes, a socket and a database; a live
    // turn is a model round trip on top.
    vi.setConfig({
      testTimeout: driver === "replay" ? 120_000 : 600_000,
      hookTimeout: 120_000,
    });
    describe(label, () => {
      it.live(test, (context) =>
        driver === "replay" || spec.signedOut !== true
          ? runScenario(driver, spec, body)
          : Effect.gen(function* () {
              const probe = yield* claudeConnectorDefinition
                .probe(LIVE_CONFIG_DIR === undefined ? {} : { configDir: LIVE_CONFIG_DIR })
                .pipe(Effect.orDie);
              if (probe.auth === "present") {
                context.skip(`the CLI is signed in; ${spec.scenario} needs one that is not`);
              }
              yield* runScenario(driver, spec, body);
            }),
      );
    });
  }
};
