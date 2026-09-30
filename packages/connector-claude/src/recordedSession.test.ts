/**
 * `makeClaudeSession` against the end-to-end recordings: each scenario's own
 * session launch, replayed under the real SDK with no server around it.
 *
 * Where `session.test.ts` covers a turn the CLI refuses, these are turns the
 * model worked through. `plain-reply`: streamed text settling as one assistant
 * row, usage with a cost, the context window, and a turn that ended
 * `end_turn`. The approval scenarios: the tool rows, the cards the gate opened
 * and how each was answered — every card resolved, no call run past the gate.
 * `plan-accept`: a plan turn whose ExitPlanMode becomes the plan card and a
 * turn that stops there, then the implementation turn out of plan mode.
 * `question`: AskUserQuestion as a question card, answered with its first
 * option, and the answer reaching the model. `subagent`: a Task delegation,
 * its task lifecycle, and the subagent's rows nested under the task's row.
 * `steering`: a message steered in while the turn's shell command ran, and
 * one turn that answers both.
 * The recordings are made through the real server; only their session launch
 * is played here — the probe's launches are a different class and are never
 * asked for. Each was made with a signed-in CLI; a scenario whose recording
 * is missing is skipped under a title that says so.
 *
 * The ladder here stands in for the server's, as far as these recordings
 * need it: a plan turn refuses every non-read, a sensitive path (`.env`,
 * `.git`) asks, a read passes, full access passes the rest, and anything else
 * asks. The replay checks every hook answer and every card answer against
 * the recorded one, so a ladder that answered differently from the server's
 * would fail the replay, not pass it quietly.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { ConnectorPermissions } from "@poseidon/connector-sdk/definition";
import { makeStreamCollector } from "@poseidon/connector-sdk/streamCollector";
import type { SessionHandle } from "@poseidon/connector-sdk/sessionHandle";
import type { StreamCollector } from "@poseidon/connector-sdk/streamCollector";
import type { ApprovalDecision, RuntimeMode } from "@poseidon/contracts/enums";
import { makeConnectorInstanceId, makeThreadId, type RequestId } from "@poseidon/contracts/ids";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import { recordingNames } from "@poseidon/testkit/recording";
import { loadSdkStreamRecording } from "@poseidon/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { isPidGone, replay } from "../test/replay";
import { testServices } from "../test/services";
import { childEnv } from "./env";
import { CLAUDE_KIND } from "./kind";
import { makeClaudeSession } from "./session";

const recorded = (scenario: string): boolean => recordingNames(CLAUDE_KIND).includes(scenario);

/** A scenario's suite; skipped, and titled so, while its recording is missing. */
const describeRecorded = (scenario: string, title: string, body: () => void): void => {
  if (recorded(scenario)) {
    describe(title, body);
    return;
  }
  describe.skip(
    `${title} — has no recording yet: record fixtures/claude/${scenario}/ with a signed-in CLI`,
    body,
  );
};

const ofType = <T extends RuntimeEvent["type"]>(events: ReadonlyArray<RuntimeEvent>, type: T) =>
  events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);

/** The server's ladder, as far as these recordings go (see the header). */
const ladder: ConnectorPermissions["decide"] = ({ request, runtimeMode, interactionMode }) =>
  Effect.succeed(
    interactionMode === "plan" && request.kind !== "file_read"
      ? "deny"
      : /\.(env|git)\b/.test(JSON.stringify(request.input ?? {}))
        ? "prompt"
        : request.kind === "file_read" || runtimeMode === "full-access"
          ? "allow"
          : "prompt",
  );

interface Replaying {
  readonly handle: SessionHandle;
  readonly collector: StreamCollector<RuntimeEvent>;
  readonly prompts: ReadonlyArray<string>;
}

/**
 * Replays one scenario's session under `settings`: `drive` sends its turns,
 * while every approval card is answered with `answer`. Answers with every
 * event the session emitted, after proving the session closed, its processes
 * gone and the recording played out.
 */
