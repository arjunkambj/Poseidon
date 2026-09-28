/**
 * The session's own contract, against the `plain-reply` recording: one turn
 * at a time, a close that proves the app-server's process group gone, a
 * handle that refuses work once closed, and an app-server that dies on its
 * own reported as a crash.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { makeStreamCollector } from "@poseidon/connector-sdk/streamCollector";
import { makeConnectorInstanceId, makeThreadId } from "@poseidon/contracts/ids";
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import { loadStdioJsonRpcRecording } from "@poseidon/testkit/stdioJsonRpcRecording";
import * as Effect from "effect/Effect";

import { isPidGone, replay } from "../test/replay";
import { testServices } from "../test/services";
import { childEnv } from "./env";
import { CODEX_KIND } from "./kind";
import { makeCodexSession } from "./session";

const PROMPT = loadStdioJsonRpcRecording(CODEX_KIND, "plain-reply").manifest.prompts[0]!;

const turn = { text: PROMPT, attachments: [], mentions: [] };

const session = (scenario: string) =>
  Effect.gen(function* () {
    const replayed = replay(scenario);
    const workspace = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-session-")),
      scenario,
    );
    NodeFS.mkdirSync(workspace);
    const handle = yield* makeCodexSession({
      instanceId: makeConnectorInstanceId(),
      threadId: makeThreadId(),
      workspaceRoot: workspace,
      binary: { command: replayed.binaryPath, display: replayed.binaryPath },
      env: childEnv(process.env, {}),
      loginCommand: `${replayed.binaryPath} login`,
      services: yield* testServices(),
      settings: { model: "default", runtimeMode: "approval-required", interactionMode: "default" },
    });
    const collector = yield* makeStreamCollector(handle.events);
    return { replayed, handle, collector };
  });

const types = (events: ReadonlyArray<RuntimeEvent>) => events.map((event) => event.type);

describe("makeCodexSession", () => {
  it.live("runs one turn at a time, and closes with its process group gone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { replayed, handle, collector } = yield* session("plain-reply");
        yield* handle.send(turn);
        const refused = yield* Effect.flip(handle.send(turn));
        expect(refused._tag).toBe("TurnInProgress");
        yield* collector.awaitItem((event) => event.type === "turn.completed");

        yield* handle.close();
        yield* collector.awaitDone;
        expect(replayed.pids()).toHaveLength(1);
        expect(replayed.pids().every(isPidGone)).toBe(true);
        replayed.assertPlayedOut();

        const events = yield* collector.collected;
        expect(types(events).at(-1)).toBe("session.ended");
        expect(types(events).filter((type) => type === "turn.started")).toHaveLength(1);

        const closed = yield* Effect.flip(handle.send(turn));
        expect(closed._tag).toBe("SessionClosed");
        // A second close is a no-op, not a second `session.ended`.
        yield* handle.close();
        expect(
          types(yield* collector.collected).filter((type) => type === "session.ended"),
        ).toEqual(["session.ended"]);
      }),
    ),
  );

  it.live("reports an app-server that dies on its own as a crash", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { replayed, collector } = yield* session("plain-reply");
        for (const pid of replayed.pids()) process.kill(pid, "SIGKILL");
        yield* collector.awaitDone;
        const events = yield* collector.collected;

        const error = events.find((event) => event.type === "runtime.error");
        expect(error?.type === "runtime.error" && error.payload.fatal).toBe(true);
        expect(error?.type === "runtime.error" && error.payload.message).toContain("SIGKILL");
        const ended = events.at(-1);
        expect(ended?.type === "session.ended" && ended.payload.reason).toBe("crashed");
        expect(replayed.pids().every(isPidGone)).toBe(true);
      }),
    ),
  );
});
