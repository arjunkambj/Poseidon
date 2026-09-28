/**
 * The Codex tool gate's own logic: how the ladder's and the card's answers
 * read to the CLI, a withdrawn request resolving its card, Stop cancelling,
 * failing closed, and the turn's check for calls that ran ungated. The ladder
 * here answers what each test says; the real ladder is the server's.
 */

import { makeApprovalGate, type ApprovalGateEvent } from "@poseidon/connector-sdk/approvalGate";
import type { ConnectorPermissions } from "@poseidon/connector-sdk/definition";
import type { ApprovalDecision } from "@poseidon/contracts/enums";
import { makeThreadId } from "@poseidon/contracts/ids";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import type { ApprovalRequest } from "@poseidon/contracts/runtime";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { COMMAND_APPROVAL, FILE_CHANGE_APPROVAL } from "./approvals";
import type { RpcOutcome, RpcServerRequest } from "./rpc";
import {
  answerFor,
  combineAnswers,
  isKnownSafeCommand,
  makeCodexToolGate,
  ungatedWarning,
} from "./toolGate";

const threadId = makeThreadId();

const SETTINGS: ThreadSettings = {
  model: "default",
  runtimeMode: "approval-required",
  interactionMode: "default",
};

const setup = (decide: ConnectorPermissions["decide"]) =>
  Effect.gen(function* () {
    const events: Array<ApprovalGateEvent> = [];
    const asked: Array<{ request: ApprovalRequest; runtimeMode: string }> = [];
    const gate = yield* makeApprovalGate({
      permissions: {
        decide: (input) => {
          asked.push({ request: input.request, runtimeMode: input.runtimeMode });
          return decide(input);
        },
      },
      emit: (event) => Effect.sync(() => void events.push(event)),
    });
    let settings = SETTINGS;
    const toolGate = makeCodexToolGate({ threadId, gate, settings: () => settings });
    const opened = () =>
      events.flatMap((event) => (event.type === "request.opened" ? [event.requestId] : []));
    const resolved = () =>
      events.flatMap((event) =>
        event.type === "request.resolved" ? [[event.requestId, event.payload.decision]] : [],
      );
    return {
      gate,
      toolGate,
      events,
      asked,
      opened,
      resolved,
      setSettings: (next: ThreadSettings) => {
        settings = next;
      },
    };
  });

const command = (id: number, itemId = `exec-${id}`): RpcServerRequest => ({
  id,
  method: COMMAND_APPROVAL,
  params: { kind: "command", itemId, command: "/bin/zsh -lc 'touch x'", cwd: "/r" },
});

const fileChange = (id: number, itemId: string): RpcServerRequest => ({
  id,
  method: FILE_CHANGE_APPROVAL,
  params: { itemId, reason: null, grantRoot: null },
});

const started = (item: Readonly<Record<string, unknown>>) => ({
  method: "item/started",
  params: { item },
});
const completed = (item: Readonly<Record<string, unknown>>) => ({
  method: "item/completed",
  params: { item },
});

const decisionOf = (outcome: RpcOutcome | null): unknown =>
  outcome !== null && "result" in outcome
    ? (outcome.result as { decision?: unknown }).decision
    : outcome;

/** Answers the first card the gate opens with `decision`, once it is open. */
const answerCard = (
  context: Effect.Success<ReturnType<typeof setup>>,
  decision: ApprovalDecision,
  index = 0,
) =>
  Effect.gen(function* () {
    while (context.opened().length <= index) yield* Effect.yieldNow;
    yield* context.gate.respond(context.opened()[index]!, decision);
  });

