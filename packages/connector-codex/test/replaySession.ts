/**
 * What the replay tests share: an instance on a scenario's replay, a session
 * opened on it with a collector, and the moves every test makes — send a
 * turn and wait for it, answer the one card it opens, close — plus readers
 * for what the session emitted.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect } from "@effect/vitest";
import type { TurnInput } from "@poseidon/connector-sdk/definition";
import type { SessionHandle } from "@poseidon/connector-sdk/sessionHandle";
import { makeStreamCollector, type StreamCollector } from "@poseidon/connector-sdk/streamCollector";
import { makeConnectorInstanceId, makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import type { ApprovalDecision } from "@poseidon/contracts/enums";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import { loadStdioJsonRpcRecording } from "@poseidon/testkit/stdioJsonRpcRecording";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { makeCodexConnectorDefinition } from "../src/definition";
import { CODEX_KIND } from "../src/kind";
import { isPidGone, replay, type Replay } from "./replay";
import { testServices } from "./services";

export const SETTINGS: ThreadSettings = {
  model: "default",
  runtimeMode: "approval-required",
  interactionMode: "default",
};

export const ofType = <T extends RuntimeEvent["type"]>(
  events: ReadonlyArray<RuntimeEvent>,
  type: T,
) => events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);

/** The settled snapshot of every row of `kind`. */
export const rows = (events: ReadonlyArray<RuntimeEvent>, kind: string) =>
  ofType(events, "item.completed")
    .map((event) => event.payload.item)
    .filter((item) => item.kind === kind);

export const text = (value: string, attachments: TurnInput["attachments"] = []): TurnInput => ({
  text: value,
  attachments,
  mentions: [],
});

export interface Opened {
  readonly handle: SessionHandle;
  readonly collector: StreamCollector<RuntimeEvent>;
}

/**
 * An instance on `scenario`'s replay, and a way to open its sessions in one
 * workspace. `assertDone` proves every replayed process gone and the
 * recording played out.
 */
export const replaying = (scenario: string, settings: ThreadSettings = SETTINGS) =>
  Effect.gen(function* () {
    const replayed: Replay = replay(scenario);
    const workspace = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-session-")),
      scenario,
    );
    NodeFS.mkdirSync(workspace);
    const instance = yield* makeCodexConnectorDefinition().createInstance({
      instanceId: makeConnectorInstanceId(),
      config: { binaryPath: replayed.binaryPath },
      services: yield* testServices(),
    });
    const input = {
      threadId: makeThreadId(),
      projectId: makeProjectId(),
      workspaceRoot: workspace,
      settings,
    };
    const open = (sessionRef?: unknown): Effect.Effect<Opened, unknown, Scope.Scope> =>
      Effect.gen(function* () {
        const handle = yield* sessionRef === undefined
          ? instance.startSession(input)
          : instance.resumeSession({ ...input, sessionRef });
        return { handle, collector: yield* makeStreamCollector(handle.events) };
      });
    const assertDone = () => {
      replayed.assertPlayedOut();
      expect(replayed.pids().length).toBeGreaterThan(0);
      expect(replayed.pids().every(isPidGone)).toBe(true);
    };
    return { open, assertDone, workspace, replayed };
  });

/** Sends one turn and waits for its completion. */
export const turn = (opened: Opened, input: TurnInput) =>
  Effect.gen(function* () {
    const before = new Set(yield* opened.collector.collected);
    yield* opened.handle.send(input);
    return yield* opened.collector.awaitItem(
      (event) => !before.has(event) && event.type === "turn.completed",
    );
  });

/** Closes the session; answers everything it emitted. */
export const closed = (opened: Opened) =>
  Effect.gen(function* () {
    yield* opened.handle.close();
    yield* opened.collector.awaitDone;
    return yield* opened.collector.collected;
  });

export const prompts = (scenario: string) =>
  loadStdioJsonRpcRecording(CODEX_KIND, scenario).manifest.prompts;

export const stopReasons = (events: ReadonlyArray<RuntimeEvent>) =>
  ofType(events, "turn.completed").map((event) => event.payload.stopReason);

/**
 * Sends `input` and answers the one card it opens with `decision`; answers
 * the card's request and the turn's completion.
 */
export const turnWithCard = (opened: Opened, input: TurnInput, decision: ApprovalDecision) =>
  Effect.gen(function* () {
    const before = new Set(yield* opened.collector.collected);
    yield* opened.handle.send(input);
    const card = yield* opened.collector.awaitItem(
      (event) => !before.has(event) && event.type === "request.opened",
    );
    if (card.type !== "request.opened") throw new Error("not a card");
    yield* opened.handle.respondToRequest(card.payload.request.requestId, decision);
    const completion = yield* opened.collector.awaitItem(
      (event) => !before.has(event) && event.type === "turn.completed",
    );
    return { request: card.payload.request, completion };
  });
