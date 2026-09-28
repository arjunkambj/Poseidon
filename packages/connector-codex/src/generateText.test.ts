/**
 * `generateText` against `fixtures/codex/generate-text/`, the real one-shot
 * exchange: one app-server, an ephemeral read-only thread, one turn with an
 * output schema, a JSON title as the answer.
 *
 * The replay checks each method in order and the load-bearing params (the
 * model, the effort, the approval policy and the sandbox). The testkit's tee
 * sits in front of the replayer as well, so the test also reads what the
 * connector sent in this run — `ephemeral`, the developer instructions, the
 * output schema — and the directory it ran in.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { makeConnectorInstanceId } from "@poseidon/contracts/ids";
import { makeTeeLauncher } from "@poseidon/testkit/sdkStreamRecording";
import { loadStdioJsonRpcRecording } from "@poseidon/testkit/stdioJsonRpcRecording";
import * as Effect from "effect/Effect";

import { GENERATE_REQUEST } from "../test/generateRequest";
import { isPidGone, replay } from "../test/replay";
import { testServices } from "../test/services";
import { makeCodexConnectorDefinition } from "./definition";
import {
  answerOf,
  declineFor,
  GENERATE_SERVER_ARGS,
  generateThreadParams,
  generateTurnParams,
} from "./generateText";
import { CODEX_KIND } from "./kind";

const SCENARIO = "generate-text";

interface Sent {
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

/** What the tee saw the connector send, in order. */
const sentThrough = (rawDir: string): ReadonlyArray<Sent> =>
  NodeFS.readFileSync(NodePath.join(rawDir, "invocation-1.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { dir: string; data: Sent })
    .filter((frame) => frame.dir === "to-harness")
    .map((frame) => frame.data);

/** The final answer the recorded CLI completed. */
const recordedAnswer = (): string => {
  for (const frame of loadStdioJsonRpcRecording(CODEX_KIND, SCENARIO).invocations[0]!.frames) {
    const data = frame.data as { method?: string; params?: { item?: Record<string, unknown> } };
    const item = data.params?.item;
    if (data.method === "item/completed" && item?.type === "agentMessage") {
      return String(item.text);
    }
  }
  throw new Error("the recording has no agent message");
};

describe("generateText replaying codex/generate-text", () => {
  it.live("answers with the recorded text over an ephemeral read-only thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const played = replay(SCENARIO);
        const rawDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-generate-tee-"));
        const instance = yield* makeCodexConnectorDefinition().createInstance({
          instanceId: makeConnectorInstanceId(),
          config: {
            binaryPath: makeTeeLauncher({ realBinary: played.binaryPath, rawDir }),
          },
          services: yield* testServices(),
        });
        expect(instance.capabilities.textGeneration).toBe(true);

        const answer = yield* instance.generateText!(GENERATE_REQUEST);
        played.assertPlayedOut();
        expect(answer).toBe(recordedAnswer());
        expect(JSON.parse(answer)).toEqual({ title: expect.any(String) });

        const sent = sentThrough(rawDir);
        expect(sent.map((message) => message.method)).toEqual([
          "initialize",
          "initialized",
          "thread/start",
          "turn/start",
        ]);
        const threadStart = sent[2]!.params!;
        expect(threadStart).toMatchObject({
          ephemeral: true,
          sandbox: "read-only",
          approvalPolicy: "never",
          developerInstructions: GENERATE_REQUEST.system,
        });
        // The CLI's default model is named nowhere.
        expect(threadStart).not.toHaveProperty("model");
        const turnStart = sent[3]!.params!;
        expect(turnStart).toMatchObject({
          input: [{ type: "text", text: GENERATE_REQUEST.prompt }],
          effort: "low",
          outputSchema: GENERATE_REQUEST.jsonSchema,
        });

        // No MCP override, and a directory of its own that is gone again.
        const launched = JSON.parse(
          NodeFS.readFileSync(NodePath.join(rawDir, "invocation-1.json"), "utf8"),
        ) as { argv: ReadonlyArray<string>; cwd: string };
        expect(launched.argv).toEqual(GENERATE_SERVER_ARGS);
        expect(NodePath.basename(launched.cwd)).toMatch(/^poseidon-generate-/);
        // The tee reports the real path (`/private/var/…` on macOS), the connector the temp one.
        expect(NodePath.basename(String(threadStart.cwd))).toBe(NodePath.basename(launched.cwd));
        expect(NodeFS.existsSync(launched.cwd)).toBe(false);

        expect(played.pids().length).toBe(1);
        expect(played.pids().every(isPidGone)).toBe(true);
        NodeFS.rmSync(rawDir, { recursive: true, force: true });
      }),
    ),
  );
});

