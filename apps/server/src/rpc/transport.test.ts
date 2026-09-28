/**
 * The transport, proven over a real WebSocket:
 *
 * - `server.hello` answers with the boot identity.
 * - A wrong token gets a 401 on the upgrade, before any RPC runs.
 * - Dispatch + subscribe round-trips a real command through the engine.
 * - A client that drops its socket, reconnects and resubscribes with
 *   `afterSequence` receives exactly the events it missed.
 * - A 200-item thread's snapshot stays inside a per-item wire budget, counted
 *   from the bytes the socket actually delivered (transfer-budget test).
 * - `threads.searchMessages` finds a thread by text the engine wrote.
 */

import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  makeCommandId,
  makeItemId,
  makeProjectId,
  makeThreadId,
  makeConnectorInstanceId,
  makeEventId,
  makeTerminalId,
} from "@poseidon/contracts/ids";
import type { Command } from "@poseidon/contracts/orchestration";
import { PoseidonRpcError, PROTOCOL_VERSION, STREAM_BUDGET_BYTES } from "@poseidon/contracts/rpc";
import {
  Connection,
  makeConnection,
  type ConnectionCredentials,
} from "@poseidon/client-runtime/connection";
import { makeFakeConnector } from "@poseidon/testkit/fakeConnector";
import type { ConnectorServices } from "@poseidon/connector-sdk/definition";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { AttachmentStore } from "../attachments/AttachmentStore";
import { layer as directoryBrowserLayer } from "../fs/Directories";
import { McpGateway } from "../mcp/McpGateway";
import { CheckpointHook, CheckpointReactor } from "../orchestration/CheckpointReactor";
import { OrchestrationEngine } from "../orchestration/Engine";
import { ProviderCommandReactor } from "../orchestration/ProviderCommandReactor";
import { ConnectorSelection, SessionManager } from "../orchestration/SessionManager";
import { EventStore } from "../persistence/EventStore";
import { layer as messageSearchLayer } from "../persistence/MessageSearch";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { ScriptDetection } from "../scripts/ScriptDetection";
import { serverLayer, ServerToken } from "./server";
import {
  BrowserService,
  ConnectorCatalog,
  ConnectorExtensions,
  DevServerDiscovery,
  EditorLauncher,
  FileService,
  GitService,
  ServerIdentity,
  SettingsStore,
  TerminalService,
} from "./services";

const TOKEN = "test-token";

/** A real 1x1 PNG: small enough to inline, real enough to pass the sniff. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** Items the transfer-budget thread carries. */
const ITEMS = 200;
/**
 * What one timeline item may cost on the wire. A snapshot item is a short
 * assistant message plus its envelope; anything that pushes past this is a
 * payload that does not belong in a snapshot.
 */
const MAX_BYTES_PER_ITEM = 512;
const INSTANCE_ID = "01900000-0000-7000-8000-000000000000";

const services: Effect.Effect<ConnectorServices> = Effect.clockWith((clock) =>
  Effect.succeed({
    mcpEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/mcp", bearer: "t" }),
    hookEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/hook", bearer: "t" }),
    permissions: { decide: () => Effect.succeed("prompt" as const) },
    attachmentsDir: "/tmp/poseidon-transport-test",
    logger: { log: () => Effect.void },
    clock,
  }),
);

