/**
 * The session's *process mechanics*, against a real spawned child.
 *
 * What the harness says on the wire is not this file's subject —
 * `recordedSession.test.ts` and `recordedFrames.test.ts` cover that, and every
 * frame in them came off the real CLI. This one drives a deliberately minimal
 * node stub, because what it checks cannot be replayed from a fixed recording:
 * a child that ignores SIGINT and has to be escalated to SIGKILL, a final frame
 * that arrives without its newline, a process that never exits, two sends
 * racing for one slot, a transcript that is already there when a resumed
 * session starts.
 *
 * The stub emits the shape of a turn — it is scaffolding for those cases, not a
 * description of Command Code. Where the two disagree, the recordings are right.
 *
 * The child gets a redirected `HOME` (through the allowlist, the way extraEnv
 * flows) so its transcript lands in a temp `~/.commandcode`, and the session is
 * told the same home so the tailer reads that file. Nothing in the test touches
 * the real `~/.commandcode` or `~/.poseidon`.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { makeConnectorInstanceId, makeThreadId } from "@poseidon/contracts/ids";
import type { ConnectorServices, PermissionDecision } from "@poseidon/connector-sdk/definition";
import { makeStreamCollector } from "@poseidon/connector-sdk/streamCollector";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import { NPX_PACKAGE } from "./binary";
import { makeCmdSession, type CmdSessionRef } from "./session";
import { transcriptPathFor } from "./transcript";

const SESSION_ID = "00000000-0000-7000-8000-57ub0cmd0001";

/**
 * The stub `cmd`: emits the frame sequence of a turn and appends the assistant
 * message to the transcript mid-run — the overlap the translator dedupes. The
 * `POSEIDON_STUB_*` knobs are what let one script stand in for the several
 * process behaviours this file has to provoke.
 */
const STUB_CMD = `#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
const sessionId = process.env.POSEIDON_STUB_SESSION_ID;
const home = process.env.HOME;
const cwd = process.cwd();
const slug = cwd.toLowerCase().replaceAll("/", "-").replace(/^-/, "");
const dir = path.join(home, ".commandcode", "projects", slug);
fs.mkdirSync(dir, { recursive: true });
// \`cmd mcp add-json|remove\`: the real CLI owns this file, because only it
// knows how its project directory is spelled. The stub owns the stub's.
const argv = process.argv.slice(2);
if (argv[0] === "mcp") {
  const file = path.join(dir, "mcp.json");
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const servers = { ...(config.mcpServers ?? {}) };
  if (argv[1] === "add-json") servers[argv[2]] = JSON.parse(argv[3]);
  else if (argv[1] === "remove") delete servers[argv[2]];
  else process.exit(1);
  if (Object.keys(servers).length === 0) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, JSON.stringify({ ...config, mcpServers: servers }, null, 2) + "\\n");
  process.exit(0);
}
if (process.env.POSEIDON_STUB_ARGV_LOG) {
  fs.appendFileSync(process.env.POSEIDON_STUB_ARGV_LOG, JSON.stringify(argv) + "\\n");
}
if (process.env.POSEIDON_STUB_EXIT_ONCE && !fs.existsSync(process.env.POSEIDON_STUB_EXIT_ONCE)) {
  // A process that dies before it says a word — a failed login, an npx that
  // could not start — once; the next spawn runs normally.
  fs.writeFileSync(process.env.POSEIDON_STUB_EXIT_ONCE, "");
  process.exit(3);
}
const transcript = path.join(dir, sessionId + ".jsonl");
const emit = (event) =>
  process.stdout.write(JSON.stringify({ type: "event", event }) + "\\n");
if (process.env.POSEIDON_STUB_PID_FILE) {
  fs.writeFileSync(process.env.POSEIDON_STUB_PID_FILE, String(process.pid));
}
if (process.env.POSEIDON_STUB_APPEND === "1") {
  // A resumed session's transcript already exists — only this run appends.
} else {
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd }) + "\\n",
  );
}
if (process.env.POSEIDON_STUB_IGNORE_SIGINT === "1") {
  // A child that ignores SIGINT — the case a bare signal wedges forever.
  process.on("SIGINT", () => {});
} else {
  process.on("SIGINT", () => process.exit(130));
}
emit({ type: "run_start", sessionId });
emit({ type: "turn_start", turnNumber: 1 });
emit({ type: "message_start" });
emit({ type: "model_request_start", model: "stub/model" });
if (process.env.POSEIDON_STUB_TOOL === "1") {
  // A tool call that reaches the machine. Whether a hook fired for it is the
  // subject; the gate file lets the test answer it before the turn settles.
  emit({ type: "tool_queued", toolCallId: "call-1", toolName: "shell_command", input: { command: "rm -rf build" } });
  emit({ type: "tool_completed", toolCallId: "call-1", toolName: "shell_command", result: [{ type: "text", text: "" }], deferred: false });
}
if (process.env.POSEIDON_STUB_PLAN_REFUSED === "1") {
  // A plan turn as the connector spawns it now: no --yolo, so print mode
  // refuses the plan file — and the whole plan is in the frame that announced
  // the call. Nothing is written to disk here on purpose.
  const planPath = path.join(home, ".commandcode", "plans", "stub-plan.md");
  emit({ type: "tool_queued", toolCallId: "plan-1", toolName: "write_file", input: { file_path: planPath, content: "# The plan\\n\\n1. do the thing\\n" } });
  emit({ type: "tool_hook_blocked", toolCallId: "plan-1", toolName: "write_file", hookOutput: 'Error: Tool "write_file" requires permissions. Use --yolo (or --dangerously-skip-permissions) to enable file writes and shell commands in print mode.' });
}
if (process.env.POSEIDON_STUB_GATE) {
  const gate = process.env.POSEIDON_STUB_GATE;
  while (!fs.existsSync(gate)) {
    // Busy-wait: this stub has nothing else to do and the test is the only
    // thing that can release it.
  }
}
const userMessage = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
  meta: { source: "user", createdAt: 1, messageId: "u-1" },
};
const assistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: process.env.POSEIDON_STUB_TEXT ?? "hello from the stub" }],
  meta: { source: "model", createdAt: 2, messageId: process.env.POSEIDON_STUB_MSG_ID ?? "a-1" },
};
fs.appendFileSync(
  transcript,
  JSON.stringify({ type: "message", id: process.env.POSEIDON_STUB_LINE_ID ?? "l1", parentId: null, timestamp: "t", message: assistantMessage, model: "stub/model" }) + "\\n",
);
if (process.env.POSEIDON_STUB_PLAN === "1") {
  // What --permission-mode plan leaves behind: a markdown file
  // plus a plans-index.json entry keyed by file name and matched by sessionId.
  const plansDir = path.join(home, ".commandcode", "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  const planFile = "poseidon-plan.md";
  fs.writeFileSync(path.join(plansDir, planFile), "# The plan\\n\\n1. do the thing\\n");
  fs.writeFileSync(
    path.join(plansDir, "plans-index.json"),
    JSON.stringify({
      version: 1,
      plans: {
        "someone-elses.md": { title: "other", sessionId: "other-session", cwd, status: "done", createdAt: 1, updatedAt: 9 },
        [planFile]: { title: "The plan", sessionId, cwd, status: "done", createdAt: 2, updatedAt: 2 },
      },
    }) + "\\n",
  );
}
if (process.env.POSEIDON_STUB_SLEEP === "1") {
  setInterval(() => {}, 1000);
} else if (process.env.POSEIDON_STUB_UNTERMINATED === "1") {
  // The run_end frame with no trailing newline: it can only arrive through
  // the splitter's EOF flush.
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      sessionId,
      usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1,
      finalText: "hello from the stub",
    }) + "\\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "event",
      event: {
        type: "run_end",
        result: {
          finalText: "hello from the stub",
          stopReason: "end_turn",
          turnCount: 1,
          usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
          nextState: { sessionId, messages: [userMessage, assistantMessage], interrupted: false },
        },
      },
    }),
  );
  process.exit(0);
} else {
  emit({
    type: "run_end",
    result: {
      finalText: "hello from the stub",
      stopReason: "end_turn",
      turnCount: 1,
      usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      nextState: { sessionId, messages: [userMessage, assistantMessage], interrupted: false },
    },
  });
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      sessionId,
      usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1,
      finalText: "hello from the stub",
    }) + "\\n",
  );
  process.exit(0);
}
`;

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly poseidonHome: string;
  readonly binary: string;
}