const replaySession = (
  scenario: string,
  settings: Omit<ThreadSettings, "model">,
  answer: ApprovalDecision,
  drive: (replaying: Replaying) => Effect.Effect<void, unknown, Scope.Scope>,
): Effect.Effect<ReadonlyArray<RuntimeEvent>, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const recording = loadSdkStreamRecording(CLAUDE_KIND, scenario);
    const replayed = replay(scenario);
    const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-session-"));
    const handle = yield* makeClaudeSession({
      instanceId: makeConnectorInstanceId(),
      threadId: makeThreadId(),
      workspaceRoot: workspace,
      binary: { command: replayed.binaryPath, display: replayed.binaryPath },
      env: childEnv(process.env, {}),
      loginCommand: `${replayed.binaryPath} auth login`,
      services: yield* testServices({ decide: ladder }),
      settings: { model: "default", ...settings },
      limits: { maxTurns: 4, maxBudgetUsd: 0.5 },
    });
    const collector = yield* makeStreamCollector(handle.events);

    // The user at the card: every request the turn opens, answered the same.
    const answered = new Set<RequestId>();
    const answerAll: Effect.Effect<void, unknown> = collector
      .awaitItem(
        (event) =>
          event.type === "request.opened" && !answered.has(event.payload.request.requestId),
      )
      .pipe(
        Effect.flatMap((event) => {
          if (event.type !== "request.opened") return Effect.void;
          answered.add(event.payload.request.requestId);
          return handle.respondToRequest(event.payload.request.requestId, answer);
        }),
        Effect.andThen(Effect.suspend(() => answerAll)),
      );
    yield* Effect.forkScoped(Effect.ignore(answerAll));

    yield* drive({ handle, collector, prompts: recording.manifest.prompts });
    yield* handle.close();
    yield* collector.awaitDone;
    expect(replayed.pids().every(isPidGone)).toBe(true);
    replayed.assertPlayedOut();
    return yield* collector.collected;
  });

/** One prompt, until its turn completes. */
const replayTurn = (scenario: string, runtimeMode: RuntimeMode, answer: ApprovalDecision) =>
  replaySession(
    scenario,
    { runtimeMode, interactionMode: "default" },
    answer,
    ({ handle, collector, prompts }) =>
      Effect.gen(function* () {
        yield* handle.send({ text: prompts[0]!, attachments: [], mentions: [] });
        yield* collector.awaitItem((event) => event.type === "turn.completed");
      }),
  );

/** What every gated turn owes: no card left open, nothing unmapped, nothing ungated. */
const expectGated = (events: ReadonlyArray<RuntimeEvent>) => {
  const opened = ofType(events, "request.opened").map((event) => event.payload.request.requestId);
  const resolved = new Set(ofType(events, "request.resolved").map((e) => e.payload.requestId));
  expect(opened.length).toBeGreaterThan(0);
  expect(opened.filter((id) => !resolved.has(id))).toEqual([]);
  expect(ofType(events, "event.unmapped")).toEqual([]);
  expect(ofType(events, "session.warning")).toEqual([]);
};

/** The settled snapshot of every row of `kind`. */
const rows = (events: ReadonlyArray<RuntimeEvent>, kind: string) =>
  ofType(events, "item.completed")
    .map((event) => event.payload.item)
    .filter((item) => item.kind === kind);

describeRecorded("plain-reply", "a Claude Code session replaying claude/plain-reply", () => {
  it.live("answers the turn with streamed text, usage and end_turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* replayTurn("plain-reply", "approval-required", "deny");
        const completed = ofType(events, "turn.completed")[0];
        expect(completed?.payload.stopReason).toBe("end_turn");
        expect(ofType(events, "runtime.error")).toEqual([]);
        expect(ofType(events, "event.unmapped")).toEqual([]);

        // The answer streamed as deltas onto one row that the snapshot settled.
        const deltas = ofType(events, "content.delta");
        expect(deltas.length).toBeGreaterThan(0);
        const settled = rows(events, "assistant_message");
        expect(settled).toHaveLength(1);
        expect((settled[0]!.text ?? "").toLowerCase()).toContain("pong");
        expect(new Set(deltas.map((event) => event.payload.itemId))).toEqual(
          new Set([settled[0]!.itemId]),
        );

        const usage = ofType(events, "usage.updated")[0]?.payload;
        expect(usage?.output).toBeGreaterThan(0);
        expect(usage?.costUsd).toBeGreaterThan(0);
        expect(ofType(events, "context.updated").length).toBeGreaterThan(0);
      }),
    ),
  );
});