/** Real sqlite + engine + reactors + WS transport on an ephemeral port. */
const testStack = (browserLayer: Layer.Layer<BrowserService> = BrowserService.empty) =>
  Effect.gen(function* () {
    // One sqlite instance feeds persistence, the engine and the settings
    // service — built once so every consumer shares the same connection.
    const sqliteContext = yield* Layer.build(sqliteTestLayer());
    const sqlite = Layer.succeedContext(sqliteContext);
    const fake = yield* makeFakeConnector();
    const instance = yield* fake.definition.createInstance({
      instanceId: makeConnectorInstanceId(),
      config: {},
      services: yield* services,
    });
    const persistence = Layer.mergeAll(
      sqlite,
      Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
    );
    const engineLayer = OrchestrationEngine.layer.pipe(Layer.provide(persistence));
    const selection = ConnectorSelection.fromInstance(instance);
    const managerLayer = SessionManager.layer.pipe(
      Layer.provide(Layer.mergeAll(engineLayer, selection)),
    );
    const reactors = Layer.mergeAll(ProviderCommandReactor, CheckpointReactor).pipe(
      Layer.provide(Layer.mergeAll(engineLayer, managerLayer, CheckpointHook.noop, persistence)),
    );
    const stack = Layer.mergeAll(engineLayer, managerLayer, reactors);
    const serviceLayer = Layer.mergeAll(
      Layer.succeed(ServerIdentity, { serverInstanceId: INSTANCE_ID }),
      Layer.succeed(ServerToken, { token: TOKEN }),
      ConnectorCatalog.empty,
      FileService.empty,
      directoryBrowserLayer,
      GitService.empty,
      browserLayer,
      McpGateway.layer.pipe(Layer.provide(Layer.mergeAll(browserLayer, engineLayer, managerLayer))),
      ConnectorExtensions.empty,
      TerminalService.empty,
      DevServerDiscovery.empty,
      EditorLauncher.empty,
      messageSearchLayer.pipe(Layer.provide(persistence)),
      ScriptDetection.empty,
      AttachmentStore.layerAt(mkdtempSync(NodePath.join(NodeOS.tmpdir(), "poseidon-transport-"))),
      SettingsStore.layer.pipe(Layer.provide(sqlite)),
    );
    const http = NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" });
    const httpContext = yield* Layer.build(http);
    const stackContext = yield* Layer.build(stack);
    const app = serverLayer.pipe(
      Layer.provide(serviceLayer),
      Layer.provide(Layer.succeedContext(Context.merge(httpContext, stackContext))),
    );
    yield* Layer.build(app);
    const address = Context.get(httpContext, HttpServer.HttpServer).address;
    const port =
      typeof address === "object" && address !== null && "port" in address ? address.port : 0;
    return {
      fake,
      engine: Context.get(stackContext, OrchestrationEngine),
      url: `ws://127.0.0.1:${port}/ws`,
    };
  });

/** Sums the bytes the server actually pushed down the socket. */
interface WireMeter {
  bytes: number;
}

const byteLengthOf = (data: unknown): number => {
  if (typeof data === "string") return new TextEncoder().encode(data).length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
};

const connect = (
  url: string,
  token: string,
  options: {
    readonly sockets?: Array<WebSocket>;
    readonly resolve?: Effect.Effect<ConnectionCredentials | null>;
    readonly meter?: WireMeter;
  } = {},
) => {
  const { sockets, resolve, meter } = options;
  const instrument = sockets !== undefined || meter !== undefined;
  return Layer.build(
    makeConnection({
      url,
      token,
      ...(resolve === undefined ? {} : { resolve }),
      ...(instrument
        ? {
            webSocketConstructor: (wsUrl: string) => {
              const ws = new WebSocket(wsUrl);
              sockets?.push(ws);
              if (meter !== undefined) {
                ws.addEventListener("message", (event) => {
                  meter.bytes += byteLengthOf(event.data);
                });
              }
              return ws;
            },
          }
        : {}),
    }),
  ).pipe(Effect.map((ctx) => Context.get(ctx, Connection)));
};

const projectId = makeProjectId();
const threadId = makeThreadId();

const createProject: Command = {
  commandId: makeCommandId(),
  createdAt: "2026-01-01T00:00:00.000Z",
  type: "project.create",
  projectId,
  name: "demo",
  workspaceRoot: "/repo",
};

const createThread: Command = {
  commandId: makeCommandId(),
  createdAt: "2026-01-01T00:00:01.000Z",
  type: "thread.create",
  threadId,
  projectId,
  settings: { model: "fake/model" },
};

