/**
 * A session against `fixtures/claude/signed-out/`: one real turn sent to a CLI
 * that was not signed in, replayed behind the binary path under the real SDK.
 * The CLI answers with its own sign-in error and an error result without
 * calling the API, which is the whole of a turn's lifecycle: handshake,
 * announcement, the user message, the answer, the result, and the close.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { makeStreamCollector } from "@poseidon/connector-sdk/streamCollector";
import { makeConnectorInstanceId, makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import { loadSdkStreamRecording } from "@poseidon/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { isPidGone, replay } from "../test/replay";
import { testServices } from "../test/services";
import { CLAUDE_CAPABILITIES } from "./capabilities";
import { makeClaudeConnectorDefinition } from "./definition";
import { CLAUDE_KIND } from "./kind";
import { markInterrupted } from "./session";

const recording = loadSdkStreamRecording(CLAUDE_KIND, "signed-out");
const PROMPT = recording.manifest.prompts[0]!;
/** The session id the recorded CLI's `system/init` named. */
const RECORDED_SESSION_ID = recording.invocations
  .flatMap((invocation) => invocation.frames)
  .flatMap((frame) => {
    const data = frame.data as { type?: unknown; subtype?: unknown; session_id?: unknown };
    return data?.type === "system" && data.subtype === "init" ? [data.session_id] : [];
  })[0];

const open = (options: { readonly resumeFrom?: unknown } = {}) =>
  Effect.gen(function* () {
    const replayed = replay("signed-out");
    const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-session-"));
    const instance = yield* makeClaudeConnectorDefinition().createInstance({
      instanceId: makeConnectorInstanceId(),
      config: { binaryPath: replayed.binaryPath },
      services: yield* testServices(),
    });
    const input = {
      threadId: makeThreadId(),
      projectId: makeProjectId(),
      workspaceRoot: workspace,
      settings: {
        model: "default",
        runtimeMode: "approval-required" as const,
        interactionMode: "default" as const,
      },
    };
    const handle =
      options.resumeFrom === undefined
        ? yield* instance.startSession(input)
        : yield* instance.resumeSession({ ...input, sessionRef: options.resumeFrom });
    const collector = yield* makeStreamCollector(handle.events);
    return { replayed, workspace, handle, collector };
  });

const ofType = <T extends RuntimeEvent["type"]>(events: ReadonlyArray<RuntimeEvent>, type: T) =>
  events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);

describe("a Claude Code session", () => {
  it.live("runs a turn the CLI refuses for want of a login, and closes cleanly", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { replayed, workspace, handle, collector } = yield* open();

        yield* handle.send({ text: PROMPT, attachments: [], mentions: [] });
        yield* collector.awaitItem((event) => event.type === "turn.completed");
        const events = yield* collector.collected;

        // Announced first, with the id the session minted and the thread's model.
        const started = events[0];
        expect(started?.type).toBe("session.started");
        if (started?.type !== "session.started") throw new Error("unreachable");
        expect(started.payload.model).toBe("default");
        expect(started.payload.capabilities).toEqual(CLAUDE_CAPABILITIES);
        expect(started.payload.sessionRef).toMatchObject({ cwd: workspace });
        const { sessionId } = started.payload.sessionRef as { sessionId: string };
        expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

        // Poseidon's MCP server was offered; nothing listened, and the CLI said so.
        expect(ofType(events, "mcp.status.updated")[0]?.payload.servers).toEqual([
          { name: "poseidon", status: "failed" },
        ]);

        // The CLI's own "Not logged in" line becomes an error naming the command
        // that fixes it, not an assistant row.
        const errors = ofType(events, "runtime.error");
        expect(errors).toHaveLength(1);
        expect(errors[0]?.payload.fatal).toBe(true);
        expect(errors[0]?.payload.message).toContain(`${replayed.binaryPath} auth login`);
        expect(events.some((event) => event.type.startsWith("item."))).toBe(false);

        const turn = ofType(events, "turn.started")[0]!.payload.turnId;
        expect(ofType(events, "usage.updated")[0]?.payload).toEqual({
          turnId: turn,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          costUsd: 0,
        });
        expect(ofType(events, "turn.completed")[0]?.payload).toEqual({
          turnId: turn,
          stopReason: "error",
        });

        // Every frame of the turn is mapped: the CLI's receipts for the
        // message and its "requesting" status say nothing the stream does not.
        expect(ofType(events, "event.unmapped")).toEqual([]);

        // The ref is said again once the turn settled, now with the cost total
        // and the session id the CLI's init named — the minted one, live; the
        // recorded one, here.
        const reported = { sessionId: RECORDED_SESSION_ID, cwd: workspace, totalCostUsd: 0 };
        expect(yield* handle.sessionRef()).toEqual(reported);

        yield* handle.close();
        yield* collector.awaitDone;
        const all = yield* collector.collected;
        expect(all.at(-1)).toMatchObject({ type: "session.ended", payload: { reason: "stopped" } });
        expect(ofType(all, "session.started").at(-1)?.payload.sessionRef).toEqual(reported);
        expect(replayed.pids()).toHaveLength(1);
        expect(replayed.pids().every(isPidGone)).toBe(true);
        replayed.assertPlayedOut();

        const refused = yield* Effect.flip(
          handle.send({ text: PROMPT, attachments: [], mentions: [] }),
        );
        expect(refused._tag).toBe("SessionClosed");
      }),
    ),
  );

  it.live("refuses a second message while a turn runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handle, collector } = yield* open();
        yield* handle.send({ text: PROMPT, attachments: [], mentions: [] });
        const second = yield* Effect.flip(
          handle.send({ text: "again", attachments: [], mentions: [] }),
        );
        expect(second._tag).toBe("TurnInProgress");
        yield* collector.awaitItem((event) => event.type === "turn.completed");
        yield* handle.close();
      }),
    ),
  );

  it.live("starts fresh, and says so, when the stored ref cannot be read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handle, collector } = yield* open({ resumeFrom: { sessionId: "not-a-uuid" } });
        const warning = yield* collector.awaitItem((event) => event.type === "session.warning");
        const events = yield* collector.collected;
        expect(events[0]?.type).toBe("session.started");
        expect(warning.type === "session.warning" && warning.payload.message).toContain(
          "starts a new one",
        );
        yield* handle.close();
      }),
    ),
  );
});

describe("Stop's mark on the running turn", () => {
  const running = { turnId: "turn-1", interrupted: false };

  it("marks the running turn, and hands it back", () => {
    expect(markInterrupted(running)).toEqual([running, { ...running, interrupted: true }]);
  });

  it("leaves no turn when none runs", () => {
    expect(markInterrupted(null)).toEqual([null, null]);
  });

  it.effect("never writes back a turn the consumer ended first", () =>
    Effect.gen(function* () {
      const turnRef = yield* Ref.make<typeof running | null>(running);
      // Stop saw the turn; its result ended it before Stop marked it.
      const seen = yield* Ref.get(turnRef);
      yield* Ref.set(turnRef, null);
      expect(seen).not.toBeNull();
      expect(yield* Ref.modify(turnRef, markInterrupted)).toBeNull();
      // Still no turn: the next send is not refused as TurnInProgress.
      expect(yield* Ref.get(turnRef)).toBeNull();
    }),
  );
});