const fixture = (): Effect.Effect<Fixture, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync((): Fixture => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-session-test-"));
      const home = NodePath.join(root, "home");
      const poseidonHome = NodePath.join(root, "poseidon");
      NodeFS.mkdirSync(NodePath.join(root, "workspace"), { recursive: true });
      NodeFS.mkdirSync(home, { recursive: true });
      const binary = NodePath.join(root, "stub-cmd.mjs");
      NodeFS.writeFileSync(binary, STUB_CMD, { mode: 0o755 });
      return { root, home, poseidonHome, binary };
    }),
    (f) =>
      Effect.sync(() => {
        NodeFS.rmSync(f.root, { recursive: true, force: true });
        if (previousPoseidonHome === undefined) {
          delete process.env.POSEIDON_HOME;
        } else {
          process.env.POSEIDON_HOME = previousPoseidonHome;
        }
        previousPoseidonHome = undefined;
      }),
  );

// ensureHookScript reads process.env.POSEIDON_HOME; each fixture redirects it
// and the release above puts the previous value back.
let previousPoseidonHome: string | undefined;

const withPoseidonHome = (f: Fixture): void => {
  previousPoseidonHome = process.env.POSEIDON_HOME;
  process.env.POSEIDON_HOME = f.poseidonHome;
};

const services = (
  decide: PermissionDecision,
  registered?: Ref.Ref<((body: unknown) => Effect.Effect<unknown>) | null>,
): Effect.Effect<ConnectorServices> =>
  Effect.clockWith((clock) =>
    Effect.succeed<ConnectorServices>({
      mcpEndpoint: () => Effect.succeed({ url: "", bearer: "" }),
      hookEndpoint: () =>
        Effect.succeed({ url: "http://127.0.0.1:9/hooks/pretooluse", bearer: "t" }),
      ...(registered === undefined
        ? {}
        : {
            registerHookHandler: (_threadId, handler) => Ref.set(registered, handler),
            unregisterHookHandler: (_threadId) => Ref.set(registered, null),
          }),
      permissions: { decide: () => Effect.succeed(decide) },
      attachmentsDir: "/tmp/poseidon-attachments",
      logger: { log: () => Effect.void },
      clock,
    }),
  );

const startSession = (
  f: Fixture,
  decide: PermissionDecision,
  registered?: Ref.Ref<((body: unknown) => Effect.Effect<unknown>) | null>,
  extraEnv: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const handle = yield* makeCmdSession({
      instanceId: makeConnectorInstanceId(),
      threadId: makeThreadId(),
      workspaceRoot: NodePath.join(f.root, "workspace"),
      binaryPath: f.binary,
      extraEnv: {
        HOME: f.home,
        POSEIDON_STUB_SESSION_ID: SESSION_ID,
        ...extraEnv,
      },
      home: f.home,
      services: yield* services(decide, registered),
      settings: {
        model: "stub/model",
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    });
    const collector = yield* makeStreamCollector(handle.events);
    return { handle, collector };
  });

