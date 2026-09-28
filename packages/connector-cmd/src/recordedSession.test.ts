/**
 * `makeCmdSession` against real recordings, through a real spawned process.
 *
 * `session.test.ts` beside this one drives a minimal stub, because the things it
 * checks — SIGINT escalation, a final frame with no newline, two sends racing —
 * are process mechanics a fixed recording cannot vary. This file is the other
 * half: the protocol itself, and nothing in it was written by us. The binary is
 * testkit's replayer and every frame, transcript line, hook payload and exit
 * code came off the real `cmd` 1.55.1.
 *
 * Nothing touches the real `~/.commandcode`: `HOME` is redirected for the child
 * and the session is told the same home, so the tailer reads the replayed file.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { makeConnectorInstanceId, makeThreadId } from "@poseidon/contracts/ids";
import type { ConnectorServices } from "@poseidon/connector-sdk/definition";
import { makeStreamCollector } from "@poseidon/connector-sdk/streamCollector";
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { makeCmdSession, type CmdSessionRef } from "./session";

const TESTKIT = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url), "../../../testkit");
const REPLAY_BINARY = NodePath.join(TESTKIT, "bin", "replay-cmd.mjs");
const RECORDINGS = NodePath.join(TESTKIT, "fixtures", "cmd");

const manifestOf = (scenario: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(RECORDINGS, scenario, "manifest.json"), "utf8")) as {
    readonly model: string;
    readonly turns: ReadonlyArray<{
      readonly sessionId: string;
      readonly prompt: string;
      readonly earlierSessions?: ReadonlyArray<{ sessionId: string; transcriptBytes: number }>;
    }>;
  };

interface Box {
  readonly home: string;
  readonly workspace: string;
}

const box = (): Effect.Effect<Box, never, Scope.Scope> =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-recorded-"))),
      (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
    );
    const home = NodePath.join(root, "home");
    const workspace = NodePath.join(root, "workspace");
    yield* Effect.sync(() => {
      NodeFS.mkdirSync(home, { recursive: true });
      NodeFS.mkdirSync(workspace, { recursive: true });
    });
    return { home, workspace };
  });

const services = (): Effect.Effect<ConnectorServices> =>
  Effect.clockWith((clock) =>
    Effect.succeed<ConnectorServices>({
      mcpEndpoint: () => Effect.succeed({ url: "", bearer: "" }),
      hookEndpoint: () =>
        Effect.succeed({ url: "http://127.0.0.1:9/hooks/pretooluse", bearer: "t" }),
      permissions: { decide: () => Effect.succeed("allow" as const) },
      attachmentsDir: NodePath.join(NodeOS.tmpdir(), "cmd-recorded-attachments"),
      logger: { log: () => Effect.void },
      clock,
    }),
  );

/** Opens a session whose binary replays `scenario`. */
const openSession = (
  scenario: string,
  b: Box,
  options: {
    readonly plan?: boolean;
    readonly argvLog?: string;
    readonly sessionRef?: CmdSessionRef;
    readonly fork?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const handle = yield* makeCmdSession({
      instanceId: makeConnectorInstanceId(),
      threadId: makeThreadId(),
      workspaceRoot: b.workspace,
      binaryPath: REPLAY_BINARY,
      extraEnv: {
        HOME: b.home,
        POSEIDON_REPLAY_DIR: NodePath.join(RECORDINGS, scenario),
        POSEIDON_REPLAY_STATE: NodePath.join(b.home, ".replay-turn"),
        ...(options.argvLog === undefined ? {} : { POSEIDON_REPLAY_ARGV_LOG: options.argvLog }),
      },
      home: b.home,
      ...(options.sessionRef === undefined ? {} : { sessionRef: options.sessionRef }),
      ...(options.fork === undefined ? {} : { fork: options.fork }),
      services: yield* services(),
      settings: {
        model: manifestOf(scenario).model,
        runtimeMode: "approval-required",
        interactionMode: options.plan === true ? "plan" : "default",
      },
    });
    const collector = yield* makeStreamCollector(handle.events);
    return { handle, collector };
  });

const itemsOf = (events: ReadonlyArray<RuntimeEvent>) =>
  events.flatMap((event) =>
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
      ? [event.payload.item]
      : [],
  );