describe("the decision table", () => {
  it("reads each verdict as the CLI's answer", () => {
    expect(answerFor({ allowed: true, via: "rules" })).toBe("accept");
    expect(answerFor({ allowed: false, via: "rules" })).toBe("decline");
    expect(answerFor({ allowed: true, decision: "allow-once", via: "user" })).toBe("accept");
    expect(answerFor({ allowed: true, decision: "allow-always", via: "user" })).toBe("accept");
    // The session is Poseidon's rule: the CLI keeps asking, and the ladder answers.
    expect(answerFor({ allowed: true, decision: "allow-session", via: "user" })).toBe("accept");
    expect(answerFor({ allowed: false, decision: "deny", via: "user" })).toBe("decline");
  });

  it("combines a change's parts: any refusal declines", () => {
    expect(combineAnswers([])).toBe("decline");
    expect(combineAnswers(["accept", "decline"])).toBe("decline");
    expect(combineAnswers(["accept", "accept"])).toBe("accept");
  });

  it.effect("answers the ladder's allow and deny at once, with no card", () =>
    Effect.gen(function* () {
      const allow = yield* setup(() => Effect.succeed("allow"));
      expect(decisionOf(yield* allow.toolGate.answer(command(0)))).toBe("accept");
      const deny = yield* setup(() => Effect.succeed("deny"));
      expect(decisionOf(yield* deny.toolGate.answer(command(0)))).toBe("decline");
      expect([...allow.events, ...deny.events]).toEqual([]);
    }),
  );

  it.effect.each([
    ["allow-once", "accept"],
    ["allow-always", "accept"],
    ["allow-session", "accept"],
    ["deny", "decline"],
  ] as const)("answers a card's %s as %s", ([decision, answer]) =>
    Effect.gen(function* () {
      const context = yield* setup(() => Effect.succeed("prompt"));
      const fiber = yield* Effect.forkChild(context.toolGate.answer(command(7)));
      yield* answerCard(context, decision);
      expect(decisionOf(yield* Fiber.join(fiber))).toBe(answer);
      expect(context.resolved()).toEqual([[context.opened()[0], decision]]);
    }),
  );

  it.effect("asks the ladder with the thread's modes as they are when the request comes", () =>
    Effect.gen(function* () {
      const context = yield* setup(() => Effect.succeed("allow"));
      context.setSettings({ ...SETTINGS, runtimeMode: "full-access" });
      yield* context.toolGate.answer(command(0));
      expect(context.asked.map((each) => each.runtimeMode)).toEqual(["full-access"]);
      expect(context.asked[0]!.request.input).toEqual({ command: "touch x", cwd: "/r" });
    }),
  );
});

describe("a file change", () => {
  it.effect("opens one card per path, and stops at the first refusal", () =>
    Effect.gen(function* () {
      const context = yield* setup(() => Effect.succeed("prompt"));
      yield* context.toolGate.observe(
        started({
          type: "fileChange",
          id: "f1",
          changes: [
            { path: "/r/a.ts", kind: { type: "add" } },
            { path: "/r/.env", kind: { type: "add" } },
            { path: "/r/c.ts", kind: { type: "add" } },
          ],
        }),
      );
      const fiber = yield* Effect.forkChild(context.toolGate.answer(fileChange(0, "f1")));
      yield* answerCard(context, "allow-session", 0);
      yield* answerCard(context, "deny", 1);
      expect(decisionOf(yield* Fiber.join(fiber))).toBe("decline");
      expect(context.asked.map((each) => each.request.input)).toEqual([
        { file_path: "/r/a.ts" },
        { file_path: "/r/.env" },
      ]);
    }),
  );

  it.effect("is accepted, never for the CLI's session, when every path was allowed for it", () =>
    Effect.gen(function* () {
      const context = yield* setup(() => Effect.succeed("prompt"));
      yield* context.toolGate.observe(
        started({
          type: "fileChange",
          id: "f1",
          changes: [
            { path: "/r/a.ts", kind: { type: "add" } },
            { path: "/r/b.ts", kind: { type: "add" } },
          ],
        }),
      );
      const fiber = yield* Effect.forkChild(context.toolGate.answer(fileChange(0, "f1")));
      yield* answerCard(context, "allow-session", 0);
      yield* answerCard(context, "allow-session", 1);
      expect(decisionOf(yield* Fiber.join(fiber))).toBe("accept");
    }),
  );
});