describeRecorded("edit-approval", "a Claude Code session replaying claude/edit-approval", () => {
  it.live("asks before the write, and settles the write as a file change once allowed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* replayTurn("edit-approval", "approval-required", "allow-once");
        expectGated(events);
        const first = ofType(events, "request.opened")[0]!.payload.request;
        expect(first.kind).toBe("file_write");
        expect(first.patternSuggestion).toMatch(/^Edit\(.*hello\.txt\)$/);

        const write = rows(events, "file_change").find((item) =>
          item.fileChange?.path.endsWith("hello.txt"),
        );
        expect(write?.status).toBe("completed");
        expect(write?.fileChange?.diff).toContain("+hi");
        // The row settled only after the card was answered.
        const resolvedAt = events.findIndex((event) => event.type === "request.resolved");
        const settledAt = events.findIndex(
          (event) => event.type === "item.completed" && event.payload.item.itemId === write?.itemId,
        );
        expect(settledAt).toBeGreaterThan(resolvedAt);
      }),
    ),
  );
});

describeRecorded("deny", "a Claude Code session replaying claude/deny", () => {
  it.live("fails the denied command's row and tells the model it was refused", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* replayTurn("deny", "approval-required", "deny");
        expectGated(events);
        expect(ofType(events, "request.opened")[0]!.payload.request).toMatchObject({
          kind: "command",
          toolName: "Bash",
          patternSuggestion: "Shell(touch *)",
        });
        const shell = rows(events, "command_execution");
        expect(shell.length).toBeGreaterThan(0);
        expect(shell.every((item) => item.status === "failed")).toBe(true);
      }),
    ),
  );
});

describeRecorded(
  "sensitive-full-access",
  "a Claude Code session replaying claude/sensitive-full-access",
  () => {
    it.live("opens a card for .env under full access", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* replayTurn("sensitive-full-access", "full-access", "deny");
          expectGated(events);
          const first = ofType(events, "request.opened")[0]!.payload.request;
          expect(JSON.stringify(first.input)).toContain(".env");
          expect(JSON.stringify(events)).not.toContain("not-a-real-key");
        }),
      ),
    );
  },
);

describeRecorded("plan-accept", "a Claude Code session replaying claude/plan-accept", () => {
  it.live("proposes the plan, stops the plan turn, and implements it out of plan mode", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* replaySession(
          "plan-accept",
          { runtimeMode: "approval-required", interactionMode: "plan" },
          "allow-once",
          ({ handle, collector, prompts }) =>
            Effect.gen(function* () {
              yield* handle.send({ text: prompts[0]!, attachments: [], mentions: [] });
              const proposed = yield* collector.awaitItem(
                (event) => event.type === "turn.plan.proposed",
              );
              const planTurn = yield* collector.awaitItem(
                (event) => event.type === "turn.completed",
              );
              if (proposed.type !== "turn.plan.proposed") return;
              // Accepting, as the server carries it out: out of plan mode,
              // then the implementation turn naming the plan file.
              yield* handle.respondToPlan(proposed.payload.turnId, "accept");
              yield* handle.updateSettings({ interactionMode: "default" });
              const path = proposed.payload.planPath;
              yield* handle.send({
                text:
                  path === undefined
                    ? "Implement the approved plan."
                    : `Implement the approved plan at ${path}`,
                attachments: [],
                mentions: [],
              });
              yield* collector.awaitItem(
                (event) =>
                  event.type === "turn.completed" &&
                  planTurn.type === "turn.completed" &&
                  event.payload.turnId !== planTurn.payload.turnId,
              );
            }),
        );
        expect(ofType(events, "event.unmapped")).toEqual([]);
        const proposed = ofType(events, "turn.plan.proposed");
        expect(proposed).toHaveLength(1);
        expect(proposed[0]!.payload.planMarkdown.length).toBeGreaterThan(0);
        // The plan turn ended cleanly on the CLI's result after the refusal.
        const [planTurn, implementation] = ofType(events, "turn.completed");
        expect(planTurn?.payload.stopReason).toBe("end_turn");
        expect(planTurn?.payload.turnId).toBe(proposed[0]!.payload.turnId);
        const planRows = rows(events, "plan");
        expect(planRows.some((item) => item.text === proposed[0]!.payload.planMarkdown)).toBe(true);
        // The implementation turn wrote the change.
        expect(implementation?.payload.stopReason).toBe("end_turn");
        const writes = rows(events, "file_change").filter((item) => item.status === "completed");
        expect(writes.length).toBeGreaterThan(0);
      }),
    ),
  );
});