describe("a recorded text turn", () => {
  it.live("announces the session, streams the answer and settles the turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* box();
        const recorded = manifestOf("text").turns[0]!;
        const { handle, collector } = yield* openSession("text", b);

        yield* handle.send({ text: recorded.prompt, attachments: [], mentions: [] });
        yield* collector.awaitItem((event) => event.type === "turn.completed");
        const events = yield* collector.collected;

        const started = events.find((event) => event.type === "session.started");
        expect(started?.type === "session.started" && started.payload.sessionRef).toMatchObject({
          sessionId: recorded.sessionId,
          cwd: b.workspace,
        });

        // The answer arrived as deltas and finished as one completed row.
        expect(events.filter((event) => event.type === "content.delta").length).toBeGreaterThan(0);
        const said = itemsOf(events).filter((item) => item.kind === "assistant_message");
        expect(said.at(-1)?.text).toBe("ok");
        expect(said.at(-1)?.status).toBe("completed");

        // The transcript the tailer found is the one the harness wrote — the
        // slug never names that directory.
        const ref = (yield* handle.sessionRef()) as CmdSessionRef | null;
        expect(ref?.sessionId).toBe(recorded.sessionId);
        expect(NodeFS.existsSync(ref!.transcriptPath)).toBe(true);
        // ...which means the cost only the transcript knows reached the events.
        const usage = events.filter((event) => event.type === "usage.updated");
        expect(
          usage.some(
            (event) => event.type === "usage.updated" && event.payload.costUsd !== undefined,
          ),
        ).toBe(true);
        // And it reached them in time. The transcript's last flush lands with
        // `run_end`, so a cost read after `turn.completed` is a cost the engine
        // no longer tags to this turn — the bug the end-of-turn drain fixed.
        const priced = events.findIndex(
          (event) => event.type === "usage.updated" && event.payload.costUsd !== undefined,
        );
        const completed = events.findIndex((event) => event.type === "turn.completed");
        expect(priced).toBeGreaterThanOrEqual(0);
        expect(priced).toBeLessThan(completed);

        yield* handle.close();
      }),
    ),
  );
});

describe("a recorded tool call", () => {
  it.live("gates it through the hook handler and completes the row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* box();
        const { handle, collector } = yield* openSession("shell-yolo", b);

        yield* handle.send({ text: "run it", attachments: [], mentions: [] });
        yield* collector.awaitItem((event) => event.type === "turn.completed");
        const events = yield* collector.collected;

        const shell = itemsOf(events).filter((item) => item.kind === "command_execution");
        expect(shell.at(0)?.command?.cmd).toBe("cat note.txt");
        expect(shell.at(-1)?.status).toBe("completed");
        expect(shell.at(-1)?.command?.output).toBe("hello\n");
        // One row throughout: queued, running and completed are the same call.
        expect(new Set(shell.map((item) => item.itemId)).size).toBe(1);

        yield* handle.close();
      }),
    ),
  );
});

describe("a recorded plan turn", () => {
  it.live("proposes the plan the run left in ~/.commandcode/plans", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* box();
        // The plan file a real plan turn wrote, put where that run put it.
        const plansDir = NodePath.join(b.home, ".commandcode", "plans");
        yield* Effect.sync(() => {
          NodeFS.mkdirSync(plansDir, { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(plansDir, "subtract-function.md"),
            "# Plan: Add subtract function to app.js\n",
            "utf8",
          );
          // A newer plan from somewhere else — another thread, or the user's
          // own interactive run. The directory is global, so an mtime scan
          // would hand this one to this turn.
          NodeFS.writeFileSync(
            NodePath.join(plansDir, "someone-elses.md"),
            "# Plan: something another conversation is doing\n",
            "utf8",
          );
        });

        const { handle, collector } = yield* openSession("plan", b, { plan: true });
        yield* handle.send({ text: "plan it", attachments: [], mentions: [] });
        yield* collector.awaitItem((event) => event.type === "turn.completed");
        const events = yield* collector.collected;

        const proposed = events.find((event) => event.type === "turn.plan.proposed");
        // Found without a plans-index.json — print mode never writes one — and
        // found by the `write_file` frame this run emitted, which is why the
        // newer file beside it is not the one proposed.
        expect(proposed?.type === "turn.plan.proposed" && proposed.payload.planPath).toContain(
          "subtract-function.md",
        );
        expect(proposed?.type === "turn.plan.proposed" && proposed.payload.planMarkdown).toContain(
          "subtract function",
        );

        yield* handle.close();
      }),
    ),
  );
});