const isType =
  (type: string) =>
  (event: { type: string }): boolean =>
    event.type === type;

describe("makeCmdSession against a real spawned process", () => {
  it.effect("runs a turn: frames plus transcript dedupe into one event stream", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withPoseidonHome(f);
      const { handle, collector } = yield* startSession(f, "allow");

      yield* handle.send({ text: "hi", attachments: [], mentions: [] });
      const completed = yield* collector.awaitItem(isType("turn.completed"));

      expect(completed.type === "turn.completed" && completed.payload.stopReason).toBe("end_turn");
      const events = yield* collector.collected;
      const typeList = events.map((event) => event.type);
      expect(typeList[0]).toBe("session.started");
      expect(typeList).toContain("turn.started");
      expect(typeList).toContain("model.changed");
      expect(typeList).toContain("usage.updated");

      // The assistant text arrived twice — transcript append and nextState —
      // and produced exactly one item.
      const assistant = events.filter(
        (event) =>
          event.type === "item.completed" && event.payload.item.kind === "assistant_message",
      );
      expect(assistant).toHaveLength(1);
      expect(assistant[0]?.type === "item.completed" && assistant[0].payload.item.text).toBe(
        "hello from the stub",
      );

      // The sessionRef the engine persists points at the redirected transcript.
      const started = events.find(isType("session.started"));
      const ref =
        started?.type === "session.started" ? (started.payload.sessionRef as CmdSessionRef) : null;
      expect(ref?.sessionId).toBe(SESSION_ID);
      expect(ref?.cwd).toBe(NodePath.join(f.root, "workspace"));
      expect(ref?.transcriptPath).toBe(
        transcriptPathFor(
          NodeFS.realpathSync(NodePath.join(f.root, "workspace")),
          SESSION_ID,
          f.home,
        ),
      );
      expect(NodeFS.existsSync(ref!.transcriptPath)).toBe(true);

      const persisted = (yield* handle.sessionRef()) as CmdSessionRef | null;
      expect(persisted?.sessionId).toBe(SESSION_ID);

      // A second turn spawns a fresh process resuming the same session.
      yield* handle.send({ text: "again", attachments: [], mentions: [] });
      yield* collector.awaitItem(
        (event) => event.type === "turn.completed" && event.eventId !== completed.eventId,
      );
      const after = yield* collector.collected;
      expect(after.filter(isType("turn.completed"))).toHaveLength(2);
      // The ref is re-announced when a turn settles — `thread.session.bound`
      // is the only writer of the resume marker and `session.started` the only
      // event that reaches it — but it always names the same session.
      const announced = after.flatMap((event) =>
        event.type === "session.started"
          ? [(event.payload.sessionRef as CmdSessionRef).sessionId]
          : [],
      );
      expect(new Set(announced)).toEqual(new Set([SESSION_ID]));

      yield* handle.close();
      yield* collector.awaitDone;
      expect((yield* collector.collected).at(-1)?.type).toBe("session.ended");
    }),
  );

  it.effect("interrupt signals the process and settles the turn interrupted", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withPoseidonHome(f);
      // The sleeping variant of the stub never finishes on its own.
      const { handle, collector } = yield* Effect.gen(function* () {
        const handle = yield* makeCmdSession({
          instanceId: makeConnectorInstanceId(),
          threadId: makeThreadId(),
          workspaceRoot: NodePath.join(f.root, "workspace"),
          binaryPath: f.binary,
          extraEnv: {
            HOME: f.home,
            POSEIDON_STUB_SESSION_ID: SESSION_ID,
            POSEIDON_STUB_SLEEP: "1",
          },
          home: f.home,
          services: yield* services("allow"),
          settings: {
            model: "stub/model",
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
        });
        const collector = yield* makeStreamCollector(handle.events);
        return { handle, collector };
      });
      yield* handle.send({ text: "block", attachments: [], mentions: [] });
      yield* collector.awaitItem(isType("turn.started"));
      yield* handle.interrupt();
      const completed = yield* collector.awaitItem(isType("turn.completed"));
      expect(completed.type === "turn.completed" && completed.payload.stopReason).toBe(
        "interrupted",
      );
      yield* handle.close();
    }),
  );

  // Live clock: the escalation waits out a real 5-second grace period.
  it.live(
    "interrupt escalates to SIGKILL when the child ignores SIGINT",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        withPoseidonHome(f);
        // A bare SIGINT leaves this one running: without the kill ladder the
        // turn never settles and the thread can never send again.
        const { handle, collector } = yield* startSession(f, "allow", undefined, {
          POSEIDON_STUB_SLEEP: "1",
          POSEIDON_STUB_IGNORE_SIGINT: "1",
        });
        yield* handle.send({ text: "block", attachments: [], mentions: [] });
        yield* collector.awaitItem(isType("turn.started"));
        yield* handle.interrupt();

        // SIGKILL leaves no exit code at all, and that must still read as the
        // interrupt the user asked for rather than an error or a crash.
        const completed = yield* collector.awaitItem(isType("turn.completed"));
        expect(completed.type === "turn.completed" && completed.payload.stopReason).toBe(
          "interrupted",
        );
        const events = yield* collector.collected;
        expect(events.filter(isType("session.ended"))).toHaveLength(0);

        yield* handle.close();
      }),
    30_000,
  );

  it.effect("a child killed mid-turn ends the session crashed", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withPoseidonHome(f);
      const { handle, collector } = yield* startSession(f, "allow", undefined, {
        POSEIDON_STUB_SLEEP: "1",
        POSEIDON_STUB_PID_FILE: NodePath.join(f.root, "child.pid"),
      });
      yield* handle.send({ text: "hi", attachments: [], mentions: [] });
      yield* collector.awaitItem(isType("turn.started"));

      // Somebody else's `kill -9`: the supervisor only gets to resume when
      // the connector says the session ended and why.
      yield* Effect.sync(() => {
        const pid = Number(NodeFS.readFileSync(NodePath.join(f.root, "child.pid"), "utf8"));
        process.kill(pid, "SIGKILL");
      });

      const ended = yield* collector.awaitItem(isType("session.ended"));
      expect(ended.type === "session.ended" && ended.payload.reason).toBe("crashed");
      yield* collector.awaitDone;

      // And the project config was still put back on the way out.
      const settingsPath = NodePath.join(
        f.root,
        "workspace",
        ".commandcode",
        "settings.local.json",
      );
      expect(NodeFS.existsSync(settingsPath)).toBe(false);
    }),
  );

  it.effect("routes a hook post through permissions and resolves prompts", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withPoseidonHome(f);
      const registered = yield* Ref.make<((body: unknown) => Effect.Effect<unknown>) | null>(null);
      // The sleeping stub keeps the process alive while hook posts are in
      // flight — otherwise a finished child releases the parked request with
      // an empty answer before respondToUserInput can land.
      const { handle, collector } = yield* startSession(f, "prompt", registered, {
        POSEIDON_STUB_SLEEP: "1",
      });

      // Registration happens at session start, before any turn.
      const handler = yield* Ref.get(registered);
      expect(handler).not.toBeNull();

      yield* handle.send({ text: "hi", attachments: [], mentions: [] });
      yield* collector.awaitItem(isType("session.started"));

      const hookBody = {
        session_id: SESSION_ID,
        hook_event_name: "PreToolUse",
        tool_use_id: "hook-1",
        tool_name: "shell_command",
        tool_input: { command: "rm -rf build" },
        cwd: NodePath.join(f.root, "workspace"),
      };
      const answer = yield* Effect.forkChild(handler!(hookBody));
      const opened = yield* collector.awaitItem(isType("request.opened"));
      const requestId = opened.type === "request.opened" ? opened.payload.request.requestId : null;
      expect(requestId).not.toBeNull();
      // The card's "allow always" starts from a suggested pattern derived from
      // the actual input — `Shell(<first-word> *)` for a shell command.
      expect(opened.type === "request.opened" && opened.payload.request.patternSuggestion).toBe(
        "Shell(rm *)",
      );
      yield* handle.respondToRequest(requestId!, "allow-once");
      const response = (yield* Fiber.join(answer)) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(response.hookSpecificOutput.permissionDecision).toBe("allow");
      yield* collector.awaitItem(isType("request.resolved"));

      // ask_user_question goes through user-input, answered deny + answers.
      const question = yield* Effect.forkChild(
        handler!({
          ...hookBody,
          tool_name: "ask_user_question",
          tool_input: {
            questions: [
              {
                questionId: "q1",
                question: "which?",
                options: [{ optionId: "a", label: "A" }],
              },
            ],
          },
        }),
      );
      const asked = yield* collector.awaitItem(isType("user-input.requested"));
      const askedId = asked.type === "user-input.requested" ? asked.payload.requestId : null;
      yield* handle.respondToUserInput(askedId!, [{ questionId: "q1", optionIds: ["a"] }]);
      const questionResponse = (yield* Fiber.join(question)) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
      };
      expect(questionResponse.hookSpecificOutput.permissionDecision).toBe("deny");
      // The model gets its own words back, not the ids the card ran on.
      expect(JSON.parse(questionResponse.hookSpecificOutput.permissionDecisionReason)).toEqual([
        { question: "which?", selected: ["A"] },
      ]);

      // A payload with no ids at all — bare string options, which the card
      // numbers `o1`/`o2`. Those ids appear nowhere in the model's tool_input,
      // so the answer has to travel as the labels it minted them for.
      const bare = yield* Effect.forkChild(
        handler!({
          ...hookBody,
          tool_name: "ask_user_question",
          tool_input: { questions: [{ question: "ship it?", options: ["now", "after review"] }] },
        }),
      );
      // Past items match too, so this has to be the card that is not the first.
      const bareAsked = yield* collector.awaitItem(
        (event) => event.type === "user-input.requested" && event.payload.requestId !== askedId,
      );
      const bareId = bareAsked.type === "user-input.requested" ? bareAsked.payload.requestId : null;
      yield* handle.respondToUserInput(bareId!, [
        { questionId: "q1", optionIds: ["o2"], text: "but check the migration" },
      ]);
      const bareResponse = (yield* Fiber.join(bare)) as {
        hookSpecificOutput: { permissionDecisionReason: string };
      };
      expect(JSON.parse(bareResponse.hookSpecificOutput.permissionDecisionReason)).toEqual([
        {
          question: "ship it?",
          selected: ["after review"],
          text: "but check the migration",
        },
      ]);

      yield* handle.close();
    }),
  );

  it.effect("resume tails the transcript from lastMessageId, deduping what a dead server saw", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withPoseidonHome(f);
      const root = NodePath.join(f.root, "workspace");
      // The transcript a previous runtime left behind: the session header, the
      // message already emitted (l1/a-1), and one written while the server was
      // down (l2/a-2) — the line only a marker-positioned resume can deliver.
      const transcriptPath = transcriptPathFor(NodeFS.realpathSync(root), SESSION_ID, f.home);
      NodeFS.mkdirSync(NodePath.dirname(transcriptPath), { recursive: true });
      const transcriptLine = (id: string, messageId: string, text: string): string =>
        JSON.stringify({
          type: "message",
          id,
          parentId: null,
          timestamp: "t",
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            meta: { source: "model", createdAt: 1, messageId },
          },
          model: "stub/model",
        });
      NodeFS.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: SESSION_ID,
            timestamp: "t",
            cwd: root,
          }),
          transcriptLine("l1", "a-1", "already emitted"),
          transcriptLine("l2", "a-2", "written while the server was down"),
        ].join("\n") + "\n",
      );

      const handle = yield* makeCmdSession({
        instanceId: makeConnectorInstanceId(),
        threadId: makeThreadId(),
        workspaceRoot: root,
        binaryPath: f.binary,
        extraEnv: {
          HOME: f.home,
          POSEIDON_STUB_SESSION_ID: SESSION_ID,
          POSEIDON_STUB_APPEND: "1",
          // The sleeping stub keeps the process (and its tailer) alive long
          // enough for the catch-up lines to land.
          POSEIDON_STUB_SLEEP: "1",
          POSEIDON_STUB_MSG_ID: "a-3",
          POSEIDON_STUB_LINE_ID: "l3",
          POSEIDON_STUB_TEXT: "fresh reply",
        },
        home: f.home,
        services: yield* services("allow"),
        settings: {
          model: "stub/model",
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
        sessionRef: {
          sessionId: SESSION_ID,
          transcriptPath,
          cwd: root,
          lastMessageId: "a-1",
        },
      });
      const collector = yield* makeStreamCollector(handle.events);

      yield* handle.send({ text: "again", attachments: [], mentions: [] });
      // The session-start payload carries the marker the resume used.
      const started = yield* collector.awaitItem(isType("session.started"));
      const payloadRef =
        started.type === "session.started" ? (started.payload.sessionRef as CmdSessionRef) : null;
      expect(payloadRef?.lastMessageId).toBe("a-1");

      // Past the marker: the downtime line and this turn's reply.
      const itemText = (event: { type: string; payload?: unknown }): string | null =>
        event.type === "item.completed" &&
        (event.payload as { item: { kind: string; text?: string } }).item.kind ===
          "assistant_message"
          ? ((event.payload as { item: { text?: string } }).item.text ?? null)
          : null;
      yield* collector.awaitItem(
        (event) => itemText(event) === "written while the server was down",
      );
      yield* collector.awaitItem((event) => itemText(event) === "fresh reply");
      const texts = (yield* collector.collected).flatMap((event) => {
        const text = itemText(event);
        return text === null ? [] : [text];
      });
      // At-or-before the marker: never re-emitted.
      expect(texts).not.toContain("already emitted");

      yield* handle.close();
    }),
  );

  /**
   * A fork's session is seeded from the source's transcript, whose header
   * names the source. When the fork's first process dies before `run_start`,
   * the harness never named the forked session — announcing the id the seed
   * left behind bound the fork thread to the source's session, and a fresh
   * attach then resumed it without `--fork-session`.
   */
  it.effect("a fork whose first process dies before run_start announces nothing", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withPoseidonHome(f);
      const root = NodePath.join(f.root, "workspace");
      const sourceId = "00000000-0000-7000-8000-57ub0cmd0002";
      const transcriptPath = transcriptPathFor(NodeFS.realpathSync(root), sourceId, f.home);
      NodeFS.mkdirSync(NodePath.dirname(transcriptPath), { recursive: true });
      NodeFS.writeFileSync(
        transcriptPath,
        JSON.stringify({ type: "session", version: 3, id: sourceId, timestamp: "t", cwd: root }) +
          "\n",
      );
      const argvLog = NodePath.join(f.root, "argv.ndjson");

      const handle = yield* makeCmdSession({
        instanceId: makeConnectorInstanceId(),
        threadId: makeThreadId(),
        workspaceRoot: root,
        binaryPath: f.binary,
        extraEnv: {
          HOME: f.home,
          POSEIDON_STUB_SESSION_ID: SESSION_ID,
          POSEIDON_STUB_EXIT_ONCE: NodePath.join(f.root, "exited"),
          POSEIDON_STUB_ARGV_LOG: argvLog,
        },
        home: f.home,
        services: yield* services("allow"),
        settings: {
          model: "stub/model",
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
        sessionRef: { sessionId: sourceId, transcriptPath, cwd: root, lastMessageId: null },
        fork: true,
      });
      const collector = yield* makeStreamCollector(handle.events);

      yield* handle.send({ text: "hi", attachments: [], mentions: [] });
      yield* collector.awaitItem(isType("runtime.error"));
      // The next send waits out the dead process's bookkeeping, then forks.
      yield* handle.send({ text: "again", attachments: [], mentions: [] });
      yield* collector.awaitItem(isType("turn.completed"));

      const announced = (yield* collector.collected).flatMap((event) =>
        event.type === "session.started"
          ? [(event.payload.sessionRef as CmdSessionRef).sessionId]
          : [],
      );
      expect(announced).not.toContain(sourceId);
      expect(announced).toContain(SESSION_ID);
      const turns = NodeFS.readFileSync(argvLog, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as ReadonlyArray<string>)
        .filter((argv) => argv[0] === "-p");
      expect(turns).toHaveLength(2);
      for (const argv of turns) {
        expect(argv).toContain("--fork-session");
        expect(argv[argv.indexOf("--session") + 1]).toBe(sourceId);
      }

      yield* handle.close();
    }),
  );

  /**
   * The ref every real thread actually has on disk.
   *
   * `lastMessageId` was filled in at `session.started`, which is `run_start` —
   * before a single transcript line had been read — and the in-memory updates
   * that follow were never re-persisted. So the stored marker was null for
   * every session that was ever started fresh, and a resumed turn reconciled
   * `run_end`'s `nextState.messages` from index 0 with an empty `seenMessages`:
   * every assistant message and every reasoning block of the whole history
   * came back with new itemIds, at the bottom of the timeline.
   */
  it.effect("a resume with no marker replays nothing it has already shown", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withPoseidonHome(f);
      const root = NodePath.join(f.root, "workspace");
      const transcriptPath = transcriptPathFor(NodeFS.realpathSync(root), SESSION_ID, f.home);
      NodeFS.mkdirSync(NodePath.dirname(transcriptPath), { recursive: true });
      NodeFS.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: SESSION_ID,
            timestamp: "t",
            cwd: root,
          }),
          JSON.stringify({
            type: "message",
            id: "l1",
            parentId: null,
            timestamp: "t",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "the answer from last time" }],
              meta: { source: "model", createdAt: 1, messageId: "a-1" },
            },
            model: "stub/model",
          }),
        ].join("\n") + "\n",
      );

      const handle = yield* makeCmdSession({
        instanceId: makeConnectorInstanceId(),
        threadId: makeThreadId(),
        workspaceRoot: root,
        binaryPath: f.binary,
        extraEnv: {
          HOME: f.home,
          POSEIDON_STUB_SESSION_ID: SESSION_ID,
          POSEIDON_STUB_APPEND: "1",
          POSEIDON_STUB_MSG_ID: "a-2",
          POSEIDON_STUB_LINE_ID: "l2",
          POSEIDON_STUB_TEXT: "this turn's answer",
        },
        home: f.home,
        services: yield* services("allow"),
        settings: {
          model: "stub/model",
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
        // What the thread document really holds: no marker at all.
        sessionRef: { sessionId: SESSION_ID, transcriptPath, cwd: root, lastMessageId: null },
      });
      const collector = yield* makeStreamCollector(handle.events);

      yield* handle.send({ text: "again", attachments: [], mentions: [] });
      yield* collector.awaitItem(isType("turn.completed"));
      const texts = (yield* collector.collected).flatMap((event) =>
        event.type === "item.completed" && event.payload.item.kind === "assistant_message"
          ? [event.payload.item.text ?? ""]
          : [],
      );
      expect(texts).not.toContain("the answer from last time");
      expect(texts).toContain("this turn's answer");

      // And the ref reaches the thread document with a marker that is actually
      // true, so the next resume can tell history from what it has not shown.
      yield* collector.awaitItem(
        (event) =>
          event.type === "session.started" &&
          (event.payload.sessionRef as CmdSessionRef).lastMessageId === "a-2",
      );
      const persisted = (yield* handle.sessionRef()) as CmdSessionRef | null;
      expect(persisted?.lastMessageId).toBe("a-2");

      yield* handle.close();
    }),
  );

  /**
   * The approval gate fails open. A hook that does not run — a command the
   * shell mis-parsed, a script that is not executable — produces no decision,
   * and the harness falls back to its own flow, which under `--yolo` allows
   * everything. Across all 28 recorded turns the counts match exactly, one
   * PreToolUse post per queued call, so a turn that queued tools and posted
   * nothing is the observable sign of a gate that is not there.
   */
  it.effect("says so when a turn ran tool calls and no hook ever posted", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withPoseidonHome(f);
      const { handle, collector } = yield* startSession(f, "allow", undefined, {
        POSEIDON_STUB_TOOL: "1",
      });

      yield* handle.send({ text: "hi", attachments: [], mentions: [] });
      const warned = yield* collector.awaitItem(
        (event) =>
          event.type === "session.warning" && event.payload.message.includes("approval gate"),
      );
      expect(warned.type === "session.warning" && warned.payload.message).toContain("did not fire");
      yield* handle.close();
    }),
  );

  it.effect("stays quiet on a turn whose tool calls did reach the gate", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withPoseidonHome(f);
      const registered = yield* Ref.make<((body: unknown) => Effect.Effect<unknown>) | null>(null);
      const gate = NodePath.join(f.root, "gate");
      const { handle, collector } = yield* startSession(f, "allow", registered, {
        POSEIDON_STUB_TOOL: "1",
        POSEIDON_STUB_GATE: gate,
      });
      const handler = (yield* Ref.get(registered))!;

      yield* handle.send({ text: "hi", attachments: [], mentions: [] });
      // The row the tool call opened is the receipt that the turn is under way.
      yield* collector.awaitItem(
        (event) => event.type === "item.started" && event.payload.item.kind === "command_execution",
      );
      yield* handler({
        session_id: SESSION_ID,
        hook_event_name: "PreToolUse",
        tool_name: "shell_command",
        tool_input: { command: "rm -rf build" },
      });
      NodeFS.writeFileSync(gate, "go");
      yield* collector.awaitItem(isType("turn.completed"));
      const warnings = (yield* collector.collected).filter(isType("session.warning"));
      expect(
        warnings.some(
          (event) =>
            event.type === "session.warning" && event.payload.message.includes("approval gate"),
        ),
      ).toBe(false);
      yield* handle.close();
    }),
  );

  /**
   * A plan turn is the one turn spawned without `--yolo`, because plan mode
   * fires no PreToolUse hook and `--yolo` removed the only enforcement left —
   * print mode's own refusal of writes and shell calls. The plan survives the
   * refusal: its whole body is in the `tool_queued` frame that announced the
   * write, and the session saves the file itself.
   */
  it.effect("saves the plan the harness refused to write, and proposes it", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withPoseidonHome(f);
      const handle = yield* makeCmdSession({
        instanceId: makeConnectorInstanceId(),
        threadId: makeThreadId(),
        workspaceRoot: NodePath.join(f.root, "workspace"),
        binaryPath: f.binary,
        extraEnv: {
          HOME: f.home,
          POSEIDON_STUB_SESSION_ID: SESSION_ID,
          POSEIDON_STUB_PLAN_REFUSED: "1",
        },
        home: f.home,
        services: yield* services("allow"),
        settings: {
          model: "stub/model",
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
      });
      const collector = yield* makeStreamCollector(handle.events);

      yield* handle.send({ text: "plan it", attachments: [], mentions: [] });
      const proposed = yield* collector.awaitItem(isType("turn.plan.proposed"));
      expect(proposed.type === "turn.plan.proposed" && proposed.payload.planMarkdown).toBe(
        "# The plan\n\n1. do the thing\n",
      );
      expect(
        NodeFS.readFileSync(NodePath.join(f.home, ".commandcode", "plans", "stub-plan.md"), "utf8"),
      ).toContain("do the thing");

      // The refusal is not a red row: it is what makes the mode read-only.
      const rows = (yield* collector.collected).flatMap((event) =>
        event.type === "item.completed" && event.payload.item.kind === "file_change"
          ? [event.payload.item]
          : [],
      );
      expect(rows.at(-1)?.status).toBe("completed");
      expect(rows.at(-1)?.error).toBeUndefined();

      yield* handle.close();
    }),
  );

  it.effect("the unterminated final frame still lands via the splitter's EOF flush", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withPoseidonHome(f);
      const handle = yield* makeCmdSession({
        instanceId: makeConnectorInstanceId(),
        threadId: makeThreadId(),
        workspaceRoot: NodePath.join(f.root, "workspace"),
        binaryPath: f.binary,
        extraEnv: {
          HOME: f.home,
          POSEIDON_STUB_SESSION_ID: SESSION_ID,
          POSEIDON_STUB_UNTERMINATED: "1",
        },
        home: f.home,
        services: yield* services("allow"),
        settings: {
          model: "stub/model",
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
      });
      const collector = yield* makeStreamCollector(handle.events);

      yield* handle.send({ text: "hi", attachments: [], mentions: [] });
      // usage.updated and the assistant item only exist if the unterminated
      // run_end tail was parsed — the terminated frames ended at `result`,
      // which is where turn.completed comes from here.
      yield* collector.awaitItem(isType("turn.completed"));
      yield* collector.awaitItem(isType("usage.updated"));
      yield* collector.awaitItem(
        (event) =>
          event.type === "item.completed" && event.payload.item.kind === "assistant_message",
      );

      yield* handle.close();
    }),
  );

  it.effect("a plan-mode turn proposes the plan file before completing", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withPoseidonHome(f);
      const handle = yield* makeCmdSession({
        instanceId: makeConnectorInstanceId(),
        threadId: makeThreadId(),
        workspaceRoot: NodePath.join(f.root, "workspace"),
        binaryPath: f.binary,
        extraEnv: {
          HOME: f.home,
          POSEIDON_STUB_SESSION_ID: SESSION_ID,
          POSEIDON_STUB_PLAN: "1",
        },
        home: f.home,
        services: yield* services("allow"),
        settings: {
          model: "stub/model",
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
      });
      const collector = yield* makeStreamCollector(handle.events);

      yield* handle.send({ text: "plan it", attachments: [], mentions: [] });
      const proposed = yield* collector.awaitItem(isType("turn.plan.proposed"));
      expect(proposed.type === "turn.plan.proposed" && proposed.payload.planMarkdown).toContain(
        "# The plan",
      );
      // Matched by sessionId: the other session's index entry is ignored, and
      // the path lands under the stub's own ~/.commandcode/plans.
      expect(proposed.type === "turn.plan.proposed" && proposed.payload.planPath).toBe(
        NodePath.join(f.home, ".commandcode", "plans", "poseidon-plan.md"),
      );

      // The proposal precedes turn.completed, and a second turn in the same
      // mode does not re-propose the same file.
      const completed = yield* collector.awaitItem(isType("turn.completed"));
      const first = yield* collector.collected;
      expect(first.indexOf(proposed)).toBeLessThan(first.indexOf(completed));

      yield* handle.send({ text: "replan", attachments: [], mentions: [] });
      yield* collector.awaitItem(
        (event) => event.type === "turn.completed" && event.eventId !== completed.eventId,
      );
      const all = yield* collector.collected;
      expect(all.filter(isType("turn.plan.proposed"))).toHaveLength(1);

      yield* handle.close();
    }),
  );

  it.effect("concurrent sends are serialized — one wins, one gets TurnInProgress", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withPoseidonHome(f);
      // The sleeping stub keeps turn 1 open, so the loser must fail — the
      // pre-mutex race spawned a second process instead.
      const { handle } = yield* startSession(f, "allow", undefined, {
        POSEIDON_STUB_SLEEP: "1",
      });
      const first = yield* Effect.forkChild(
        handle.send({ text: "one", attachments: [], mentions: [] }),
      );
      const second = yield* Effect.forkChild(
        handle.send({ text: "two", attachments: [], mentions: [] }),
      );
      const outcomes = yield* Effect.all([
        Effect.result(Fiber.join(first)),
        Effect.result(Fiber.join(second)),
      ]);
      const succeeded = outcomes.filter(Result.isSuccess);
      const turnBusy = outcomes.filter(
        (result) => Result.isFailure(result) && result.failure._tag === "TurnInProgress",
      );
      expect(succeeded).toHaveLength(1);
      expect(turnBusy).toHaveLength(1);

      yield* handle.close();
    }),
  );

  it.effect("close puts the project's settings.local.json and mcp.json back", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withPoseidonHome(f);
      const workspace = NodePath.join(f.root, "workspace");
      const settingsPath = NodePath.join(workspace, ".commandcode", "settings.local.json");
      const before = `${JSON.stringify({ permissions: { allow: ["Shell(git status:*)"] } }, null, 2)}\n`;
      NodeFS.mkdirSync(NodePath.dirname(settingsPath), { recursive: true });
      NodeFS.writeFileSync(settingsPath, before, "utf8");

      const base = yield* services("allow");
      const handle = yield* makeCmdSession({
        instanceId: makeConnectorInstanceId(),
        threadId: makeThreadId(),
        workspaceRoot: workspace,
        binaryPath: f.binary,
        extraEnv: { HOME: f.home, POSEIDON_STUB_SESSION_ID: SESSION_ID },
        home: f.home,
        services: {
          ...base,
          mcpEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:4321/mcp", bearer: "b" }),
        },
        settings: {
          model: "stub/model",
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
      });

      // While the session runs, both files carry our entries.
      const installed = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8")) as {
        hooks: { PreToolUse: ReadonlyArray<unknown> };
      };
      expect(installed.hooks.PreToolUse).toHaveLength(1);
      const slug = NodeFS.realpathSync(workspace)
        .toLowerCase()
        .replaceAll("/", "-")
        .replace(/^-/, "");
      const mcpFile = NodePath.join(f.home, ".commandcode", "projects", slug, "mcp.json");
      expect(NodeFS.existsSync(mcpFile)).toBe(true);
      // Never inside the user's repo: the CLI's own local scope.
      expect(NodeFS.existsSync(NodePath.join(workspace, ".mcp.json"))).toBe(false);

      yield* handle.close();

      // Byte-for-byte what the user had, and the file we created is gone.
      expect(NodeFS.readFileSync(settingsPath, "utf8")).toBe(before);
      expect(NodeFS.existsSync(mcpFile)).toBe(false);
    }),
  );

  it.effect("an allow decision answers the hook without opening a request", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withPoseidonHome(f);
      const registered = yield* Ref.make<((body: unknown) => Effect.Effect<unknown>) | null>(null);
      const { handle } = yield* startSession(f, "allow", registered);
      const handler = (yield* Ref.get(registered))!;
      const response = (yield* handler({
        session_id: SESSION_ID,
        hook_event_name: "PreToolUse",
        tool_name: "edit_file",
        tool_input: { file_path: "a.ts" },
      })) as { hookSpecificOutput: { permissionDecision: string } };
      expect(response.hookSpecificOutput.permissionDecision).toBe("allow");
      yield* handle.close();
    }),
  );
});

