/**
 * The CLI's own slash commands against `fixtures/claude/local-command/`,
 * replayed behind the binary path under the real SDK.
 *
 * The recording was made on a CLI that was not signed in; none of these
 * commands makes a request, so nothing reached the API. What it shows:
 *
 * - `/cost` is answered by the CLI itself, as a synthetic assistant message
 *   carrying the command's output, and a `result` with no request behind it;
 * - `/permissions`, a command that only opens a panel in the CLI's terminal
 *   UI, is refused the same way, with the CLI's own line;
 * - `/clear` sends `conversation_reset`, and the CLI's next `system/init`
 *   names a new session id: the conversation goes on under that id, and the
 *   session's ref follows it, so a resume carries on the cleared conversation.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { makeStreamCollector } from "@poseidon/connector-sdk/streamCollector";
import { makeConnectorInstanceId, makeThreadId } from "@poseidon/contracts/ids";
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import { loadSdkStreamRecording } from "@poseidon/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";

import { isPidGone, replay } from "../test/replay";
import { testServices } from "../test/services";
import { childEnv } from "./env";
import { CLAUDE_KIND } from "./kind";
import { makeClaudeSession } from "./session";

const recording = loadSdkStreamRecording(CLAUDE_KIND, "local-command");
const [COST, PANEL, CLEAR] = recording.manifest.prompts as [string, string, string, string];

/** The session ids the recorded CLI's `system/init`s named, in order. */
const initSessionIds = recording.invocations.flatMap((invocation) =>
  invocation.frames.flatMap((frame) => {
    const data = frame.data as { type?: unknown; subtype?: unknown; session_id?: unknown };
    return frame.dir === "from-harness" &&
      data?.type === "system" &&
      data.subtype === "init" &&
      typeof data.session_id === "string"
      ? [data.session_id]
      : [];
  }),
);

const ofType = <T extends RuntimeEvent["type"]>(events: ReadonlyArray<RuntimeEvent>, type: T) =>
  events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);

describe("the CLI's own slash commands, replaying claude/local-command", () => {
  it.live("shows each command's output, and follows the session id /clear moves to", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const replayed = replay("local-command");
        const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-session-"));
        const handle = yield* makeClaudeSession({
          instanceId: makeConnectorInstanceId(),
          threadId: makeThreadId(),
          workspaceRoot: workspace,
          binary: { command: replayed.binaryPath, display: replayed.binaryPath },
          env: childEnv(process.env, {}),
          loginCommand: `${replayed.binaryPath} auth login`,
          services: yield* testServices(),
          settings: {
            model: "default",
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
          limits: { maxTurns: 1, maxBudgetUsd: 0.05 },
        });
        const collector = yield* makeStreamCollector(handle.events);

        const turn = (text: string) =>
          Effect.gen(function* () {
            const before = new Set(yield* collector.collected);
            yield* handle.send({ text, attachments: [], mentions: [] });
            yield* collector.awaitItem(
              (event) => !before.has(event) && event.type === "turn.completed",
            );
          });

        yield* turn(COST);
        const before = (yield* handle.sessionRef()) as { readonly sessionId?: string };
        yield* turn(PANEL);
        yield* turn(CLEAR);
        yield* turn(COST);
        const after = yield* handle.sessionRef();

        yield* handle.close();
        yield* collector.awaitDone;
        const events = yield* collector.collected;
        expect(replayed.pids()).toHaveLength(1);
        expect(replayed.pids().every(isPidGone)).toBe(true);
        replayed.assertPlayedOut();

        // Four turns, each ended by the CLI as answered; nothing unmapped.
        expect(ofType(events, "turn.completed").map((event) => event.payload.stopReason)).toEqual([
          "end_turn",
          "end_turn",
          "end_turn",
          "end_turn",
        ]);
        expect(ofType(events, "event.unmapped")).toEqual([]);
        expect(ofType(events, "session.warning")).toEqual([]);
        expect(ofType(events, "runtime.error")).toEqual([]);

        // Each command's output is an answered row; /clear says nothing.
        const answers = ofType(events, "item.completed")
          .map((event) => event.payload.item)
          .filter((item) => item.kind === "assistant_message");
        expect(answers.map((item) => item.status)).toEqual(["completed", "completed", "completed"]);
        expect(answers[0]!.text).toContain("Total cost:");
        expect(answers[1]!.text).toBe(`${PANEL} isn't available in this environment.`);
        expect(answers[2]!.text).toContain("Total cost:");

        // /clear moved the CLI to a new session id, and the ref went with it.
        // Until then the CLI ran under the id the session minted, which the
        // replay puts where the recorded one stood.
        const [first, ...rest] = initSessionIds;
        const last = rest.at(-1);
        expect(last).toBeDefined();
        expect(last).not.toBe(first);
        const minted = ofType(events, "session.started")[0]?.payload.sessionRef;
        expect(before.sessionId).toBe((minted as { readonly sessionId?: string }).sessionId);
        expect(after).toMatchObject({ sessionId: last, cwd: workspace });
        const announced = ofType(events, "session.started").at(-1)?.payload.sessionRef;
        expect(announced).toMatchObject({ sessionId: last });
      }),
    ),
  );
});
