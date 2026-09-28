/**
 * Records session scenarios from the real CLI into `fixtures/claude/`.
 *
 *     POSEIDON_RECORD_CLAUDE=1 pnpm -F @poseidon/connector-claude vitest run test/recordSession.test.ts
 *
 * Each scenario drives the connector's real definition with its binary path
 * pointed at the testkit's stdio tee, in a throwaway git repo under
 * `/tmp/poseidon-h1/scratch`, capped by `maxTurns` and `maxBudgetUsd` so a live
 * run cannot spend beyond them. What the tee captured is finalised and
 * scrubbed into the scenario's directory.
 *
 * Skipped unless asked for: it runs the operator's real CLI and account.
 */

import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { makeStreamCollector } from "@poseidon/connector-sdk/streamCollector";
import type { ConnectorServices, TurnInput } from "@poseidon/connector-sdk/definition";
import type { SessionHandle } from "@poseidon/connector-sdk/sessionHandle";
import type { StreamCollector } from "@poseidon/connector-sdk/streamCollector";
import {
  makeConnectorInstanceId,
  makeProjectId,
  makeThreadId,
  type ThreadId,
} from "@poseidon/contracts/ids";
import type { ThreadSettingsPatch } from "@poseidon/contracts/orchestration";
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import { finalizeSdkStreamRecording, makeTeeLauncher } from "@poseidon/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { resolveBinary } from "../src/binary";
import { makeClaudeConnectorDefinition } from "../src/definition";
import { CLAUDE_KIND } from "../src/kind";
import { parseVersion } from "../src/probe";
import { initModelOf, sdkVersion } from "./replay";
import { testServices } from "./services";

const RECORD = process.env.POSEIDON_RECORD_CLAUDE === "1";
/**
 * An older CLI build to record against, for the scenarios about a CLI that
 * predates a capability — e.g. `~/.local/share/claude/versions/2.1.150`.
 */
const OLDER_BINARY = process.env.POSEIDON_RECORD_CLAUDE_OLDER_BINARY;
const SCRATCH = "/tmp/poseidon-h1/scratch";

const SIGNED_OUT_PROMPT = "Reply with the single word: ok";
const IMAGE_PROMPT = "What colour is the image? Answer with one word.";
const COMPACT = "/compact";
const STEER = "Also end your reply with the word banana.";
/** A command the CLI runs itself, without a request: `/usage` under its alias. */
const LOCAL_COMMAND = "/cost";
/** A command that only opens a panel in the CLI's terminal UI. */
const PANEL_COMMAND = "/permissions";
/** The CLI's own command that starts its conversation over. */
const CLEAR = "/clear";

/** A fresh git repo for one scenario. */
const scratchRepo = (scenario: string): string => {
  const repo = NodePath.join(SCRATCH, scenario);
  NodeFS.rmSync(repo, { recursive: true, force: true });
  NodeFS.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "--quiet", repo], { stdio: "ignore" });
  NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "# scratch\n", "utf8");
  return repo;
};

/** A 2×2 solid red PNG, the one the Command Code image recording was made with. */
const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4IycHRAwQCgAhpgRhTxp8CQAAAABJRU5ErkJggg==";

interface Recording {
  readonly handle: SessionHandle;
  readonly collector: StreamCollector<RuntimeEvent>;
  readonly threadId: ThreadId;
  readonly services: ConnectorServices;
  /** What the CLI's `system/init` named so far, from the tee's capture. */
  readonly initModel: () => string | undefined;
}

/**
 * One session through the tee: `drive` sends its turns and settings, then the
 * session closes and the capture is finalised into `fixtures/claude/<scenario>/`.
 */
const recordScenario = (
  spec: {
    readonly scenario: string;
    readonly description: string;
    readonly prompts: ReadonlyArray<string>;
    /** The CLI to record; the one the connector would discover when absent. */
    readonly binaryPath?: string;
  },
  drive: (recording: Recording) => Effect.Effect<void, unknown, Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const real = resolveBinary({ binaryPath: spec.binaryPath }, process.env);
      if (real === null) throw new Error("no claude binary to record");
      const cliVersion = parseVersion(
        execFileSync(real.command, ["--version"], { encoding: "utf8" }),
      );
      const rawDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-raw-"));
      const launcher = makeTeeLauncher({ realBinary: real.command, rawDir });

      const definition = makeClaudeConnectorDefinition({
        limits: { maxTurns: 1, maxBudgetUsd: 0.05 },
      });
      const services = yield* testServices();
      const instance = yield* definition.createInstance({
        instanceId: makeConnectorInstanceId(),
        config: { binaryPath: launcher },
        services,
      });
      const threadId = makeThreadId();
      const handle = yield* instance.startSession({
        threadId,
        projectId: makeProjectId(),
        workspaceRoot: scratchRepo(spec.scenario),
        settings: {
          model: "default",
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
      });
      const collector = yield* makeStreamCollector(handle.events);
      yield* drive({
        handle,
        collector,
        threadId,
        services,
        initModel: () => initModelOf(rawDir),
      });
      yield* handle.close();

      const dir = finalizeSdkStreamRecording({
        kind: CLAUDE_KIND,
        scenario: spec.scenario,
        rawDir,
        description: spec.description,
        cliVersion: cliVersion ?? "unknown",
        sdkVersion: sdkVersion(),
        model: initModelOf(rawDir) ?? "default",
        prompts: spec.prompts,
      });
      expect(NodeFS.existsSync(NodePath.join(dir, "manifest.json"))).toBe(true);
    }),
  );

