/**
 * `generateText` against the one real recording of it, and its options.
 *
 * The CLI on the recording machine is signed out, so
 * `fixtures/claude/generate-text-signed-out/` is the call refused: the real
 * SDK and the real CLI agreeing on the one-shot options, and the CLI's own
 * sign-in error as the result. A signed-in `generate-text` recording, with an
 * answer in it, is still to be made.
 */

import { describe, expect, it } from "@effect/vitest";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { makeConnectorInstanceId } from "@poseidon/contracts/ids";
import { recordingNames } from "@poseidon/testkit/recording";
import { loadSdkStreamRecording } from "@poseidon/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";

import { isPidGone, replay } from "../test/replay";
import { testServices } from "../test/services";
import { makeClaudeConnectorDefinition } from "./definition";
import { answerOf, generateTextOptions } from "./generateText";
import { CLAUDE_KIND } from "./kind";

const SCENARIO = "generate-text-signed-out";

/** The call the recording was made with (`test/recordSession.test.ts`). */
const REQUEST = {
  system: "You name chat threads. Reply with a title of 3 to 8 words and nothing else.",
  prompt: "First message: fix the flaky login test",
  model: "default",
  effort: "low",
} as const;

const recording = () => loadSdkStreamRecording(CLAUDE_KIND, SCENARIO);

/** What the recorded CLI said its result was. */
const recordedResult = (): { readonly result: string; readonly is_error: boolean } => {
  for (const invocation of recording().invocations) {
    for (const frame of invocation.frames) {
      const data = frame.data as { type?: string; result?: string; is_error?: boolean };
      if (frame.dir === "from-harness" && data.type === "result") {
        return { result: data.result ?? "", is_error: data.is_error === true };
      }
    }
  }
  throw new Error("the recording has no result");
};

describe("generateText on a signed-out CLI", () => {
  it.live("fails with GenerationFailed carrying the CLI's sign-in message", () =>
    Effect.gen(function* () {
      const played = replay(SCENARIO);
      const instance = yield* makeClaudeConnectorDefinition().createInstance({
        instanceId: makeConnectorInstanceId(),
        config: { binaryPath: played.binaryPath },
        services: yield* testServices(),
      });
      expect(instance.capabilities.textGeneration).toBe(true);
      const error = yield* Effect.flip(instance.generateText!(REQUEST));
      expect(error._tag).toBe("GenerationFailed");
      expect(recordedResult().is_error).toBe(true);
      expect(error.message).toBe(recordedResult().result);
      expect(error.message).toMatch(/Not logged in/);
      // The live SDK said what the recorded one did: the same initialize,
      // with the same system prompt, and the same user message.
      played.assertPlayedOut();
      expect(played.pids().length).toBe(1);
      expect(played.pids().every(isPidGone)).toBe(true);
    }),
  );

  it("was recorded under the one-shot flags, and the CLI started with no tools", () => {
    const [invocation] = recording().invocations;
    const argv = invocation?.argv ?? [];
    expect(argv.join(" ")).toContain("--max-turns 1");
    expect(argv.join(" ")).toContain("--effort low");
    expect(argv).toContain("--no-session-persistence");
    expect(argv).toContain("--setting-sources=");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).not.toContain("--resume");
    const init = invocation?.frames
      .map(
        (frame) =>
          frame.data as { type?: string; subtype?: string; tools?: unknown; mcp_servers?: unknown },
      )
      .find((data) => data.type === "system" && data.subtype === "init");
    expect(init?.tools).toEqual([]);
    expect(init?.mcp_servers).toEqual([]);
  });
});

/** Replayed once `fixtures/claude/generate-text/` is recorded with a signed-in CLI. */
const answered = recordingNames(CLAUDE_KIND).includes("generate-text");
(answered ? describe : describe.skip)(
  answered
    ? "generateText on a signed-in CLI"
    : "generateText on a signed-in CLI — has no recording yet: record fixtures/claude/generate-text/ with a signed-in CLI",
  () => {
    it.live("answers the result's text", () =>
      Effect.gen(function* () {
        const played = replay("generate-text");
        const instance = yield* makeClaudeConnectorDefinition().createInstance({
          instanceId: makeConnectorInstanceId(),
          config: { binaryPath: played.binaryPath },
          services: yield* testServices(),
        });
        const text = yield* instance.generateText!(REQUEST);
        expect(text.trim()).not.toBe("");
        played.assertPlayedOut();
      }),
    );
  },
);

describe("generateTextOptions", () => {
  const options = (request: Parameters<typeof generateTextOptions>[0]["request"]) =>
    generateTextOptions({
      binaryPath: "/bin/claude",
      env: { PATH: "/bin" },
      cwd: "/tmp/poseidon-generate-x",
      abortController: new AbortController(),
      spawn: () => {
        throw new Error("not spawned here");
      },
      request,
    });

  it("asks for one turn, no session, no settings and no tools", () => {
    const built = options(REQUEST);
    expect(built.maxTurns).toBe(1);
    expect(built.persistSession).toBe(false);
    expect(built.settingSources).toEqual([]);
    expect(built.tools).toEqual([]);
    expect(built.allowedTools).toEqual([]);
    expect(built.mcpServers).toEqual({});
    expect(built.strictMcpConfig).toBe(true);
    expect(built.cwd).toBe("/tmp/poseidon-generate-x");
    expect(built.systemPrompt).toBe(REQUEST.system);
    expect(built.effort).toBe("low");
    // `default` leaves the model to the CLI.
    expect(built.model).toBeUndefined();
    expect(built.outputFormat).toBeUndefined();
    expect(built.resume).toBeUndefined();
  });

  it.effect("denies every tool that still asks", () =>
    Effect.gen(function* () {
      const canUseTool = options(REQUEST).canUseTool!;
      const verdict = yield* Effect.promise(() =>
        canUseTool(
          "Bash",
          { command: "ls" },
          { signal: new AbortController().signal, toolUseID: "tool-1", requestId: "request-1" },
        ),
      );
      expect(verdict?.behavior).toBe("deny");
    }),
  );

  it("names an explicit model, leaves minimal effort out, and keeps no empty system prompt", () => {
    const built = options({
      prompt: "p",
      model: "claude-opus-5-5",
      effort: "minimal",
      system: " ",
    });
    expect(built.model).toBe("claude-opus-5-5");
    expect(built.effort).toBeUndefined();
    expect(built.systemPrompt).toBeUndefined();
  });
});

describe("answerOf", () => {
  const base = { type: "result", session_id: "s", uuid: "u" } as const;

  it("answers a success's text", () => {
    const result = { ...base, subtype: "success", is_error: false, result: "Fix login test" };
    expect(answerOf(result as unknown as SDKResultMessage)).toEqual({ text: "Fix login test" });
  });

  it("fails on an error subtype with the CLI's errors", () => {
    const result = { ...base, subtype: "error_max_turns", is_error: true, errors: ["cap"] };
    expect(answerOf(result as unknown as SDKResultMessage)).toEqual({
      failure: "claude stopped with error_max_turns: cap",
    });
  });

  it("fails with no result at all", () => {
    expect(answerOf(null)).toEqual({ failure: "claude ended without a result" });
  });
});