/**
 * The binary the probe resolved is the binary the turn spawns.
 *
 * Until this landed the resolution was reported to the UI and thrown away:
 * `spawnProcess` asked for the literal string `"cmd"`, resolved against the
 * server's own PATH. The npx fallback is the sharpest version of that bug — the
 * probe says "ready, via npx command-code@latest" and the spawn asks for a
 * binary that is not on the machine at all — so that is what this drives: a
 * PATH with `npx` on it and no `cmd` anywhere.
 */
describe("the resolved binary reaches the spawn", () => {
  it.effect("runs a turn through the npx fallback, package spec and all", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      withPoseidonHome(f);
      // An `npx` that forwards everything after `-y <package>` to the stub,
      // exactly as `npx -y command-code@latest <args>` would.
      const binDir = NodePath.join(f.root, "bin");
      NodeFS.mkdirSync(binDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(binDir, "npx"),
        `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2);
if (argv[0] !== "-y" || argv[1] !== "command-code@latest") process.exit(66);
const result = spawnSync(process.execPath, [process.env.POSEIDON_STUB_REAL_CMD, ...argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
`,
        { mode: 0o755 },
      );
      const handle = yield* makeCmdSession({
        instanceId: makeConnectorInstanceId(),
        threadId: makeThreadId(),
        workspaceRoot: NodePath.join(f.root, "workspace"),
        // What `resolveForSession` answers on a machine with no global install.
        // `binaryPath` is deliberately absent: a resolution that only reached
        // the probe is exactly the bug.
        binary: {
          command: NodePath.join(binDir, "npx"),
          prefixArgs: ["-y", NPX_PACKAGE],
          display: `npx ${NPX_PACKAGE}`,
        },
        extraEnv: {
          HOME: f.home,
          POSEIDON_STUB_SESSION_ID: SESSION_ID,
          POSEIDON_STUB_REAL_CMD: f.binary,
        },
        home: f.home,
        services: yield* services("allow"),
        settings: {
          model: "stub/model",
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
      });
      const collector = yield* makeStreamCollector(handle.events);
      yield* handle.send({ text: "hi", attachments: [], mentions: [] });
      const completed = yield* collector.awaitItem(isType("turn.completed"));
      // The npx stub exits 66 unless it was handed `-y command-code@latest`
      // ahead of the turn's own argv, so a turn that ends `end_turn` is the
      // prefix args having survived into the spawn.
      expect(completed.type === "turn.completed" && completed.payload.stopReason).toBe("end_turn");
      yield* handle.close();
    }),
  );
});
