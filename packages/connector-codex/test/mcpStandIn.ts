/**
 * An MCP endpoint for recording an MCP tool call: Poseidon's side of the
 * wire, not the harness's. The CLI's frames in the recording are the real
 * CLI's; this only stands where the server's MCP gateway stands, so the
 * recorder needs no running Poseidon.
 *
 * It speaks the streamable-HTTP JSON-RPC the gateway speaks
 * (`apps/server/src/mcp/McpGateway.ts`), checks the bearer the session hands
 * the CLI, and lists one tool shaped as the gateway lists `browser_open`
 * (`apps/server/src/browser/tools.ts`): not read-only, reaching outside the
 * machine — the annotations that make Codex ask before running it. A call is
 * answered with one line of text and remembered, so the recorder can prove
 * it ran.
 */

import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import type { ConnectorEndpoint } from "@poseidon/connector-sdk/definition";

export const STAND_IN_TOOL = {
  name: "browser_open",
  description:
    "Open an http:// or https:// URL in the thread's browser session, creating it on first use.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "http:// or https:// address to navigate to" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  annotations: {
    title: "browser open",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
} as const;

export interface McpStandIn {
  readonly endpoint: ConnectorEndpoint;
  /** The arguments of every `tools/call` that reached it. */
  readonly calls: () => ReadonlyArray<unknown>;
  readonly close: () => Promise<void>;
}

const BEARER = "poseidon-record-bearer-0000";

export const startMcpStandIn = async (): Promise<McpStandIn> => {
  const calls: Array<unknown> = [];
  const server = NodeHttp.createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${BEARER}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const message = JSON.parse(body) as {
        id?: unknown;
        method?: string;
        params?: { protocolVersion?: unknown; arguments?: unknown };
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const reply = (payload: Record<string, unknown>) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload }));
      };
      switch (message.method) {
        case "initialize":
          return reply({
            result: {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "poseidon", version: "1" },
            },
          });
        case "ping":
          return reply({ result: {} });
        case "tools/list":
          return reply({ result: { tools: [STAND_IN_TOOL] } });
        case "tools/call":
          calls.push(message.params?.arguments);
          return reply({ result: { content: [{ type: "text", text: "opened" }] } });
        default:
          return reply({ error: { code: -32601, message: `method not found: ${message.method}` } });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: { url: `http://127.0.0.1:${port}/mcp`, bearer: BEARER },
    calls: () => calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
