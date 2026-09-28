/**
 * Records session scenarios from the real CLI into `fixtures/codex/`.
 *
 *     POSEIDON_RECORD_CODEX=1 POSEIDON_HOME=/tmp/poseidon-codex \
 *       pnpm -F @poseidon/connector-codex vitest run test/recordSession.test.ts
 *
 * Each scenario drives the connector's real definition with its binary path
 * pointed at the testkit's stdio tee, in a throwaway git repo under
 * `/tmp/poseidon-codex/scratch`, on the CLI's default model (the thread names
 * none). The app-server has no turn or budget cap, so the prompts are trivial
 * and ask for one-word answers. What the tee captured is finalised and
 * scrubbed into the scenario's directory.
 *
 * Skipped unless asked for: it runs the operator's real CLI and account.
 */

import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { TurnInput } from "@poseidon/connector-sdk/definition";
import type { SessionHandle } from "@poseidon/connector-sdk/sessionHandle";
import { makeStreamCollector, type StreamCollector } from "@poseidon/connector-sdk/streamCollector";
import {
  makeConnectorInstanceId,
  makeProjectId,
  makeThreadId,
  type ThreadId,
} from "@poseidon/contracts/ids";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { makeCodexConnectorDefinition } from "../src/definition";
import { parseVersion } from "../src/probe";
import { RECORD, finalise, realCodex, teeInFront, threadModelOf } from "./record";
import { testServices } from "./services";

const SCRATCH = "/tmp/poseidon-codex/scratch";

const PROMPTS = {
  plain: "Reply with exactly: ok",
  interrupted: "Count from 1 to 200, one number per line.",
  remember: "Remember the word walrus. Reply with exactly: ok",
  recall: "Which word did I ask you to remember? Reply with that word only.",
  image: "What colour is the image? Answer with one word.",
} as const;

/** The model and effort the second turn of `model-switch` runs on. */
const SWITCHED_TO = { model: "gpt-6-luna", effort: "low" } as const;

/** A 2×2 solid red PNG, the one the Command Code image recording was made with. */
const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4IycHRAwQCgAhpgRhTxp8CQAAAABJRU5ErkJggg==";

const SETTINGS: ThreadSettings = {
  model: "default",
  runtimeMode: "approval-required",
  interactionMode: "default",
};

/** A fresh git repo for one scenario. */
const scratchRepo = (scenario: string): string => {
  const repo = NodePath.join(SCRATCH, scenario);
  NodeFS.rmSync(repo, { recursive: true, force: true });
  NodeFS.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "--quiet", repo], { stdio: "ignore" });
  NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "# scratch\n", "utf8");
  return repo;
};

interface Recording {
  readonly handle: SessionHandle;
  readonly collector: StreamCollector<RuntimeEvent>;
}

interface Session {
  readonly threadId: ThreadId;
  /** Opens a session on the tee, fresh or resuming `sessionRef`. */
  readonly open: (sessionRef?: unknown) => Effect.Effect<Recording, unknown, Scope.Scope>;
  readonly repo: string;
}

/**
 * One scenario through the tee: `drive` opens sessions and sends turns, then
 * the capture is finalised into `fixtures/codex/<scenario>/`.
 */
const recordScenario = (
  spec: {
    readonly scenario: string;
    readonly description: string;
    readonly prompts: ReadonlyArray<string>;
    /** What the manifest names as the model, when not the thread's default alone. */
    readonly model?: (defaultModel: string) => string;
  },
  drive: (session: Session) => Effect.Effect<void, unknown, Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const codex = realCodex();
      const cliVersion = parseVersion(execFileSync(codex, ["--version"], { encoding: "utf8" }));
      const { rawDir, launcher } = teeInFront(codex, spec.scenario);
      const services = yield* testServices();
      const instance = yield* makeCodexConnectorDefinition().createInstance({
        instanceId: makeConnectorInstanceId(),
        config: { binaryPath: launcher },
        services,
      });
      const threadId = makeThreadId();
      const repo = scratchRepo(spec.scenario);
      const input = {
        threadId,
        projectId: makeProjectId(),
        workspaceRoot: repo,
        settings: SETTINGS,
      };
      const open = (sessionRef?: unknown) =>
        Effect.gen(function* () {
          const handle = yield* sessionRef === undefined
            ? instance.startSession(input)
            : instance.resumeSession({ ...input, sessionRef });
          const collector = yield* makeStreamCollector(handle.events);
          return { handle, collector };
        });
      yield* drive({ threadId, open, repo });

      const ranAs = threadModelOf(rawDir) ?? "default";
      const dir = finalise({
        codex,
        scenario: spec.scenario,
        rawDir,
        description: spec.description,
        cliVersion: cliVersion ?? "unknown",
        model: spec.model?.(ranAs) ?? ranAs,
        prompts: spec.prompts,
      });
      expect(NodeFS.existsSync(NodePath.join(dir, "manifest.json"))).toBe(true);
    }),
  );

const text = (value: string, attachments: TurnInput["attachments"] = []): TurnInput => ({
  text: value,
  attachments,
  mentions: [],
});