describeRecorded("question", "a Claude Code session replaying claude/question", () => {
  it.live("asks through a question card and hands the answer back to the model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let chosen = "";
        const events = yield* replaySession(
          "question",
          { runtimeMode: "approval-required", interactionMode: "default" },
          "allow-once",
          ({ handle, collector, prompts }) =>
            Effect.gen(function* () {
              yield* handle.send({ text: prompts[0]!, attachments: [], mentions: [] });
              const asked = yield* collector.awaitItem(
                (event) => event.type === "user-input.requested",
              );
              if (asked.type !== "user-input.requested") return;
              const question = asked.payload.questions[0]!;
              chosen = question.options[0]!.label;
              yield* handle.respondToUserInput(asked.payload.requestId, [
                { questionId: question.questionId, optionIds: [question.options[0]!.optionId] },
              ]);
              yield* collector.awaitItem((event) => event.type === "turn.completed");
            }),
        );
        expect(ofType(events, "event.unmapped")).toEqual([]);
        const requested = ofType(events, "user-input.requested");
        expect(requested).toHaveLength(1);
        const question = requested[0]!.payload.questions[0]!;
        expect(question.options.length).toBeGreaterThan(1);
        expect(question.freeform).toBe(true);
        expect(ofType(events, "user-input.resolved").map((e) => e.payload.requestId)).toEqual([
          requested[0]!.payload.requestId,
        ]);
        // The answer reached the model: the question's row carries it, and
        // the write that follows holds the chosen colour.
        const asked = rows(events, "tool_call").find(
          (item) => item.tool?.name === "AskUserQuestion",
        );
        expect(asked?.status).toBe("completed");
        expect(asked?.tool?.output ?? "").toContain(chosen);
        const write = rows(events, "file_change").find((item) =>
          item.fileChange?.path.endsWith("colour.txt"),
        );
        expect((write?.fileChange?.diff ?? "").toLowerCase()).toContain(chosen.toLowerCase());
      }),
    ),
  );
});

describeRecorded("subagent", "a Claude Code session replaying claude/subagent", () => {
  it.live("opens a task for the delegation and nests the subagent's rows under it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The subagent's listing names `.git`, so even full access asks; the
        // recording allowed it once.
        const events = yield* replayTurn("subagent", "full-access", "allow-once");
        expect(ofType(events, "event.unmapped")).toEqual([]);
        expect(ofType(events, "session.warning")).toEqual([]);

        // The Task call's row is the task: announced with its id, and settled.
        const task = rows(events, "task")[0];
        expect(task?.status).toBe("completed");
        const started = ofType(events, "task.started");
        expect(started.map((event) => event.payload.taskId)).toContain(task!.itemId);
        const completed = ofType(events, "task.completed").filter(
          (event) => event.payload.taskId === task!.itemId,
        );
        expect(completed.map((event) => event.payload.status)).toEqual(["completed"]);

        // What the subagent did carries the task as its parent, from its first
        // snapshot to its last; the main loop's own rows do not.
        const nested = ofType(events, "item.completed")
          .map((event) => event.payload.item)
          .filter((item) => item.parentItemId === task!.itemId);
        expect(nested.length).toBeGreaterThan(0);
        const answer = rows(events, "assistant_message").at(-1);
        expect(answer?.parentItemId).toBeUndefined();
      }),
    ),
  );
});

describeRecorded("steering", "a Claude Code session replaying claude/steering", () => {
  it.live("takes a steered message into the running turn and answers both in it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* replaySession(
          "steering",
          { runtimeMode: "full-access", interactionMode: "default" },
          "deny",
          ({ handle, collector, prompts }) =>
            Effect.gen(function* () {
              yield* handle.send({ text: prompts[0]!, attachments: [], mentions: [] });
              // The shell command has started: the turn is certainly running.
              yield* collector.awaitItem(
                (event) =>
                  event.type === "item.started" && event.payload.item.kind === "command_execution",
              );
              yield* handle.steer!({ text: prompts[1]!, attachments: [], mentions: [] });
              yield* collector.awaitItem((event) => event.type === "turn.completed");
            }),
        );
        expect(ofType(events, "event.unmapped")).toEqual([]);
        expect(ofType(events, "session.warning")).toEqual([]);
        // One turn, which ran the command and ended cleanly after both answers.
        expect(ofType(events, "turn.started")).toHaveLength(1);
        const completed = ofType(events, "turn.completed");
        expect(completed).toHaveLength(1);
        expect(completed[0]!.payload.stopReason).toBe("end_turn");
        expect(rows(events, "command_execution")[0]?.status).toBe("completed");
        // The answer honours the steer.
        const answer = rows(events, "assistant_message").at(-1);
        expect((answer?.text ?? "").toLowerCase()).toContain("banana");
      }),
    ),
  );
});