describe("a recorded skill reference", () => {
  /**
   * `skill/` was recorded with the prompt `prepareTurn` writes for this very
   * input: the user's text with its draft token, then the line naming the
   * skill. So the argv the session hands the CLI has to carry that prompt
   * byte for byte, and what came back — the model calling `activate_skill`
   * for the skill, then following it — has to land as a `skill` row.
   */
  it.live("sends the recorded prompt and shows the skill the model activated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* box();
        const recorded = manifestOf("skill").turns[0]!;
        const argvLog = NodePath.join(b.home, "argv.ndjson");
        const { handle, collector } = yield* openSession("skill", b, { argvLog });

        yield* handle.send({
          text: "Greet me with $greeting.",
          attachments: [],
          mentions: [],
          references: [{ kind: "skill", name: "greeting" }],
        });
        yield* collector.awaitItem((event) => event.type === "turn.completed");
        const events = yield* collector.collected;

        const turns = NodeFS.readFileSync(argvLog, "utf8")
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => (JSON.parse(line) as { argv: ReadonlyArray<string> }).argv)
          .filter((argv) => argv[0] === "-p");
        expect(turns).toHaveLength(1);
        expect(turns[0]![1]).toBe(recorded.prompt);

        const skill = itemsOf(events).filter((item) => item.kind === "skill");
        expect(skill.at(0)?.tool).toMatchObject({
          name: "activate_skill",
          input: { name: "greeting" },
        });
        expect(skill.at(-1)?.status).toBe("completed");
        const said = itemsOf(events).filter((item) => item.kind === "assistant_message");
        expect(said.at(-1)?.text).toBe("hello from the greeting skill");
        // A skill reference is not the kind that is left out with a warning.
        const warnings = events.flatMap((event) =>
          event.type === "session.warning" ? [event.payload.message] : [],
        );
        expect(warnings.filter((message) => message.includes("left out"))).toEqual([]);

        yield* handle.close();
      }),
    ),
  );
});

describe("a recorded pair of turns", () => {
  it.live("resumes the first session id on the second", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* box();
        const recorded = manifestOf("resume");
        const { handle, collector } = yield* openSession("resume", b);

        yield* handle.send({ text: recorded.turns[0]!.prompt, attachments: [], mentions: [] });
        const first = yield* collector.awaitItem((event) => event.type === "turn.completed");
        yield* handle.send({ text: recorded.turns[1]!.prompt, attachments: [], mentions: [] });
        yield* collector.awaitItem(
          (event) => event.type === "turn.completed" && event.eventId !== first.eventId,
        );
        const events = yield* collector.collected;

        // One session, two turns, the same id throughout — the second process
        // really did resume the first. The ref is re-announced when a turn
        // settles, so that its advancing `lastMessageId` reaches the thread
        // document; what must never change is the session it names.
        const announced = events.flatMap((event) =>
          event.type === "session.started"
            ? [(event.payload.sessionRef as CmdSessionRef).sessionId]
            : [],
        );
        expect(new Set(announced).size).toBe(1);
        expect(events.filter((event) => event.type === "turn.started")).toHaveLength(2);
        expect(recorded.turns[1]!.sessionId).toBe(recorded.turns[0]!.sessionId);
        const ref = (yield* handle.sessionRef()) as CmdSessionRef | null;
        expect(ref?.sessionId).toBe(recorded.turns[0]!.sessionId);
        // The second turn's thinking made it through as a reasoning row.
        expect(itemsOf(events).some((item) => item.kind === "reasoning")).toBe(true);

        yield* handle.close();
      }),
    ),
  );
});

/** The argv of every turn the replayer was spawned for, in order. */
const turnArgvs = (log: string): ReadonlyArray<ReadonlyArray<string>> =>
  NodeFS.readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { argv: ReadonlyArray<string> }).argv)
    .filter((argv) => argv[0] === "-p");