describe("a request the CLI withdraws", () => {
  it.effect("resolves its card deny, once, and answers nothing", () =>
    Effect.gen(function* () {
      const context = yield* setup(() => Effect.succeed("prompt"));
      const fiber = yield* Effect.forkChild(context.toolGate.answer(command(4)));
      while (context.opened().length === 0) yield* Effect.yieldNow;
      yield* context.toolGate.observe({
        method: "serverRequest/resolved",
        params: { threadId: "t", requestId: 4 },
      });
      expect(yield* Fiber.join(fiber)).toBeNull();
      expect(context.resolved()).toEqual([[context.opened()[0], "deny"]]);
    }),
  );

  it.effect("resolves every card still open when the CLI's turn completes", () =>
    Effect.gen(function* () {
      const context = yield* setup(() => Effect.succeed("prompt"));
      const first = yield* Effect.forkChild(context.toolGate.answer(command(1)));
      const second = yield* Effect.forkChild(context.toolGate.answer(command(2)));
      while (context.opened().length < 2) yield* Effect.yieldNow;
      yield* context.toolGate.observe({ method: "turn/completed", params: { turn: {} } });
      expect(yield* Fiber.join(first)).toBeNull();
      expect(yield* Fiber.join(second)).toBeNull();
      expect(context.resolved().map(([, decision]) => decision)).toEqual(["deny", "deny"]);
    }),
  );

  it.effect("leaves a request it already answered alone", () =>
    Effect.gen(function* () {
      const context = yield* setup(() => Effect.succeed("allow"));
      expect(decisionOf(yield* context.toolGate.answer(command(4)))).toBe("accept");
      yield* context.toolGate.observe({
        method: "serverRequest/resolved",
        params: { threadId: "t", requestId: 4 },
      });
      expect(context.events).toEqual([]);
    }),
  );
});

describe("Stop and close", () => {
  it.effect("resolve every open card once, and cancel its request", () =>
    Effect.gen(function* () {
      const context = yield* setup(() => Effect.succeed("prompt"));
      const fiber = yield* Effect.forkChild(context.toolGate.answer(command(3)));
      while (context.opened().length === 0) yield* Effect.yieldNow;
      yield* context.toolGate.cancelAll;
      expect(decisionOf(yield* Fiber.join(fiber))).toBe("cancel");
      expect(context.resolved()).toEqual([[context.opened()[0], "deny"]]);
      // A second Stop finds nothing open.
      yield* context.toolGate.cancelAll;
      expect(context.resolved()).toHaveLength(1);
    }),
  );

  it.effect("a new turn answers a refusal decline again, not cancel", () =>
    Effect.gen(function* () {
      const context = yield* setup(() => Effect.succeed("deny"));
      yield* context.toolGate.cancelAll;
      yield* context.toolGate.turnStarted;
      expect(decisionOf(yield* context.toolGate.answer(command(0)))).toBe("decline");
    }),
  );
});

describe("failing closed", () => {
  it.effect("a ladder that dies opens a card rather than allowing", () =>
    Effect.gen(function* () {
      const context = yield* setup(() => Effect.die(new Error("ladder down")));
      const fiber = yield* Effect.forkChild(context.toolGate.answer(command(0)));
      yield* answerCard(context, "deny");
      expect(decisionOf(yield* Fiber.join(fiber))).toBe("decline");
    }),
  );

  it.effect("anything else that goes wrong declines", () =>
    Effect.gen(function* () {
      const gate = yield* makeApprovalGate({
        permissions: { decide: () => Effect.succeed("allow") },
        emit: () => Effect.void,
      });
      const toolGate = makeCodexToolGate({
        threadId,
        gate,
        settings: () => {
          throw new Error("settings unreadable");
        },
      });
      expect(decisionOf(yield* toolGate.answer(command(0)))).toBe("decline");
    }),
  );
});

