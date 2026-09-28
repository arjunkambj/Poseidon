/**
 * The MCP gateway: one loopback `POST /mcp` endpoint, per-session bearer
 * tokens, and the JSON-RPC dispatch into the thread's browser queue.
 *
 * `endpoint(threadId)` is handed to the connector through
 * `ConnectorServices.mcpEndpoint`; the bearer it returns is minted for that
 * thread and revoked when the session ends or the thread closes. Every
 * `tools/call` runs through `BrowserService.callTool`, which is where the
 * serialized queue and the `interrupted_by_human` epoch live — this module
 * stays thin JSON-RPC plumbing.
 *
 * Tool results cap at 64KB of text, and `structuredContent` at the same 64KB
 * serialized; `browser_screenshot` adds an image content block. Timeline rows for `mcp__poseidon__browser_*` come from the
 * harness transcript (the connector's translator), not from here — emitting
 * `thread.item.upserted` in this layer would double every row.
 *
 * The browser tools belong to the built-in Browser plugin. When a bearer is
 * minted, the gateway records whether that plugin was on at that moment
 * (`PluginRegistry.browserEnabled`); a bearer minted with it off lists no
 * tools and refuses every `browser_*` call with a message naming the switch.
 * The flag is fixed for the bearer's life, so the unit is the session:
 * toggling the plugin changes the sessions started afterwards and never the
 * running ones. Without a registry in the graph the tools are on. This is
 * only wiring — the browser's own security model (the scoped bridge, the
 * capability tokens, the kill switch) is untouched.
 */

import { randomBytes } from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/unstable/http/HttpServer";

import type { ConnectorEndpoint } from "@poseidon/connector-sdk/definition";
import type { ThreadId } from "@poseidon/contracts/ids";

import { BROWSER_TOOLS, type BrowserCallOutcome } from "../browser/tools";
import { OrchestrationEngine } from "../orchestration/Engine";
import { SessionManager } from "../orchestration/SessionManager";
import { PluginRegistry } from "../plugins/PluginRegistry";
import { BrowserService } from "../rpc/services";

const PROTOCOL_VERSION = "2025-06-18";

/**
 * Versions this gateway can speak. `initialize` echoes the client's own
 * version when it is one of these and otherwise answers with ours, which is
 * what the MCP handshake asks for — a client that gets a version it did not
 * ask for and cannot speak is supposed to disconnect, and one that gets a
 * hard-coded string it does not recognise disconnects when it need not have.
 */
const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const RESULT_CAP_BYTES = 64 * 1024;

/** What a `browser_*` call on a bearer minted with the Browser plugin off reads. */
export const BROWSER_PLUGIN_OFF_MESSAGE = "the Browser plugin is turned off in Customize → Plugins";

/** One minted bearer: its thread, and whether the browser tools were on at mint. */
interface Bearer {
  readonly threadId: ThreadId;
  readonly browser: boolean;
}

export interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: unknown;
  readonly method?: string;
  readonly params?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const negotiateVersion = (params: unknown): string => {
  if (isRecord(params) && typeof params.protocolVersion === "string") {
    return SUPPORTED_PROTOCOL_VERSIONS.has(params.protocolVersion)
      ? params.protocolVersion
      : PROTOCOL_VERSION;
  }
  return PROTOCOL_VERSION;
};

const jsonRpcResult = (id: unknown, result: unknown) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  result,
});

const jsonRpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  error: { code, message },
});

/**
 * The spec's 64KB result cap, counted in bytes. `text.length` counts UTF-16
 * units, so a snapshot of mostly non-ASCII text used to pass a cap it was
 * two or three times over. The cut lands on a byte boundary, so a partial
 * code point at the end is dropped rather than decoded as a replacement
 * character.
 */
export const capText = (text: string): string => {
  if (Buffer.byteLength(text, "utf8") <= RESULT_CAP_BYTES) return text;
  const head = Buffer.from(text, "utf8").subarray(0, RESULT_CAP_BYTES);
  const decoded = new TextDecoder("utf-8").decode(head).replace(/\uFFFD+$/, "");
  return `${decoded}\n… truncated at ${RESULT_CAP_BYTES} bytes`;
};

/** The small fields a capped structured result keeps: where the page is. */
const KEPT_FIELDS = ["origin", "url", "title", "targetId"] as const;
const KEPT_FIELD_MAX_BYTES = 2048;

/**
 * The same 64KB cap on the result's `structuredContent`. A snapshot carries
 * its text *and* a refs map, so leaving this uncapped let every large page
 * past the cap `capText` puts on the text beside it. Over the cap, the bodies
 * go and only where the page is stays, with `truncated` and the size that
 * was dropped; the text content still carries the truncated body.
 */
