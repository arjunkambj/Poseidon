/**
 * What the session recorders share: one scenario through the testkit's stdio
 * tee in front of the operator's real `codex`, in a throwaway git repo under
 * `/tmp/poseidon-codex/scratch`, finalised into `fixtures/codex/<scenario>/`;
 * and the few moves every scenario makes — send a turn and wait for it,
 * answer every card, close.
 */

import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect } from "@effect/vitest";
import type { ConnectorEndpoint, TurnInput } from "@poseidon/connector-sdk/definition";
import type { SessionHandle } from "@poseidon/connector-sdk/sessionHandle";
import { makeStreamCollector, type StreamCollector } from "@poseidon/connector-sdk/streamCollector";
import {
  makeConnectorInstanceId,
  makeProjectId,
  makeThreadId,
  type ThreadId,
} from "@poseidon/contracts/ids";
import type { ApprovalDecision } from "@poseidon/contracts/enums";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { makeCodexConnectorDefinition } from "../src/definition";
import { parseVersion } from "../src/probe";
import { finalise, realCodex, teeInFront, threadModelOf } from "./record";
import { testServices } from "./services";

const SCRATCH = "/tmp/poseidon-codex/scratch";

export const SETTINGS: ThreadSettings = {
  model: "default",
  runtimeMode: "approval-required",
  interactionMode: "default",
};

/** A fresh git repo for one scenario. */
export const scratchRepo = (scenario: string): string => {
  const repo = NodePath.join(SCRATCH, scenario);
  NodeFS.rmSync(repo, { recursive: true, force: true });
  NodeFS.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "--quiet", repo], { stdio: "ignore" });
  NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "# scratch\n", "utf8");
  return repo;
};

export interface Recording {
  readonly handle: SessionHandle;
  readonly collector: StreamCollector<RuntimeEvent>;
}

export interface Session {
  readonly threadId: ThreadId;
  /** Opens a session on the tee, fresh, resuming `sessionRef`, or forking it. */
  readonly open: (
    sessionRef?: unknown,
    fork?: boolean,
  ) => Effect.Effect<Recording, unknown, Scope.Scope>;
  readonly repo: string;
}

/**
 * One scenario through the tee: `drive` opens sessions and sends turns, then
 * the capture is finalised into `fixtures/codex/<scenario>/`.
 */
export const recordScenario = (
  spec: {
    readonly scenario: string;
    readonly description: string;
    readonly prompts: ReadonlyArray<string>;
    /** What the manifest names as the model, when not the thread's default alone. */
    readonly model?: (defaultModel: string) => string;
    /** The thread's settings, when not the approval-required default. */
    readonly settings?: ThreadSettings;
    /** Puts the scenario's files into the scratch repo before the session opens. */
    readonly prepare?: (repo: string) => void;
    /** An MCP endpoint that answers, in place of the unreachable one. */
    readonly mcp?: ConnectorEndpoint;
  },
  drive: (session: Session) => Effect.Effect<void, unknown, Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const codex = realCodex();
      const cliVersion = parseVersion(execFileSync(codex, ["--version"], { encoding: "utf8" }));
      const { rawDir, launcher } = teeInFront(codex, spec.scenario);
      const services = yield* testServices(spec.mcp === undefined ? {} : { mcp: spec.mcp });
      const instance = yield* makeCodexConnectorDefinition().createInstance({
        instanceId: makeConnectorInstanceId(),
        config: { binaryPath: launcher },
        services,
      });
      const threadId = makeThreadId();
      const repo = scratchRepo(spec.scenario);
      spec.prepare?.(repo);
      const input = {
        threadId,
        projectId: makeProjectId(),
        workspaceRoot: repo,
        settings: spec.settings ?? SETTINGS,
      };
      const open = (sessionRef?: unknown, fork?: boolean) =>
        Effect.gen(function* () {
          const handle = yield* sessionRef === undefined
            ? instance.startSession(input)
            : instance.resumeSession({ ...input, sessionRef, ...(fork === true ? { fork } : {}) });
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

export const text = (value: string, attachments: TurnInput["attachments"] = []): TurnInput => ({
  text: value,
  attachments,
  mentions: [],
});

/** Sends one turn and waits for it to complete; answers the completion. */
export const turn = (recording: Recording, input: TurnInput) =>
  Effect.gen(function* () {
    const before = new Set(yield* recording.collector.collected);
    yield* recording.handle.send(input);
    return yield* recording.collector.awaitItem(
      (event) => !before.has(event) && event.type === "turn.completed",
    );
  });

/**
 * Answers every card the session opens with `decision`, for as long as its
 * stream runs; the ids it answered, for the recorder to check.
 */
export const answerCards = (recording: Recording, decision: ApprovalDecision) =>
  Effect.gen(function* () {
    const answered = new Set<string>();
    yield* Effect.gen(function* () {
      const opened = yield* recording.collector.awaitItem(
        (event) =>
          event.type === "request.opened" && !answered.has(event.payload.request.requestId),
      );
      if (opened.type !== "request.opened") return;
      answered.add(opened.payload.request.requestId);
      yield* recording.handle.respondToRequest(opened.payload.request.requestId, decision);
    }).pipe(Effect.forever, Effect.ignore, Effect.forkScoped);
    return answered;
  });

/** Closes the session and waits for its stream to end. */
export const closed = (recording: Recording) =>
  Effect.gen(function* () {
    yield* recording.handle.close();
    yield* recording.collector.awaitDone;
  });