describe("calls that ran without the gate", () => {
  it("knows the reads the CLI may run unasked, wrapped or not", () => {
    for (const safe of ["/bin/zsh -lc 'cat .env'", "ls -la", "git status", "rg foo | head"]) {
      expect(isKnownSafeCommand(safe)).toBe(true);
    }
    for (const unsafe of ["/bin/zsh -lc 'touch x'", "git push", "ls && rm -rf x", "git"]) {
      expect(isKnownSafeCommand(unsafe)).toBe(false);
    }
  });

  it.effect("warns for a file change or an unsafe command that ran with no request", () =>
    Effect.gen(function* () {
      const context = yield* setup(() => Effect.succeed("allow"));
      yield* context.toolGate.turnStarted;
      const change = { type: "fileChange", id: "f1", changes: [{ path: "/r/a" }] };
      yield* context.toolGate.observe(completed({ ...change, status: "completed" }));
      yield* context.toolGate.observe(
        completed({
          type: "commandExecution",
          id: "c1",
          command: "/bin/zsh -lc 'touch x'",
          source: "agent",
          status: "completed",
          exitCode: 0,
        }),
      );
      expect(context.toolGate.ungated()).toBe(ungatedWarning(2));
    }),
  );

  it.effect("stays quiet for gated items, declined ones, safe reads and the user's shell", () =>
    Effect.gen(function* () {
      const context = yield* setup(() => Effect.succeed("allow"));
      yield* context.toolGate.turnStarted;
      yield* context.toolGate.answer(command(0, "c1"));
      const run = (item: Readonly<Record<string, unknown>>) =>
        context.toolGate.observe(
          completed({ type: "commandExecution", status: "completed", exitCode: 0, ...item }),
        );
      yield* run({ id: "c1", command: "touch x", source: "agent" });
      yield* run({
        id: "c2",
        command: "touch y",
        source: "agent",
        status: "declined",
        exitCode: null,
      });
      yield* context.toolGate.observe(
        completed({ type: "fileChange", id: "f9", status: "failed", changes: [{ path: "/r/a" }] }),
      );
      yield* run({ id: "c3", command: "/bin/zsh -lc 'cat .env'", source: "agent" });
      yield* run({ id: "c4", command: "touch z", source: "userShell" });
      expect(context.toolGate.ungated()).toBeUndefined();
    }),
  );

  it.effect("warns for a file the turn's diff wrote with no file-change item for it", () =>
    Effect.gen(function* () {
      // A patch applied from inside the CLI's `exec` tool: no request, no item.
      const context = yield* setup(() => Effect.succeed("allow"));
      yield* context.toolGate.turnStarted;
      yield* context.toolGate.observe({
        method: "turn/diff/updated",
        params: { diff: "diff --git a/x.txt b/x.txt\n--- /dev/null\n+++ b/x.txt\n" },
      });
      expect(context.toolGate.ungated()).toBe(ungatedWarning(0, 1));
      expect(ungatedWarning(0, 1)).toMatch(/^1 file\(s\) were written without reaching/);
    }),
  );

  it.effect("counts afresh each turn", () =>
    Effect.gen(function* () {
      const context = yield* setup(() => Effect.succeed("allow"));
      const change = { type: "fileChange", id: "f1", changes: [{ path: "/r/a" }] };
      yield* context.toolGate.observe(completed({ ...change, status: "completed" }));
      expect(context.toolGate.ungated()).toBeDefined();
      yield* context.toolGate.turnStarted;
      expect(context.toolGate.ungated()).toBeUndefined();
    }),
  );
});

describe("closing", () => {
  it.effect("resolves every open card deny, once, and sends nothing", () =>
    Effect.gen(function* () {
      const context = yield* setup(() => Effect.succeed("prompt"));
      const fiber = yield* Effect.forkChild(context.toolGate.answer(command(5)));
      while (context.opened().length === 0) yield* Effect.yieldNow;
      yield* context.toolGate.closeAll;
      expect(yield* Fiber.join(fiber)).toBeNull();
      expect(context.resolved()).toEqual([[context.opened()[0], "deny"]]);
      yield* context.toolGate.closeAll;
      expect(context.resolved()).toHaveLength(1);
    }),
  );
});

describe("a withdrawal that comes before the answer's fiber runs", () => {
  it.effect("still reaches the request, which answers nothing", () =>
    Effect.gen(function* () {
      const context = yield* setup(() => Effect.succeed("prompt"));
      const pending = context.toolGate.answer(command(9));
      yield* context.toolGate.observe({
        method: "serverRequest/resolved",
        params: { threadId: "t", requestId: 9 },
      });
      expect(yield* pending).toBeNull();
      expect(context.resolved()).toEqual([[context.opened()[0], "deny"]]);
    }),
  );
});
