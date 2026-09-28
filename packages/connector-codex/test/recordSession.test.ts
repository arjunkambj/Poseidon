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

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { RECORD } from "./record";
import { answerCards, closed, recordScenario, SETTINGS, text, turn } from "./scenario";

const PROMPTS = {
  plain: "Reply with exactly: ok",
  interrupted: "Count from 1 to 200, one number per line.",
  remember: "Remember the word walrus. Reply with exactly: ok",
  recall: "Which word did I ask you to remember? Reply with that word only.",
  image: "What colour is the image? Answer with one word.",
  edit: "Create hello.txt containing hi",
  deny: "Run: touch denied.txt",
  sensitive: "cat .env",
  stopEdit: "Create stop.txt containing hi",
  closeEdit: "Create close.txt containing hi",
  bearer:
    'Run exactly this command and reply with its output: echo "token=[$POSEIDON_CODEX_MCP_TOKEN]"',
} as const;

/** The scratch `.env` of `sensitive-full-access`: a stand-in, nothing secret. */
const SCRATCH_ENV = "POSEIDON_SCRATCH=not-a-secret\n";

/** The model and effort the second turn of `model-switch` runs on. */
const SWITCHED_TO = { model: "gpt-6-luna", effort: "low" } as const;

/** A 2×2 solid red PNG, the one the Command Code image recording was made with. */
const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4IycHRAwQCgAhpgRhTxp8CQAAAABJRU5ErkJggg==";

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

  it.live.skipIf(!RECORD)("ultra-effort: one turn at effort ultra on the default model", () =>
    recordScenario(
      {
        scenario: "ultra-effort",
        description:
          "One turn on the CLI's default model with the thread's effort ultra (the rung model/list lists as 'Maximum reasoning with automatic task delegation'), named on its turn/start; whatever the model delegated is recorded as it happened.",
        prompts: [PROMPTS.plain],
        settings: { ...SETTINGS, effort: "ultra" },
        model: (ranAs) => `${ranAs} (effort ultra)`,
      },
      (session) =>
        Effect.gen(function* () {
          const recording = yield* session.open();
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

  it.live.skipIf(!RECORD)("edit-approval: a file write stopped on a card, allowed once", () =>
    recordScenario(
      {
        scenario: "edit-approval",
        description:
          "Approval required: the model's file change (item/fileChange/requestApproval) opens a card, which is allowed once (accept); the file is written.",
        prompts: [PROMPTS.edit],
      },
      (session) =>
        Effect.gen(function* () {
          const recording = yield* session.open();
          const answered = yield* answerCards(recording, "allow-once");
          yield* turn(recording, text(PROMPTS.edit));
          yield* closed(recording);
          expect(answered.size).toBeGreaterThan(0);
          expect(NodeFS.existsSync(NodePath.join(session.repo, "hello.txt"))).toBe(true);
        }),
    ),
  );

  it.live.skipIf(!RECORD)("deny: a command stopped on a card, denied", () =>
    recordScenario(
      {
        scenario: "deny",
        description:
          "Approval required: every card the turn opens is denied (decline), so the command never runs and the file is absent.",
        prompts: [PROMPTS.deny],
      },
      (session) =>
        Effect.gen(function* () {
          const recording = yield* session.open();
          const answered = yield* answerCards(recording, "deny");
          yield* turn(recording, text(PROMPTS.deny));
          yield* closed(recording);
          expect(answered.size).toBeGreaterThan(0);
          expect(NodeFS.existsSync(NodePath.join(session.repo, "denied.txt"))).toBe(false);
        }),
    ),
  );

  it.live.skipIf(!RECORD)("sensitive-full-access: cat .env under full access", () =>
    recordScenario(
      {
        scenario: "sensitive-full-access",
        description:
          "Full access, in a repo with a stand-in .env: the model is asked to cat it. What the CLI does is recorded as it happened — whether it asks (any card is denied) or runs the read unasked.",
        prompts: [PROMPTS.sensitive],
        settings: { ...SETTINGS, runtimeMode: "full-access" },
        prepare: (repo) => NodeFS.writeFileSync(NodePath.join(repo, ".env"), SCRATCH_ENV, "utf8"),
      },
      (session) =>
        Effect.gen(function* () {
          const recording = yield* session.open();
          yield* answerCards(recording, "deny");
          yield* turn(recording, text(PROMPTS.sensitive));
          yield* closed(recording);
        }),
    ),
  );

  it.live.skipIf(!RECORD)("bearer-hidden: a command reads the MCP bearer's variable", () =>
    recordScenario(
      {
        scenario: "bearer-hidden",
        description:
          "Full access: the model runs a command that echoes the MCP bearer's variable. The session's shell environment override blanks it, so the command prints token=[] while the CLI's own MCP client keeps the value.",
        prompts: [PROMPTS.bearer],
        settings: { ...SETTINGS, runtimeMode: "full-access" },
      },
      (session) =>
        Effect.gen(function* () {
          const recording = yield* session.open();
          yield* answerCards(recording, "allow-once");
          yield* turn(recording, text(PROMPTS.bearer));
          yield* closed(recording);
          const outputs = (yield* recording.collector.collected).flatMap((event) =>
            event.type === "item.completed" && event.payload.item.kind === "command_execution"
              ? [JSON.stringify(event.payload.item)]
              : [],
          );
          expect(outputs.some((row) => row.includes("token=[]"))).toBe(true);
        }),
    ),
  );

  it.live.skipIf(!RECORD)("approval-stop: Stop and close with a card open", () =>
    recordScenario(
      {
        scenario: "approval-stop",
        description:
          "Approval required, two turns in one process, each stopped with its file-change card still open: the first by Stop (the request answered cancel, then turn/interrupt), the second by closing the session, which answers nothing. Neither file is written.",
        prompts: [PROMPTS.stopEdit, PROMPTS.closeEdit],
      },
      (session) =>
        Effect.gen(function* () {
          const recording = yield* session.open();
          const card = () =>
            recording.collector.awaitItem(
              (event) =>
                event.type === "request.opened" && !seen.has(event.payload.request.requestId),
            );
          const seen = new Set<string>();
          yield* recording.handle.send(text(PROMPTS.stopEdit));
          const first = yield* card();
          if (first.type === "request.opened") seen.add(first.payload.request.requestId);
          yield* recording.handle.interrupt();
          const stopped = yield* recording.collector.awaitItem(
            (event) => event.type === "turn.completed",
          );
          expect(stopped.type === "turn.completed" && stopped.payload.stopReason).toBe(
            "interrupted",
          );
          yield* recording.handle.send(text(PROMPTS.closeEdit));
          yield* card();
          yield* closed(recording);
          expect(NodeFS.existsSync(NodePath.join(session.repo, "stop.txt"))).toBe(false);
          expect(NodeFS.existsSync(NodePath.join(session.repo, "close.txt"))).toBe(false);
        }),
    ),
  );
});