export const capStructured = (data: Record<string, unknown>): Record<string, unknown> => {
  const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (bytes <= RESULT_CAP_BYTES) return data;
  const kept: Record<string, unknown> = {};
  for (const field of KEPT_FIELDS) {
    const value = data[field];
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") <= KEPT_FIELD_MAX_BYTES) {
      kept[field] = value;
    }
  }
  return { ...kept, truncated: true, bytes };
};

/** The text the agent reads back from a browser_* call. */
const outcomeText = (outcome: BrowserCallOutcome): string => {
  switch (outcome.kind) {
    case "ok": {
      const data = outcome.data;
      if (typeof data.snapshot === "string") return capText(data.snapshot);
      if (typeof data.text === "string") return capText(data.text);
      if (typeof data.url === "string" && Object.keys(data).length <= 3) return data.url;
      if (typeof data.title === "string" && Object.keys(data).length <= 3) return data.title;
      return capText(JSON.stringify(data));
    }
    case "interrupted":
      return "interrupted_by_human — the user took control of the browser while this call was running; re-snapshot before continuing or stop driving";
    case "error":
      return capText(outcome.message);
  }
};

export class McpGateway extends Context.Service<
  McpGateway,
  {
    /** Mint a fresh bearer for the thread and hand back the endpoint. */
    readonly endpoint: (threadId: ThreadId) => Effect.Effect<ConnectorEndpoint>;
    /** Drop every bearer minted for the thread — dead requests 401. */
    readonly revoke: (threadId: ThreadId) => Effect.Effect<void>;
    /** bearer → threadId for the route layer. */
    readonly resolve: (token: string) => Effect.Effect<Option.Option<ThreadId>>;
    /**
     * One JSON-RPC message. Returns `null` for notifications (the route
     * answers 202 with an empty body) and the response object otherwise.
     * `bearer` is the token the message came with; its mint-time Browser
     * plugin state decides whether the browser tools exist. Without one the
     * tools are on.
     */
    readonly handleMessage: (
      threadId: ThreadId,
      message: JsonRpcRequest,
      bearer?: string,
    ) => Effect.Effect<Record<string, unknown> | null>;
  }