describe("transport", () => {
  it.live("server.hello answers with protocol version and instance id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* testStack();
        const connection = yield* connect(url, TOKEN);
        const client = yield* connection.client;
        const hello = yield* client["server.hello"]({});
        expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);
        expect(hello.serverInstanceId).toBe(INSTANCE_ID);
      }),
    ),
  );

  it.live("an image goes up, comes back, and never rides the command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* testStack();
        const connection = yield* connect(url, TOKEN);
        const client = yield* connection.client;
        yield* client["orchestration.dispatch"]({ command: createProject });
        yield* client["orchestration.dispatch"]({ command: createThread });

        const staged = yield* client["attachments.stage"]({
          threadId,
          name: "shot.png",
          base64: PNG_BASE64,
        });
        expect(staged.mime).toBe("image/png");
        expect(staged.size).toBe(70);

        const back = yield* client["attachments.read"]({ threadId, path: staged.path });
        expect(back.base64).toBe(PNG_BASE64);

        // The turn carries the reference the staging answered with, and the
        // event the decider wrote carries exactly that — no bytes.
        yield* client["orchestration.dispatch"]({
          command: {
            commandId: makeCommandId(),
            createdAt: "2026-01-01T00:00:02.000Z",
            type: "thread.turn.start",
            threadId,
            text: "what is this?",
            attachments: [staged],
            mentions: [],
            queued: false,
          },
        });
        const snapshot = yield* Stream.runHead(client["threads.subscribe"]({ threadId }));
        const frame = Option.isSome(snapshot) ? snapshot.value : null;
        const row =
          frame?.kind === "snapshot"
            ? frame.snapshot.items.find((item) => item.kind === "user_message")
            : undefined;
        expect(row?.attachments).toEqual([staged]);
        expect(JSON.stringify(row)).not.toContain(PNG_BASE64);
      }),
    ),
  );

  it.live("connection.client resolves on every call within one connection epoch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* testStack();
        const connection = yield* connect(url, TOKEN);
        const client = yield* connection.client;
        yield* client["orchestration.dispatch"]({ command: createProject });

        // The regression: `.client` used to install an unresolved deferred on
        // connect, so a second call in the same epoch hung until the next
        // reconnect. It must resolve immediately with the live client.
        const again = yield* connection.client.pipe(Effect.timeout("5 seconds"));
        const receipt = yield* again["orchestration.dispatch"]({ command: createThread });
        expect(receipt.status).toBe("accepted");
      }),
    ),
  );

  it.live("a reconnect re-resolves the credentials instead of reusing stale ones", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* testStack();
        // Stands in for a server that has restarted since the renderer booted:
        // the credentials the layer was built with are dead, and only the
        // channel knows the live ones. Each attempt re-reads them, so the
        // supervisor's replacement server is reachable without a reload.
        const stale = { url: "ws://127.0.0.1:1/ws", token: "dead-token" };
        const live = yield* Ref.make<ConnectionCredentials | null>(null);
        const connection = yield* connect(stale.url, stale.token, { resolve: Ref.get(live) });

        // Nothing answers yet: the layer keeps failing over the dead port.
        yield* SubscriptionRef.changes(connection.state).pipe(
          Stream.filter((state) => state.status === "reconnecting"),
          Stream.runHead,
          Effect.timeout("5 seconds"),
        );

        yield* Ref.set(live, { url, token: TOKEN });
        const client = yield* connection.client.pipe(Effect.timeout("10 seconds"));
        const hello = yield* client["server.hello"]({}).pipe(Effect.timeout("10 seconds"));
        expect(hello.serverInstanceId).toBe(INSTANCE_ID);
      }),
    ),
  );

  it.live("a dropped socket keeps the known boot id so the resume is not discarded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* testStack();
        const sockets: Array<WebSocket> = [];
        const connection = yield* connect(url, TOKEN, { sockets });
        const client = yield* connection.client;
        const hello = yield* client["server.hello"]({});
        // What `markConnected` records once `server.hello` answers.
        yield* SubscriptionRef.set(connection.state, {
          status: "connected",
          serverInstanceId: hello.serverInstanceId,
        });

        sockets.forEach((ws) => ws.close());
        const dropped = yield* SubscriptionRef.changes(connection.state).pipe(
          Stream.filter((state) => state.status === "reconnecting"),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        );
        // Nulling it here would make every reconnect look like a restart, so
        // every subscription would resnapshot instead of resuming.
        expect(dropped[0]?.serverInstanceId).toBe(INSTANCE_ID);
      }),
    ),
  );

  it.live("browser.humanInput failures reach the client as RPC errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failingBrowser = Layer.succeed(
          BrowserService,
          BrowserService.of({
            subscribe: () => Stream.never,
            humanInput: () => Effect.fail(new Error("cdp connect refused")),
            callTool: () => Effect.succeed({ kind: "error", message: "cdp connect refused" }),
            teardown: () => Effect.void,
            status: { mode: "in-app", installed: true, version: "agent-browser 0.38.1" },
          }),
        );
        const { url } = yield* testStack(failingBrowser);
        const connection = yield* connect(url, TOKEN);
        const client = yield* connection.client;
        const error = yield* client["browser.humanInput"]({
          threadId,
          input: { kind: "text", text: "hi" },
        }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(PoseidonRpcError);
        if (error instanceof PoseidonRpcError) {
          expect(error.code).toBe("internal");
          // The internal detail must not leak into the wire message.
          expect(error.message).toBe("internal error");
          expect(error.message).not.toContain("cdp");
        }
      }),
    ),
  );

  it.live("the terminal surface answers over the wire with no shells behind it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* testStack();
        const connection = yield* connect(url, TOKEN);
        const client = yield* connection.client;
        const terminalId = makeTerminalId();
        expect(yield* client["terminal.list"]({ threadId })).toEqual([]);
        const items = yield* client["terminal.subscribe"]({ threadId, terminalId }).pipe(
          Stream.runCollect,
        );
        expect(items).toEqual([]);
        const error = yield* client["terminal.open"]({
          threadId,
          terminalId,
          cols: 80,
          rows: 24,
        }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(PoseidonRpcError);
        if (error instanceof PoseidonRpcError) {
          expect(error.code).toBe("unavailable");
        }
      }),
    ),
  );

  it.live("a wrong token gets a 401 on the upgrade", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* testStack();
        const httpUrl = url.replace(/^ws/, "http");
        const denied = yield* Effect.promise(() =>
          fetch(`${httpUrl}?token=wrong`).then((r) => r.status),
        );
        const missing = yield* Effect.promise(() => fetch(httpUrl).then((r) => r.status));
        // The comparison is constant-time over equal-length buffers, so a
        // wrong token of the same length and an empty one must both 401
        // rather than throw out of the guard.
        const sameLength = yield* Effect.promise(() =>
          fetch(`${httpUrl}?token=${"x".repeat(TOKEN.length)}`).then((r) => r.status),
        );
        const empty = yield* Effect.promise(() => fetch(`${httpUrl}?token=`).then((r) => r.status));
        expect(denied).toBe(401);
        expect(missing).toBe(401);
        expect(sameLength).toBe(401);
        expect(empty).toBe(401);
      }),
    ),
  );

  it.live("dispatch + subscribe round-trips a command through the engine", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* testStack();
        const connection = yield* connect(url, TOKEN);
        const client = yield* connection.client;
        yield* client["orchestration.dispatch"]({ command: createProject });
        const receipt = yield* client["orchestration.dispatch"]({ command: createThread });
        expect(receipt.status).toBe("accepted");

        const kinds = yield* client["threads.subscribe"]({ threadId }).pipe(
          Stream.map((item) => item.kind),
          Stream.take(2),
          Stream.runCollect,
        );
        expect(kinds).toEqual(["snapshot", "synchronized"]);
      }),
    ),
  );

  it.live("a reconnected client receives exactly the missed events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, engine } = yield* testStack();
        const sockets: Array<WebSocket> = [];
        const connection = yield* connect(url, TOKEN, { sockets });
        const client = yield* connection.client;
        yield* client["orchestration.dispatch"]({ command: createProject });
        yield* client["orchestration.dispatch"]({ command: createThread });

        // Subscribe and drain the snapshot so the client holds sequence 3.
        yield* client["threads.subscribe"]({ threadId }).pipe(
          Stream.take(2),
          Stream.runDrain,
          Effect.timeout("5 seconds"),
        );

        // Drop the socket and wait for the supervisor to observe it — until
        // the state flips to "reconnecting", `.client` can still hand out the
        // dying epoch's client (the close handshake is async).
        sockets.forEach((ws) => ws.close());
        yield* SubscriptionRef.changes(connection.state).pipe(
          Stream.filter((state) => state.status === "reconnecting"),
          Stream.runHead,
          Effect.timeout("5 seconds"),
        );
        yield* engine.appendThreadEvents(threadId, [
          {
            eventId: makeEventId(),
            streamKind: "thread",
            streamId: threadId,
            occurredAt: "2026-01-01T00:00:02.000Z",
            type: "thread.message.queued",
            actor: "user",
            payload: {
              message: {
                queuedMessageId: makeItemId(),
                text: "missed while offline",
                attachments: [],
                mentions: [],
                queuedAt: "2026-01-01T00:00:02.000Z",
              },
            },
          },
        ]);

        // Resubscribe from the snapshot position (2) on the fresh client →
        // exactly the one missed event (sequence 3).
        const reconnected = yield* connection.client;
        const missed = yield* reconnected["threads.subscribe"]({
          threadId,
          afterSequence: 2,
        }).pipe(
          Stream.filter((item) => item.kind === "event"),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        );
        expect(missed[0]?.kind).toBe("event");
        if (missed[0]?.kind === "event") {
          expect(missed[0].event.type).toBe("thread.message.queued");
        }
      }),
    ),
  );

  it.live("a 200-item snapshot stays inside the per-item wire budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, engine } = yield* testStack();
        const meter: WireMeter = { bytes: 0 };
        const connection = yield* connect(url, TOKEN, { meter });
        const client = yield* connection.client;
        yield* client["orchestration.dispatch"]({ command: createProject });
        yield* client["orchestration.dispatch"]({ command: createThread });

        for (let i = 0; i < ITEMS; i += 1) {
          yield* engine.appendThreadEvents(threadId, [
            {
              eventId: makeEventId(),
              streamKind: "thread",
              streamId: threadId,
              occurredAt: "2026-01-01T00:00:00.000Z",
              type: "thread.item.upserted",
              actor: "connector",
              payload: {
                item: {
                  itemId: makeItemId(),
                  kind: "assistant_message",
                  status: "completed",
                  text: `chunk ${i}`,
                },
              },
            },
          ]);
        }

        // Everything the dispatches cost is already on the meter; only what
        // the subscription adds counts against the per-item budget.
        const before = meter.bytes;
        const frames = yield* client["threads.subscribe"]({ threadId }).pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        );
        const bytes = meter.bytes - before;
        expect(frames[0]?.kind).toBe("snapshot");
        expect(frames[1]?.kind).toBe("synchronized");
        expect(bytes).toBeLessThan(STREAM_BUDGET_BYTES);
        // The real guardrail: 8 MiB is four orders of magnitude above what a
        // 200-item thread costs, so the budget alone can never catch a
        // snapshot that starts carrying whole file bodies or base64 images.
        expect(bytes / ITEMS).toBeLessThan(MAX_BYTES_PER_ITEM);
      }),
    ),
  );

  it.live("threads.searchMessages finds a thread by the text the engine wrote", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, engine } = yield* testStack();
        const connection = yield* connect(url, TOKEN);
        const client = yield* connection.client;
        yield* client["orchestration.dispatch"]({ command: createProject });
        yield* client["orchestration.dispatch"]({ command: createThread });
        const itemId = makeItemId();
        yield* engine.appendThreadEvents(threadId, [
          {
            eventId: makeEventId(),
            streamKind: "thread",
            streamId: threadId,
            occurredAt: "2026-01-01T00:00:02.000Z",
            type: "thread.item.upserted",
            actor: "connector",
            payload: {
              item: {
                itemId,
                kind: "assistant_message",
                status: "completed",
                text: "The lantern flickers because the wick is too short.",
              },
            },
          },
        ]);

        const hits = yield* client["threads.searchMessages"]({ query: "LANTERN" });
        expect(hits).toEqual([
          {
            threadId,
            projectId,
            title: expect.any(String),
            archived: false,
            itemId,
            role: "assistant",
            snippet: "The lantern flickers because the wick is too short.",
          },
        ]);
        expect(yield* client["threads.searchMessages"]({ query: "la" })).toEqual([]);
        expect(yield* client["threads.searchMessages"]({ query: "candle" })).toEqual([]);
      }),
    ),
  );
});