/** Sends one turn and waits for it to complete. */
const turn = (recording: Recording, text: string, attachments: TurnInput["attachments"] = []) =>
  Effect.gen(function* () {
    const before = new Set(yield* recording.collector.collected);
    yield* recording.handle.send({ text, attachments, mentions: [] });
    yield* recording.collector.awaitItem(
      (event) => !before.has(event) && event.type === "turn.completed",
    );
  });

/** Changes the session's settings and waits for the `model.changed` that answers. */
const switchTo = (recording: Recording, patch: ThreadSettingsPatch) =>
  Effect.gen(function* () {
    const before = new Set(yield* recording.collector.collected);
    yield* recording.handle.updateSettings(patch);
    yield* recording.collector.awaitItem(
      (event) => !before.has(event) && event.type === "model.changed",
    );
  });

/** The one-shot the generation recordings ask for: a thread title. */
const GENERATE_REQUEST = {
  system: "You name chat threads. Reply with a title of 3 to 8 words and nothing else.",
  prompt: "First message: fix the flaky login test",
  model: "default",
  effort: "low",
} as const;

/** `auth status --json` exits 1 when signed out; asked only when recording. */
const signedIn = (): boolean => {
  const real = resolveBinary({}, process.env);
  if (real === null) return false;
  try {
    execFileSync(real.command, ["auth", "status", "--json"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/**
 * One `generateText` call through the tee, finalised into
 * `fixtures/claude/<scenario>/`. Signed out it must be refused; signed in it
 * must answer.
 */
const recordGenerateText = (scenario: string, description: string, answered: boolean) =>
  Effect.gen(function* () {
    const real = resolveBinary({}, process.env);
    if (real === null) throw new Error("no claude binary to record");
    const cliVersion = parseVersion(
      execFileSync(real.command, ["--version"], { encoding: "utf8" }),
    );
    const rawDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-raw-"));
    const launcher = makeTeeLauncher({ realBinary: real.command, rawDir });
    const instance = yield* makeClaudeConnectorDefinition().createInstance({
      instanceId: makeConnectorInstanceId(),
      config: { binaryPath: launcher },
      services: yield* testServices(),
    });
    const outcome = yield* Effect.exit(instance.generateText!(GENERATE_REQUEST));
    expect(outcome._tag).toBe(answered ? "Success" : "Failure");
    finalizeSdkStreamRecording({
      kind: CLAUDE_KIND,
      scenario,
      rawDir,
      description,
      cliVersion: cliVersion ?? "unknown",
      sdkVersion: sdkVersion(),
      model: initModelOf(rawDir) ?? "default",
      prompts: [GENERATE_REQUEST.prompt],
    });
  }).pipe(Effect.scoped);

describe("session recordings", () => {
  it.live.skipIf(!RECORD || signedIn())(
    "generate-text-signed-out: one generateText call against a CLI that is not signed in",
    () =>
      recordGenerateText(
        "generate-text-signed-out",
        "One generateText call (a thread title) on a CLI that is not signed in: the one-shot options — one turn, no tools, no settings, no session kept, effort low, a system prompt of its own, in a temp directory — and the CLI's own sign-in refusal as an error result, without calling the API.",
        false,
      ),
  );

  it.live.skipIf(!RECORD || !signedIn())(
    "generate-text: one generateText call answered by a signed-in CLI",
    () =>
      recordGenerateText(
        "generate-text",
        "One generateText call (a thread title) on a signed-in CLI: the one-shot options — one turn, no tools, no settings, no session kept, effort low, a system prompt of its own, in a temp directory — and the title as the result's text.",
        true,
      ),
  );

  it.live.skipIf(!RECORD)("signed-out: one turn against a CLI that is not signed in", () =>
    recordScenario(
      {
        scenario: "signed-out",
        description:
          "One turn sent to a CLI that is not signed in: the CLI answers with its own sign-in error and an error result, without calling the API.",
        prompts: [SIGNED_OUT_PROMPT],
      },
      (recording) => turn(recording, SIGNED_OUT_PROMPT),
    ),
  );

  it.live.skipIf(!RECORD)(
    "signed-out-steer: a message steered into a running turn on a CLI that is not signed in",
    () =>
      recordScenario(
        {
          scenario: "signed-out-steer",
          description:
            "One turn on a CLI that is not signed in, with a second message steered into it once the CLI's system/init showed the turn under way: the CLI queues the steered message, refuses the first for the login with an error result, then runs the steered one as its own turn and refuses it the same way. Nothing reaches the API.",
          prompts: [SIGNED_OUT_PROMPT, STEER],
        },
        (recording) =>
          Effect.gen(function* () {
            const before = new Set(yield* recording.collector.collected);
            yield* recording.handle.send({
              text: SIGNED_OUT_PROMPT,
              attachments: [],
              mentions: [],
            });
            // The CLI announced the turn (its init): the turn is running.
            yield* recording.collector.awaitItem(
              (event) => !before.has(event) && event.type === "mcp.status.updated",
            );
            yield* recording.handle.steer!({ text: STEER, attachments: [], mentions: [] });
            yield* recording.collector.awaitItem(
              (event) => !before.has(event) && event.type === "turn.completed",
            );
          }),
      ),
  );

  it.live.skipIf(!RECORD || OLDER_BINARY === undefined)(
    "receiptless-steer: a steer refused on a CLI that sends no command_lifecycle receipts",
    () =>
      recordScenario(
        {
          scenario: "receiptless-steer",
          description:
            "One turn on an older CLI build that is not signed in and whose system/init lists no msg_lifecycle_v1: a steer attempted once the init showed the turn under way is refused by the connector before anything is written, and the CLI refuses the turn for the login. Nothing reaches the API.",
          prompts: [SIGNED_OUT_PROMPT],
          binaryPath: OLDER_BINARY!,
        },
        (recording) =>
          Effect.gen(function* () {
            const before = new Set(yield* recording.collector.collected);
            yield* recording.handle.send({
              text: SIGNED_OUT_PROMPT,
              attachments: [],
              mentions: [],
            });
            yield* recording.collector.awaitItem(
              (event) => !before.has(event) && event.type === "mcp.status.updated",
            );
            const refused = yield* Effect.flip(
              recording.handle.steer!({ text: STEER, attachments: [], mentions: [] }),
            );
            expect(refused._tag).toBe("NotSteerable");
            yield* recording.collector.awaitItem(
              (event) => !before.has(event) && event.type === "turn.completed",
            );
          }),
      ),
  );

  it.live.skipIf(!RECORD)(
    "local-command: two of the CLI's own slash commands on a CLI that is not signed in",
    () =>
      recordScenario(
        {
          scenario: "local-command",
          description:
            "One session on a CLI that is not signed in: a /cost turn, which the CLI answers itself from the session's usage, and a /permissions turn, a command that only opens a panel in the CLI's terminal UI and is refused in an SDK session. Neither makes a request, so nothing reaches the API.",
          prompts: [LOCAL_COMMAND, PANEL_COMMAND, CLEAR, LOCAL_COMMAND],
        },
        (recording) =>
          Effect.gen(function* () {
            yield* turn(recording, LOCAL_COMMAND);
            yield* turn(recording, PANEL_COMMAND);
            yield* turn(recording, CLEAR);
            yield* turn(recording, LOCAL_COMMAND);
          }),
      ),
  );

  it.live.skipIf(!RECORD)(
    "session-controls: the model, the effort, an image and /compact on a CLI that is not signed in",
    () =>
      recordScenario(
        {
          scenario: "session-controls",
          description:
            "One session on a CLI that is not signed in, so nothing reaches the API: a turn refused for the login; the model switched to the explicit id the CLI's init named for its default (set_model), the effort set to low (apply_flag_settings); a turn carrying a PNG as an image content block, refused; a /compact turn; and the model switched back to the default (set_model with no model).",
          prompts: [SIGNED_OUT_PROMPT, IMAGE_PROMPT, COMPACT],
        },
        (recording) =>
          Effect.gen(function* () {
            yield* turn(recording, SIGNED_OUT_PROMPT);
            const model = recording.initModel();
            if (model === undefined) throw new Error("the CLI never reported its model");
            yield* switchTo(recording, { model });
            yield* switchTo(recording, { effort: "low" });

            const dir = NodePath.join(recording.services.attachmentsDir, recording.threadId);
            NodeFS.mkdirSync(dir, { recursive: true });
            const png = NodePath.join(dir, "red.png");
            NodeFS.writeFileSync(png, Buffer.from(RED_PNG_BASE64, "base64"));
            yield* turn(recording, IMAGE_PROMPT, [
              { path: png, mime: "image/png", name: "red.png" },
            ]);

            yield* turn(recording, COMPACT);
            yield* switchTo(recording, { model: "default" });
          }),
      ),
  );
});