>()("server/mcp/McpGateway") {
  static readonly layer = Layer.effect(
    McpGateway,
    Effect.gen(function* () {
      const browser = yield* BrowserService;
      const httpServer = yield* HttpServer.HttpServer;
      const engine = yield* OrchestrationEngine;
      const manager = yield* SessionManager;
      const scope = yield* Effect.scope;
      const plugins = yield* Effect.serviceOption(PluginRegistry);
      const browserEnabled = Option.match(plugins, {
        onNone: () => Effect.succeed(true),
        onSome: (registry) => registry.browserEnabled,
      });

      const tokens = yield* Ref.make(new Map<string, Bearer>());
      const byThread = yield* Ref.make(new Map<ThreadId, ReadonlySet<string>>());

      const httpBase = (): string => {
        const address = httpServer.address;
        if (typeof address === "object" && address !== null && "port" in address) {
          return `http://127.0.0.1:${address.port}`;
        }
        return "http://127.0.0.1:0";
      };

      const issueBearer = (threadId: ThreadId): Effect.Effect<string> =>
        Effect.gen(function* () {
          const bearer = randomBytes(24).toString("hex");
          const browser = yield* browserEnabled;
          yield* Ref.update(tokens, (map) => new Map(map).set(bearer, { threadId, browser }));
          yield* Ref.update(byThread, (map) => {
            const next = new Map(map);
            next.set(threadId, new Set([...(next.get(threadId) ?? []), bearer]));
            return next;
          });
          return bearer;
        });

      const endpoint = (threadId: ThreadId): Effect.Effect<ConnectorEndpoint> =>
        Effect.map(issueBearer(threadId), (bearer) => ({
          url: `${httpBase()}/mcp`,
          bearer,
        }));

      const revoke = (threadId: ThreadId): Effect.Effect<void> =>
        Effect.gen(function* () {
          const set = (yield* Ref.get(byThread)).get(threadId) ?? new Set<string>();
          yield* Ref.update(tokens, (map) => {
            const next = new Map(map);
            for (const token of set) next.delete(token);
            return next;
          });
          yield* Ref.update(byThread, (map) => {
            const next = new Map(map);
            next.delete(threadId);
            return next;
          });
        });

      /** Whether the bearer's session has the browser tools; unknown bearers do. */
      const browserToolsFor = (bearer: string | undefined): Effect.Effect<boolean> =>
        bearer === undefined
          ? Effect.succeed(true)
          : Effect.map(Ref.get(tokens), (map) => map.get(bearer)?.browser ?? true);

      const handleToolsCall = (
        threadId: ThreadId,
        id: unknown,
        params: unknown,
        bearer: string | undefined,
      ): Effect.Effect<Record<string, unknown>> =>
        Effect.gen(function* () {
          if (!isRecord(params) || typeof params.name !== "string") {
            return jsonRpcError(id, -32602, "tools/call requires params.name");
          }
          const name = params.name;
          if (BROWSER_TOOLS.every((tool) => tool.name !== name)) {
            return jsonRpcError(id, -32602, `unknown tool: ${name}`);
          }
          if (!(yield* browserToolsFor(bearer))) {
            return jsonRpcResult(id, {
              content: [{ type: "text", text: BROWSER_PLUGIN_OFF_MESSAGE }],
              isError: true,
              structuredContent: { error: BROWSER_PLUGIN_OFF_MESSAGE },
            });
          }
          const outcome = yield* browser.callTool(threadId, name, params.arguments ?? {});
          const content: Array<Record<string, unknown>> = [
            { type: "text", text: outcomeText(outcome) },
          ];
          if (outcome.kind === "ok" && outcome.image !== undefined) {
            content.push({
              type: "image",
              data: outcome.image.data,
              mimeType: outcome.image.mediaType,
            });
          }
          return jsonRpcResult(id, {
            content,
            isError: outcome.kind === "error",
            structuredContent:
              outcome.kind === "ok"
                ? capStructured(outcome.data)
                : outcome.kind === "interrupted"
                  ? { status: "interrupted_by_human" }
                  : { error: capText(outcome.message) },
          });
        });

      const handleMessage = (
        threadId: ThreadId,
        message: JsonRpcRequest,
        bearer?: string,
      ): Effect.Effect<Record<string, unknown> | null> => {
        const method = message.method;
        if (method === undefined || typeof method !== "string") {
          return Effect.succeed(jsonRpcError(message.id, -32600, "missing method"));
        }
        if (method.startsWith("notifications/") || method === "initialized") {
          return Effect.succeed(null);
        }
        if (message.id === undefined) {
          // A notification that isn't in the notifications/* namespace —
          // acknowledged, nothing to send back.
          return Effect.succeed(null);
        }
        switch (method) {
          case "initialize":
            return Effect.succeed(
              jsonRpcResult(message.id, {
                protocolVersion: negotiateVersion(message.params),
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: "poseidon", version: "1" },
              }),
            );
          case "ping":
            return Effect.succeed(jsonRpcResult(message.id, {}));
          case "tools/list":
            return Effect.map(browserToolsFor(bearer), (browser) =>
              jsonRpcResult(message.id, {
                tools: browser
                  ? BROWSER_TOOLS.map((tool) => ({
                      name: tool.name,
                      description: tool.description,
                      inputSchema: tool.inputSchema,
                      annotations: tool.annotations,
                    }))
                  : [],
              }),
            );
          case "tools/call":
            return handleToolsCall(threadId, message.id, message.params, bearer);
          default:
            return Effect.succeed(jsonRpcError(message.id, -32601, `method not found: ${method}`));
        }
      };

      // Dead sessions and closed threads lose their bearers. The event
      // subscription is opened here and not inside the forked fiber: a PubSub
      // drops what it publishes with nobody listening, and a fork does not run
      // until this fiber yields — a thread closed in that gap would keep a
      // live bearer.
      //
      // It belongs to the reactor, not to this scope: the PubSub is unbounded,
      // so a subscription nobody drains retains every event forever.
      const reactorScope = yield* Scope.make();
      const threadEvents = yield* Scope.provide(reactorScope)(engine.subscribeEvents);
      const endedSessions = manager.lifecycle.pipe(
        Stream.filter((entry) => entry.kind === "ended"),
        Stream.map((entry) => entry.threadId),
      );
      const closedThreads = Stream.fromSubscription(threadEvents).pipe(
        Stream.filter(
          (event) => event.type === "thread.deleted" || event.type === "thread.archived",
        ),
        Stream.map((event) => event.streamId as ThreadId),
      );
      const reactor = Stream.runForEach(Stream.merge(endedSessions, closedThreads), revoke).pipe(
        Effect.catch((error) => Effect.logWarning("mcp gateway revoke reactor ended", error)),
        Effect.ensuring(Scope.close(reactorScope, Exit.void)),
      );
      yield* Effect.forkIn(reactor, scope);

      return McpGateway.of({
        endpoint,
        revoke,
        resolve: (token) =>
          Effect.map(Ref.get(tokens), (map) => Option.fromNullishOr(map.get(token)?.threadId)),
        handleMessage,
      });
    }),
  );
}
