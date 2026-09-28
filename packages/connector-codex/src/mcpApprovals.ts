/**
 * The CLI's approvals of MCP tool calls, in Poseidon's approval vocabulary.
 *
 * Codex does not ask about an MCP tool call with an approval request of its
 * own: it sends `mcpServer/elicitation/request`, the request an MCP server
 * uses to ask the user for input, marked as an approval by its `_meta`
 * (`codex_approval_kind: "mcp_tool_call"`). Recorded against 0.156.1
 * (`fixtures/codex/mcp-tool-approval`): under the `untrusted` policy every
 * mode keeps (`modes.ts`), a tool that is not read-only and reaches outside
 * the machine — every Poseidon browser tool that sends input or changes the
 * page — is asked about this way before it runs, with the message
 * `Allow the <server> MCP server to run tool "<tool>"?`. A declined one
 * completes `failed` ("user rejected MCP tool call") and never reaches the
 * server.
 *
 * So such an elicitation goes through the approval gate like a command
 * (`toolGate.ts`), as the same request Claude Code's MCP calls make:
 * kind `mcp_tool`, tool `mcp__<server>__<tool>`, `mcpTool` naming both so an
 * `Mcp(<server>.<tool>)` rule matches, and "allow always" starting from that
 * pattern. The elicitation names the server but not the tool; the tool and
 * its arguments come from the `mcpToolCall` item the CLI started just before
 * asking (`makeMcpToolCalls`), else from the message and `_meta.tool_params`.
 *
 * Every other elicitation — an MCP server really asking the user for input —
 * is still declined (`serverRequests.ts`).
 */

import { makeRequestId } from "@poseidon/contracts/ids";
import type { ApprovalRequest } from "@poseidon/contracts/runtime";

import type { RpcOutcome } from "./rpc";
import { asRecord, asString, nonEmpty, type Json } from "./translate/pending";

/** The request an MCP server — or the CLI, for a tool call — asks the user with. */
export const MCP_ELICITATION = "mcpServer/elicitation/request";

/** The `_meta` mark of an elicitation that is the CLI asking to run an MCP tool. */
const MCP_TOOL_CALL_KIND = "mcp_tool_call";

/** Whether an elicitation's params are the CLI asking to run an MCP tool. */
export const isMcpToolApproval = (params: unknown): boolean =>
  asString(asRecord(asRecord(params)._meta).codex_approval_kind) === MCP_TOOL_CALL_KIND;

/** One MCP tool call the CLI has started and not yet completed. */
export interface McpToolCall {
  readonly server: string;
  readonly tool: string;
  readonly arguments: unknown;
}

/** The MCP tool calls in flight, as their `item/started` named them. */
export interface McpToolCalls {
  /** Reads an `item/started` or `item/completed`; keeps a call from start to completion. */
  readonly observe: (method: string, params: unknown) => void;
  /** The call the CLI started last on `server` and has not completed. */
  readonly latestOn: (server: string) => McpToolCall | undefined;
  readonly clear: () => void;
}

export const makeMcpToolCalls = (): McpToolCalls => {
  /** In start order, by item id. */
  const running = new Map<string, McpToolCall>();
  return {
    observe: (method, params) => {
      const item: Json = asRecord(asRecord(params).item);
      const id = asString(item.id);
      if (asString(item.type) !== "mcpToolCall" || id === undefined) return;
      if (method === "item/completed") {
        running.delete(id);
        return;
      }
      if (method !== "item/started") return;
      const server = nonEmpty(item.server);
      const tool = nonEmpty(item.tool);
      if (server === undefined || tool === undefined) return;
      running.set(id, { server, tool, arguments: item.arguments ?? {} });
    },
    latestOn: (server) => [...running.values()].findLast((call) => call.server === server),
    clear: () => running.clear(),
  };
};

/** The tool the CLI's message names: `... to run tool "<tool>"?`. */
const toolInMessage = (message: unknown): string | undefined =>
  nonEmpty(/run tool "([^"]+)"/.exec(asString(message) ?? "")?.[1]);

/** At most this much of an argument goes into the card's one line. */
const LINE_LIMIT = 120;

/** The call's one argument worth showing — a URL, a selector, a path — if it has one. */
const leadArgument = (input: unknown): string | undefined => {
  const values = Object.values(asRecord(input)).filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  if (values.length !== 1) return undefined;
  const line = values[0]!.replace(/\s+/g, " ").trim();
  return line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT - 1)}…` : line;
};

/** An MCP tool-call elicitation as the ladder and the card read it. */
export const mcpToolApprovalRequest = (
  params: unknown,
  calls: Pick<McpToolCalls, "latestOn">,
): ApprovalRequest => {
  const record = asRecord(params);
  const server = nonEmpty(record.serverName) ?? "unknown";
  const call = calls.latestOn(server);
  const tool = call?.tool ?? toolInMessage(record.message) ?? "unknown";
  const input = asRecord(call?.arguments ?? asRecord(record._meta).tool_params);
  const lead = leadArgument(input);
  return {
    requestId: makeRequestId(),
    kind: "mcp_tool",
    toolName: `mcp__${server}__${tool}`,
    input,
    patternSuggestion: `Mcp(${server}.${tool})`,
    mcpTool: { server, tool },
    description: `Call ${tool} on the ${server} MCP server${lead === undefined ? "" : ` — ${lead}`}`,
  };
};

/**
 * The elicitation's answer for one of the gate's answers. An accepted form
 * carries empty content — the CLI's form asks for no fields — and no
 * `persist`: "allow for the session" is Poseidon's own session rule, so the
 * CLI keeps asking and the ladder keeps answering.
 */
export const elicitationOutcome = (answer: "accept" | "decline" | "cancel"): RpcOutcome => ({
  result: { action: answer, content: answer === "accept" ? {} : null, _meta: null },
});