describe("a recorded fork", () => {
  /**
   * `fixtures/cmd/fork/`: a first turn, then `--session <it> --fork-session`,
   * then a plain resume. The harness named a new session on the fork's
   * `run_start`, the new transcript opens with a copy of the first session's
   * messages, and the first session's transcript kept its bytes.
   */
  it.live("forks the source session once, then resumes the fork", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* box();
        const recorded = manifestOf("fork");
        const origin = recorded.turns[0]!.sessionId;
        const forkId = recorded.turns[1]!.sessionId;
        expect(forkId).not.toBe(origin);
        // The recorder read the first transcript again after each later turn.
        expect(recorded.turns[1]!.earlierSessions).toEqual([
          { sessionId: origin, transcriptBytes: expect.any(Number) },
        ]);
        const argvLog = NodePath.join(b.home, "argv.ndjson");

        // The source thread's one turn.
        const source = yield* openSession("fork", b, { argvLog });
        yield* source.handle.send({
          text: recorded.turns[0]!.prompt,
          attachments: [],
          mentions: [],
        });
        yield* source.collector.awaitItem((event) => event.type === "turn.completed");
        const sourceRef = (yield* source.handle.sessionRef()) as CmdSessionRef;
        yield* source.handle.close();
        expect(sourceRef.sessionId).toBe(origin);
        const before = NodeFS.readFileSync(sourceRef.transcriptPath, "utf8");

        // The fork: a new thread's session over the source's ref.
        const { handle, collector } = yield* openSession("fork", b, {
          argvLog,
          sessionRef: sourceRef,
          fork: true,
        });
        yield* handle.send({ text: recorded.turns[1]!.prompt, attachments: [], mentions: [] });
        const first = yield* collector.awaitItem((event) => event.type === "turn.completed");
        yield* handle.send({ text: recorded.turns[2]!.prompt, attachments: [], mentions: [] });
        yield* collector.awaitItem(
          (event) => event.type === "turn.completed" && event.eventId !== first.eventId,
        );
        const events = yield* collector.collected;

        const [, forking, resuming] = turnArgvs(argvLog);
        expect(
          forking?.slice(forking.indexOf("--session"), forking.indexOf("--session") + 3),
        ).toEqual(["--session", origin, "--fork-session"]);
        expect(resuming).toContain(forkId);
        expect(resuming).not.toContain("--fork-session");

        // Every announcement names the fork, never the session it came from —
        // the forked transcript's header still carries the original's id.
        const announced = events.flatMap((event) =>
          event.type === "session.started"
            ? [(event.payload.sessionRef as CmdSessionRef).sessionId]
            : [],
        );
        expect(new Set(announced)).toEqual(new Set([forkId]));
        expect(((yield* handle.sessionRef()) as CmdSessionRef).sessionId).toBe(forkId);

        // The copied history is not shown again: only the fork's own answers,
        // one row each (frames and transcript both settle the same row).
        const answers = new Map(
          itemsOf(events)
            .filter((item) => item.kind === "assistant_message" && item.status === "completed")
            .map((item) => [item.itemId, item.text]),
        );
        expect([...answers.values()]).toEqual(["pineapple", "PINEAPPLE"]);

        // And the source session is exactly as it was.
        expect(NodeFS.readFileSync(sourceRef.transcriptPath, "utf8")).toBe(before);

        yield* handle.close();
      }),
    ),
  );

  it.live("refuses to fork a session that left no transcript", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* box();
        const error = yield* openSession("fork", b, {
          sessionRef: {
            sessionId: manifestOf("fork").turns[0]!.sessionId,
            transcriptPath: NodePath.join(b.home, "missing.jsonl"),
            cwd: b.workspace,
            lastMessageId: null,
          },
          fork: true,
        }).pipe(Effect.flip);
        expect(error._tag).toBe("SpawnFailed");
      }),
    ),
  );
});

describe("a recorded session resumed by a new runtime", () => {
  /**
   * What a server restart does: the second turn runs in a session opened
   * over the ref the first one left. Everything the first turn said is in
   * the transcript the second turn's drain reads, and none of it is new.
   */
  it.live("does not show the earlier turn's messages again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* box();
        const recorded = manifestOf("resume");
        const first = yield* openSession("resume", b);
        yield* first.handle.send({
          text: recorded.turns[0]!.prompt,
          attachments: [],
          mentions: [],
        });
        yield* first.collector.awaitItem((event) => event.type === "turn.completed");
        const ref = (yield* first.handle.sessionRef()) as CmdSessionRef;
        yield* first.handle.close();
        expect(ref.lastMessageId).not.toBeNull();

        const { handle, collector } = yield* openSession("resume", b, { sessionRef: ref });
        yield* handle.send({ text: recorded.turns[1]!.prompt, attachments: [], mentions: [] });
        yield* collector.awaitItem((event) => event.type === "turn.completed");
        const answers = new Map(
          itemsOf(yield* collector.collected)
            .filter((item) => item.kind === "assistant_message" && item.status === "completed")
            .map((item) => [item.itemId, item.text]),
        );
        expect([...answers.values()]).toEqual(["pineapple"]);

        yield* handle.close();
      }),
    ),
  );
});

describe("a recorded run that ran out of turns", () => {
  it.live("settles max_turns from exit 8 and the result frame", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* box();
        const { handle, collector } = yield* openSession("max-turns", b);

        yield* handle.send({ text: "do a lot", attachments: [], mentions: [] });
        const completed = yield* collector.awaitItem((event) => event.type === "turn.completed");
        expect(completed.type === "turn.completed" && completed.payload.stopReason).toBe(
          "max_turns",
        );

        yield* handle.close();
      }),
    ),
  );
});
