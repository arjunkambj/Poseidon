/**
 * The MCP tool-call approvals the CLI sends as elicitations, read against the
 * one `codex/mcp-tool-approval` recorded, and answered through the tool gate.
 */

import { makeApprovalGate } from "@poseidon/connector-sdk/approvalGate";
import type { ConnectorPermissions } from "@poseidon/connector-sdk/definition";
import { makeThreadId } from "@poseidon/contracts/ids";
import type { ApprovalRequest } from "@poseidon/contracts/runtime";
import { describe, expect, it } from "@effect/vitest";
import { loadStdioJsonRpcRecording } from "@poseidon/testkit/stdioJsonRpcRecording";
import * as Effect from "effect/Effect";

import { CODEX_KIND } from "./kind";
import {
  elicitationOutcome,
  isMcpToolApproval,
  makeMcpToolCalls,
  MCP_ELICITATION,
  mcpToolApprovalRequest,
} from "./mcpApprovals";
import type { RpcServerRequest } from "./rpc";
import { isGatedRequest, makeCodexToolGate } from "./toolGate";

/** A frame of the recording, as the connector reads it. */
interface Frame {
  readonly dir: string;
  readonly data: { readonly method?: string; readonly id?: number; readonly params?: unknown };
}

const recorded = (): ReadonlyArray<Frame> =>
  loadStdioJsonRpcRecording(CODEX_KIND, "mcp-tool-approval").invocations[0]!
    .frames as ReadonlyArray<Frame>;

const elicitation = (): RpcServerRequest => {
  const frame = recorded().find((each) => each.data.method === MCP_ELICITATION)!;
  return { id: frame.data.id!, method: MCP_ELICITATION, params: frame.data.params };
};

/** The `item/started` of the recorded `mcpToolCall`. */
const toolCallStarted = () =>
  recorded().find(
    (each) =>
      each.data.method === "item/started" &&
      (each.data.params as { item: { type: string } }).item.type === "mcpToolCall",
  )!.data;

describe("an MCP tool-call elicitation", () => {
  it("is told apart from an MCP server asking the user for input", () => {
    expect(isMcpToolApproval(elicitation().params)).toBe(true);
    expect(isGatedRequest(elicitation())).toBe(true);
    const plain = { id: 1, method: MCP_ELICITATION, params: { serverName: "s", mode: "form" } };
    expect(isMcpToolApproval(plain.params)).toBe(false);
    expect(isGatedRequest(plain)).toBe(false);
  });

  it("names the server, the tool and its arguments from the call the CLI started", () => {
    const calls = makeMcpToolCalls();
    const started = toolCallStarted();
    calls.observe(started.method!, started.params);
    expect(mcpToolApprovalRequest(elicitation().params, calls)).toMatchObject({
      kind: "mcp_tool",
      toolName: "mcp__poseidon__browser_open",
      mcpTool: { server: "poseidon", tool: "browser_open" },
      input: { url: "https://example.com" },
      patternSuggestion: "Mcp(poseidon.browser_open)",
      description: "Call browser_open on the poseidon MCP server — https://example.com",
    });
  });

  it("falls back to the CLI's message and _meta when no call was seen start", () => {
    expect(mcpToolApprovalRequest(elicitation().params, makeMcpToolCalls())).toMatchObject({
      toolName: "mcp__poseidon__browser_open",
      mcpTool: { server: "poseidon", tool: "browser_open" },
      input: { url: "https://example.com" },
    });
  });

  it("forgets a call once it completed", () => {
    const calls = makeMcpToolCalls();
    const started = toolCallStarted();
    calls.observe("item/started", started.params);
    calls.observe("item/completed", started.params);
    expect(calls.latestOn("poseidon")).toBeUndefined();
  });

  it("is answered in the elicitation's own words", () => {
    expect(elicitationOutcome("accept")).toEqual({
      result: { action: "accept", content: {}, _meta: null },
    });
    expect(elicitationOutcome("decline")).toEqual({
      result: { action: "decline", content: null, _meta: null },
    });
  });
});

describe("the tool gate answering an MCP tool call", () => {
  const answerWith = (decide: ConnectorPermissions["decide"]) =>
    Effect.gen(function* () {
      const asked: Array<ApprovalRequest> = [];
      const gate = yield* makeApprovalGate({
        permissions: {
          decide: (input) => {
            asked.push(input.request);
            return decide(input);
          },
        },
        emit: () => Effect.void,
      });
      const toolGate = makeCodexToolGate({
        threadId: makeThreadId(),
        gate,
        settings: () => ({
          model: "default",
          runtimeMode: "full-access",
          interactionMode: "default",
        }),
      });
      const started = toolCallStarted();
      yield* toolGate.observe({ method: started.method!, params: started.params });
      const outcome = yield* toolGate.answer(elicitation());
      return { outcome, asked };
    });

  it.effect("asks the ladder about the tool, and accepts what it allows", () =>
    Effect.gen(function* () {
      const { outcome, asked } = yield* answerWith(() => Effect.succeed("allow"));
      expect(asked.map((request) => request.mcpTool)).toEqual([
        { server: "poseidon", tool: "browser_open" },
      ]);
      expect(outcome).toEqual(elicitationOutcome("accept"));
    }),
  );

  it.effect("declines what the ladder denies", () =>
    Effect.gen(function* () {
      expect((yield* answerWith(() => Effect.succeed("deny"))).outcome).toEqual(
        elicitationOutcome("decline"),
      );
    }),
  );
});