/** Sends one turn and waits for it to complete; answers the completion. */
const turn = (recording: Recording, input: TurnInput) =>
  Effect.gen(function* () {
    const before = new Set(yield* recording.collector.collected);
    yield* recording.handle.send(input);
    return yield* recording.collector.awaitItem(
      (event) => !before.has(event) && event.type === "turn.completed",
    );
  });

/** Closes the session and waits for its stream to end. */
const closed = (recording: Recording) =>
  Effect.gen(function* () {
    yield* recording.handle.close();
    yield* recording.collector.awaitDone;
  });

describe("session recordings", () => {
  it.live.skipIf(!RECORD)("plain-reply: one answered turn", () =>
    recordScenario(
      {
        scenario: "plain-reply",
        description:
          "One session, one turn answered with a single word: streamed text, token usage and the context window, and a turn that completed.",
        prompts: [PROMPTS.plain],
      },
      (session) =>
        Effect.gen(function* () {
          const recording = yield* session.open();
          yield* turn(recording, text(PROMPTS.plain));
          yield* closed(recording);
        }),
    ),
  );

  it.live.skipIf(!RECORD)("interrupt: a turn stopped on its first text, then a follow-up", () =>
    recordScenario(
      {
        scenario: "interrupt",
        description:
          "A counting turn interrupted (turn/interrupt) as soon as its first text streamed, then a one-word follow-up on the same app-server process.",
        prompts: [PROMPTS.interrupted, PROMPTS.plain],
      },
      (session) =>
        Effect.gen(function* () {
          const recording = yield* session.open();
          const before = new Set(yield* recording.collector.collected);
          yield* recording.handle.send(text(PROMPTS.interrupted));
          yield* recording.collector.awaitItem(
            (event) => !before.has(event) && event.type === "content.delta",
          );
          yield* recording.handle.interrupt();
          const stopped = yield* recording.collector.awaitItem(
            (event) => !before.has(event) && event.type === "turn.completed",
          );
          expect(stopped.type === "turn.completed" && stopped.payload.stopReason).toBe(
            "interrupted",
          );
          yield* turn(recording, text(PROMPTS.plain));
          yield* closed(recording);
        }),
    ),
  );

  it.live.skipIf(!RECORD)("resume: a second process resumes the thread and recalls a word", () =>
    recordScenario(
      {
        scenario: "resume",
        description:
          "Two app-server processes: the first starts the thread and is told a word to remember; it is closed, and the second resumes the thread (thread/resume) and names the word.",
        prompts: [PROMPTS.remember, PROMPTS.recall],
      },
      (session) =>
        Effect.gen(function* () {
          const first = yield* session.open();
          yield* turn(first, text(PROMPTS.remember));
          const ref = yield* first.handle.sessionRef();
          yield* closed(first);
          const second = yield* session.open(ref);
          yield* turn(second, text(PROMPTS.recall));
          yield* closed(second);
        }),
    ),
  );

  it.live.skipIf(!RECORD)("resume-missing: a resume of a thread the CLI does not have", () =>
    recordScenario(
      {
        scenario: "resume-missing",
        description:
          "One app-server process asked to resume a thread id it has no rollout for: thread/resume is refused, and the session starts a new thread (thread/start) instead. No turn is sent.",
        prompts: [],
      },
      (session) =>
        Effect.gen(function* () {
          const recording = yield* session.open({
            threadId: "01a0e600-0000-7000-8000-000000000000",
            cwd: session.repo,
          });
          yield* recording.collector.awaitItem((event) => event.type === "session.warning");
          yield* closed(recording);
        }),
    ),
  );

  it.live.skipIf(!RECORD)("model-switch: the second turn on another model at effort low", () =>
    recordScenario(
      {
        scenario: "model-switch",
        description: `Two turns in one process: the first on the CLI's default model, the second on ${SWITCHED_TO.model} at effort ${SWITCHED_TO.effort}, named on its turn/start.`,
        prompts: [PROMPTS.plain, PROMPTS.plain],
        model: (ranAs) => `${ranAs}, then ${SWITCHED_TO.model} (effort ${SWITCHED_TO.effort})`,
      },
      (session) =>
        Effect.gen(function* () {
          const recording = yield* session.open();
          yield* turn(recording, text(PROMPTS.plain));
          yield* recording.handle.updateSettings(SWITCHED_TO);
          yield* turn(recording, text(PROMPTS.plain));
          yield* closed(recording);
        }),
    ),
  );

  it.live.skipIf(!RECORD)("image: a PNG sent as a localImage input", () =>
    recordScenario(
      {
        scenario: "image",
        description:
          "One turn carrying a 2×2 red PNG as a localImage input; the model names its colour.",
        prompts: [PROMPTS.image],
      },
      (session) =>
        Effect.gen(function* () {
          const recording = yield* session.open();
          const image = NodePath.join(session.repo, "red.png");
          NodeFS.writeFileSync(image, Buffer.from(RED_PNG_BASE64, "base64"));
          yield* turn(
            recording,
            text(PROMPTS.image, [{ path: image, mime: "image/png", name: "red.png" }]),
          );
          yield* closed(recording);
        }),
    ),
  );
});