describe("a CLI that will not start", () => {
  it.live("fails with GenerationFailed and leaves no directory behind", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const missing = NodePath.join(NodeOS.tmpdir(), "no-such-codex-binary");
        const before = NodeFS.readdirSync(NodeOS.tmpdir()).filter((name) =>
          name.startsWith("poseidon-generate-"),
        );
        const instance = yield* makeCodexConnectorDefinition().createInstance({
          instanceId: makeConnectorInstanceId(),
          config: { binaryPath: missing },
          services: yield* testServices(),
        });
        const error = yield* Effect.flip(instance.generateText!(GENERATE_REQUEST));
        expect(error._tag).toBe("GenerationFailed");
        expect(error.message).toContain("could not start");
        const after = NodeFS.readdirSync(NodeOS.tmpdir()).filter((name) =>
          name.startsWith("poseidon-generate-"),
        );
        expect(after.filter((name) => !before.includes(name))).toEqual([]);
      }),
    ),
  );
});

describe("the one-shot params", () => {
  const opened = { threadId: "t", model: "gpt-6-astra", effort: "high" } as const;

  it("names a chosen model on thread/start, and no instructions when there are none", () => {
    expect(generateThreadParams("/tmp/x", { prompt: "p", model: "gpt-6-luna" })).toEqual({
      cwd: "/tmp/x",
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      model: "gpt-6-luna",
    });
  });

  it("replaces an effort the model does not offer with the model's own", () => {
    const params = generateTurnParams(
      opened,
      { prompt: "p", model: "default", effort: "xhigh" },
      () => ({ efforts: ["low", "high"], defaultEffort: "high" }),
    );
    // The thread already runs at high, so nothing is named.
    expect(params).not.toHaveProperty("effort");
    expect(params).not.toHaveProperty("outputSchema");
  });

  it("leaves the effort out for a model that lists none", () => {
    const params = generateTurnParams(
      { threadId: "t", model: "gpt-6-astra" },
      { prompt: "p", model: "default", effort: "low" },
      () => ({ efforts: [] }),
    );
    expect(params).not.toHaveProperty("effort");
  });
});

describe("answerOf", () => {
  it("takes the text of a completed turn", () => {
    expect(answerOf({ status: "completed", text: '{"title":"x"}' })).toEqual({
      text: '{"title":"x"}',
    });
  });

  it("fails a turn that did not complete with its own error", () => {
    expect(answerOf({ status: "failed", error: "usage limit reached" })).toEqual({
      failure: "usage limit reached",
    });
    expect(answerOf({ status: "interrupted" })).toEqual({
      failure: "the turn ended interrupted",
    });
  });

  it("fails a completed turn with no text", () => {
    expect(answerOf({ status: "completed", text: "  " })).toEqual({
      failure: "codex answered with no text",
    });
    expect(answerOf({ status: "completed" })).toEqual({ failure: "codex answered with no text" });
  });

  it("fails a server that went away before the turn ended", () => {
    expect(answerOf({ closed: "app-server exited with code 1: boom" })).toEqual({
      failure: "app-server exited with code 1: boom",
    });
  });
});

describe("declineFor", () => {
  it("declines approvals and refuses everything else", () => {
    for (const method of [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ]) {
      expect(declineFor({ id: 1, method, params: {} })).toEqual({
        result: { decision: "decline" },
      });
    }
    expect(declineFor({ id: 2, method: "mcpServer/elicitation/request", params: {} })).toEqual({
      result: { action: "decline", content: null, _meta: null },
    });
    expect(declineFor({ id: 3, method: "item/tool/requestUserInput", params: {} })).toHaveProperty(
      "error",
    );
  });
});
