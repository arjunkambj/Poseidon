/**
 * The server's composition root.
 *
 * Everything the running app is made of is assembled here — SQLite persistence,
 * the orchestration engine, session drivers, reactors and supervisor, the
 * connector registry and its manager, the browser + MCP gateway, the
 * integrated terminal's shells, the RPC handlers and the HTTP+WebSocket
 * server — so that `main.ts` is only argument parsing and a runtime call, and
 * a test can build the very same graph.
 *
 * `boot` is scoped: closing the scope it was run in shuts the server, the
 * database, every open connector instance and every terminal's shell down.
 * It returns once the handshake has been emitted, which is also the moment the
 * first client may connect.
 */

import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import {
  makeClaudeConnectorDefinition,
  type ClaudeConnectorOptions,
} from "@poseidon/connector-claude/definition";
import { makeCmdConnectorDefinition } from "@poseidon/connector-cmd/definition";
import {
  makeCodexConnectorDefinition,
  type CodexConnectorOptions,
} from "@poseidon/connector-codex/definition";
import { eraseConnectorDefinition } from "@poseidon/connector-sdk/definition";
import { makeRegistry } from "@poseidon/connector-sdk/registry";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import { POSEIDON_HOME_ENV } from "@poseidon/shared/paths";
import { uuidV7 } from "@poseidon/shared/ids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AttachmentReactor } from "./attachments/AttachmentReactor";
import { AttachmentStore } from "./attachments/AttachmentStore";
import { AgentBrowser } from "./browser/agentBrowser";
import { layer as browserServiceLayer } from "./browser/BrowserService";
import { layer as devServerDiscoveryLayer } from "./browser/discovery";
import { HookBridge } from "./hooks/HookBridge";
import { McpGateway } from "./mcp/McpGateway";
import { CheckpointReactor } from "./orchestration/CheckpointReactor";
import { OrchestrationEngine } from "./orchestration/Engine";
import { ProviderCommandReactor } from "./orchestration/ProviderCommandReactor";
import { ConnectorSelection, SessionManager } from "./orchestration/SessionManager";
import { makeSessionSupervisor } from "./orchestration/SessionSupervisor";
import { threadWorkspaceRoot } from "./orchestration/workspaceRoot";
import { EventStore } from "./persistence/EventStore";
import { ReadModelStore } from "./persistence/ReadModels";
import { defaultLayer as sqliteLayer } from "./persistence/Sqlite";
import { PermissionService } from "./permissions/PermissionService";
import { PluginRegistry } from "./plugins/PluginRegistry";
import { layer as editorLauncherLayer } from "./editors/EditorLauncher";
import { layer as messageSearchLayer } from "./persistence/MessageSearch";
import { layer as directoryBrowserLayer } from "./fs/Directories";
import { layer as gitCheckpointHookLayer } from "./git/CheckpointHook";
import { layer as fileServiceLayer } from "./git/Files";
import { TextGeneration } from "./generation/TextGeneration";
import { TitleReactor } from "./generation/TitleReactor";
import { layer as gitServiceLayer } from "./git/Git";
import { GhRunner } from "./git/GitHubCli";
import { WorktreesRoot } from "./git/Worktrees";
import { writeHandshake } from "./rpc/bootstrap";
import { layer as scriptDetectionLayer } from "./scripts/ScriptDetection";
import { layer as terminalServiceLayer } from "./terminal/TerminalService";
import { serverLayer, ServerToken } from "./rpc/server";
import { ServerIdentity, SettingsStore } from "./rpc/services";
import { layer as connectorExtensionsLayer } from "./settings/ConnectorExtensions";
import { ConnectorHost } from "./settings/ConnectorHost";
import { ConnectorManager, ConnectorRegistryService } from "./settings/ConnectorManager";
import { ConnectorModels, OpenConnectors, routingPreference } from "./settings/connectorRouting";

/** @public The composition root's options; `main.ts` fills them from argv. */
export interface BootOptions {
  /**
   * Where the server keeps its state. This is the process-wide `POSEIDON_HOME`:
   * the database, the attachments directory, the generated hook script and the
   * dev connection file all hang off it, and spawned connector processes
   * inherit it, so `boot` sets the variable rather than threading a second
   * notion of "home" through the tree. Omitted, whatever the environment
   * already says wins (`~/.poseidon` by default).
   */
  readonly home?: string;
  /** Dev mode also writes `<home>/dev/connection.json` for the Vite plugin. */
  readonly dev: boolean;
  /** `0` — the default — asks the OS for a free port. */
  readonly port?: number;
  /**
   * Where the Command Code connector finds the *harness's* own configuration —
   * `~/.commandcode` by default, and not to be confused with `home`, which is
   * ours.
   *
   * The Customize page reads and writes the user's MCP and skills files
   * through the connector's extensions, so this is the one thing
   * `POSEIDON_HOME` cannot move: an end-to-end test that adds an MCP server
   * would otherwise edit the operator's real config. Production leaves it
   * unset.
   */
  readonly commandCodeHome?: string;
  /**
   * Options for the Claude Code connector. The end-to-end harness sets the
   * caps a recording or a live run puts on every session (`maxTurns`,
   * `maxBudgetUsd`), so a test cannot spend beyond them. Production leaves it
   * unset.
   */
  readonly claudeCode?: ClaudeConnectorOptions;
  /**
   * Options for the Codex connector — chiefly `codexHome`, the `CODEX_HOME`
   * its skills and MCP server extensions read and write, so a test that edits
   * MCP servers from the Customize page never touches the operator's own
   * `~/.codex`. Production leaves it unset.
   */
  readonly codex?: CodexConnectorOptions;
}

/** @public What a booted server tells a client (or the desktop shell) about itself. */
export interface BootedServer {
  readonly url: string;
  readonly token: string;
  readonly serverInstanceId: string;
}

/**
 * Builds and starts the whole server in the calling scope.
 *
 * @public Imported by `main.ts` and by end-to-end tests that drive a real
 * server; nothing else should compose these layers itself.
 */
export const boot = (options: BootOptions) =>
  Effect.gen(function* () {
    if (options.home !== undefined) {
      // Before anything reads a path: `configDir` and everything built on it
      // resolve this at call time, and connector children inherit it.
      yield* Effect.sync(() => {
        process.env[POSEIDON_HOME_ENV] = options.home;
      });
    }
    const port = options.port ?? 0;
    const token = uuidV7();
    const serverInstanceId = uuidV7();

    // One sqlite client for the whole process. Every layer that reads a table
    // provides `Migrations.layer`, so the schema exists before the first read —
    // including the connector manager's, which reconciles against the settings
    // table as it is constructed.
    const sqliteContext = yield* Layer.build(sqliteLayer());
    const sqlite = Layer.succeedContext(sqliteContext);

    const persistence = Layer.mergeAll(
      sqlite,
      Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
    );
    // Order is routing order on a fresh install: every definition is seeded as
    // an instance in this order, and a thread that names none runs on the first
    // enabled one. Command Code stays first, then Claude Code, so adding a
    // connector changes no existing default.
    const registry = yield* makeRegistry([
      eraseConnectorDefinition(
        makeCmdConnectorDefinition(
          options.commandCodeHome === undefined ? {} : { commandCodeHome: options.commandCodeHome },
        ),
      ),
      eraseConnectorDefinition(makeClaudeConnectorDefinition(options.claudeCode ?? {})),
      eraseConnectorDefinition(makeCodexConnectorDefinition(options.codex ?? {})),
    ]);
    // Routing follows the connectors page's own order, not the order instances
    // happened to be opened in — the same reading the engine seeds a new
    // thread's model from, so the two always name one instance. Both also skip
    // an enabled entry that never opened, so a thread routed past a broken
    // connector is not started on that connector's model.
    const openConnectors = Effect.map(registry.instances, (instances) =>
      instances.map((instance) => instance.instanceId),
    );
    // The last word on "what model does a new thread start on" when the
    // settings document holds none: the instance's own list. A fresh install
    // has no default anywhere, and without this every `thread.create` was
    // rejected. It is only reached on that path, so the extra call the
    // connector makes to answer costs nothing once a default exists.
    const connectorModels = (instanceId: ConnectorInstanceId) =>
      registry.instance(instanceId).pipe(
        Effect.flatMap((instance) => instance.listModels()),
        Effect.map((models) => models.map((model) => model.id)),
        Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<string>)),
      );
    const engine = OrchestrationEngine.layer.pipe(
      Layer.provide(persistence),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OpenConnectors, openConnectors),
          Layer.succeed(ConnectorModels, connectorModels),
        ),
      ),
    );
    const selection = ConnectorSelection.fromRegistry(
      registry,
      routingPreference(Context.get(sqliteContext, SqlClient.SqlClient)),
    );
    const manager = SessionManager.layer.pipe(Layer.provide(Layer.mergeAll(engine, selection)));
    const attachments = AttachmentStore.layer;
    const reactors = Layer.mergeAll(
      ProviderCommandReactor,
      CheckpointReactor,
      AttachmentReactor,
      makeSessionSupervisor({}),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(engine, manager, gitCheckpointHookLayer, persistence, attachments),
      ),
    );

    // The settings store and the connector manager share one graph: the manager
    // watches the same store instance the RPC handlers mutate, and the catalog
    // answers from the manager's probes. Built once inside `services`.
    const sharedSettings = ConnectorManager.catalogLayer.pipe(
      Layer.provideMerge(
        ConnectorManager.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              SettingsStore.layer,
              ConnectorHost.layer,
              Layer.succeed(ConnectorRegistryService, registry),
            ),
          ),
        ),
      ),
      Layer.provide(sqlite),
    );

    // Browser sessions + the MCP gateway. `browser` is shared by the RPC
    // handlers and the gateway (the layer graph memoizes it, so both see the
    // one session registry); HttpServer flows in from the outermost provide for
    // the gateway's endpoint URL.
    const permissions = PermissionService.layer.pipe(Layer.provide(sqlite));
    const browser = browserServiceLayer.pipe(
      Layer.provide(Layer.mergeAll(engine, permissions, AgentBrowser.layer)),
    );
    // Over the same settings store, so a plugin switched on the plugins page
    // reaches `settings.subscribe` like any other setting. The gateway reads
    // it too: a session minted with the Browser plugin off gets no browser tools.
    const pluginRegistry = PluginRegistry.layer.pipe(Layer.provide(sharedSettings));
    const mcp = McpGateway.layer.pipe(
      Layer.provide(Layer.mergeAll(browser, engine, manager, pluginRegistry)),
    );

    const services = Layer.mergeAll(
      Layer.succeed(ServerIdentity, { serverInstanceId }),
      Layer.succeed(ServerToken, { token }),
      sharedSettings,
      fileServiceLayer.pipe(Layer.provide(persistence)),
      directoryBrowserLayer,
      editorLauncherLayer.pipe(Layer.provide(persistence)),
      messageSearchLayer.pipe(Layer.provide(persistence)),
      scriptDetectionLayer.pipe(Layer.provide(persistence)),
      // `sharedSettings` again, not a second SettingsStore: one build memoizes
      // it, so the prefix and setup scripts are read from the store the
      // settings RPCs write.
      gitServiceLayer.pipe(
        Layer.provide(
          Layer.mergeAll(persistence, GhRunner.layer, WorktreesRoot.layer, sharedSettings),
        ),
      ),
      attachments,
      browser,
      devServerDiscoveryLayer.pipe(Layer.provide(persistence)),
      mcp,
      // The engine is the same memoized layer the rest of the graph uses, so
      // the teardown reactor hears the thread.deleted every command produces.
      terminalServiceLayer.pipe(Layer.provide(engine)),
      connectorExtensionsLayer.pipe(
        Layer.provide(
          Layer.mergeAll(persistence, Layer.succeed(ConnectorRegistryService, registry)),
        ),
      ),
      // SettingsStore is not listed here: `sharedSettings` already merges the one
      // instance the manager watches and the RPC handlers mutate.
      permissions,
      pluginRegistry,
      // Generated text resolves its writer through the same registry and
      // settings store as everything else; the title reactor rides along,
      // listening to the one engine every command goes through.
      TitleReactor.pipe(
        Layer.provideMerge(
          TextGeneration.layer.pipe(Layer.provide(Layer.mergeAll(persistence, sharedSettings))),
        ),
        Layer.provide(Layer.mergeAll(engine, sharedSettings)),
      ),
    );

    // ── Shutting down with clients attached ──
    //
    // `http.Server.close()` stops accepting and then waits for every open
    // connection to end by itself. A WebSocket never does — that is what it is
    // for — so a server with a renderer attached simply never finished closing,
    // and the scope that owned it hung forever. Nothing noticed while the only
    // shutdown in the product was the supervisor killing the process, but
    // `boot`'s contract is that closing its scope shuts the server down, and
    // the dev loop and the end-to-end suite both take it at its word.
    //
    // So the sockets are hung up first. They are tracked from `connection`
    // rather than through `closeAllConnections()`, because a socket that has
    // been upgraded no longer belongs to the server that accepted it — which
    // is exactly the socket in the way.
    const sockets = new Set<import("node:net").Socket>();
    const http = NodeHttpServer.layer(
      () => {
        const server = createServer();
        server.on("connection", (socket) => {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
        });
        return server;
      },
      { port, host: "127.0.0.1" },
    );

    // ── One build, one instance of everything ──
    //
    // The whole graph is built by a single `Layer.build`, and every piece the
    // entrypoint needs afterwards comes back in that one context. This is not a
    // tidiness preference: `Layer.build` memoizes per call, so a layer handed to
    // two separate builds is *constructed twice*. `engine` and `manager` are
    // reachable from both the services (through the browser service and the MCP
    // gateway) and the server (through the RPC handlers and the reactors), and
    // splitting the build gave the process two `OrchestrationEngine`s and two
    // `SessionManager`s. They shared the database, so reads agreed and nothing
    // looked wrong — but their PubSubs did not: the gateway's bearer-revoke
    // reactor and the browser teardown reactor listened to the copy no command
    // was ever dispatched through, so closing a thread revoked nothing and tore
    // nothing down. Nesting the provides keeps the construction order the same
    // (the HTTP server is listening before the gateway reads its address).
    const app = serverLayer.pipe(
      Layer.provideMerge(services),
      Layer.provideMerge(Layer.mergeAll(engine, manager, reactors)),
      Layer.provideMerge(http),
    );

    const appContext = yield* Layer.build(app);
    // Added after the build, so it runs *before* the layer finalizers that
    // close the server: finalizers run in reverse order of acquisition.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
      }),
    );
    const server = Context.get(appContext, HttpServer.HttpServer);
    const address = server.address;
    const boundPort =
      typeof address === "object" && address !== null && "port" in address ? address.port : port;

    // ── Connectors: the endpoints only the running app can supply ──
    //
    // `ConnectorManager` owns the connector lifecycle — seeding a fresh install,
    // probing, and opening one instance per enabled settings entry — and it does
    // that while the layer graph is built, before the pieces below exist. So the
    // services object it already handed those instances is `ConnectorHost`'s
    // façade, and this fills it in: the gateway's per-thread MCP endpoint, the
    // hook bridge's endpoint and handler registry, and a permission ladder that
    // resolves the thread's project (its rules) and the thread's own directory
    // before it decides. It runs before the handshake, so no client can start
    // a session against a half-wired host.
    const bridge = Context.get(appContext, HookBridge);
    const engineService = Context.get(appContext, OrchestrationEngine);
    const permissionService = Context.get(appContext, PermissionService);
    const gateway = Context.get(appContext, McpGateway);
    const connectorHost = Context.get(appContext, ConnectorHost);
    const plugins = Context.get(appContext, PluginRegistry);

    // Written here, not when the registry's layer is built: tests build the
    // layers, and the built-in folder lives under `POSEIDON_HOME`.
    yield* plugins.materializeBuiltins;

    yield* connectorHost.install({
      sessionPlugins: plugins.sessionPlugins,
      mcpEndpoint: gateway.endpoint,
      hookEndpoint: (threadId) => bridge.endpointFor(threadId),
      registerHookHandler: (threadId, handler) => bridge.register(threadId, handler),
      unregisterHookHandler: (threadId) => bridge.unregister(threadId),
      permissions: {
        decide: (input) =>
          Effect.gen(function* () {
            const doc = yield* engineService.threadDoc(input.threadId);
            const project = doc === null ? null : yield* engineService.projectDoc(doc.projectId);
            return yield* permissionService.decide({
              request: input.request,
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              threadId: input.threadId,
              ...(doc === null ? {} : { projectId: doc.projectId }),
              // The thread's own root: a worktree thread's sensitive paths are
              // judged against the directory its harness actually runs in.
              ...(doc === null || project === null
                ? {}
                : { workspaceRoot: threadWorkspaceRoot(doc, project) }),
            });
          }).pipe(
            // A permissions failure must never read as allow.
            Effect.catch((error) =>
              Effect.logWarning("permission decide failed; prompting", error).pipe(
                Effect.as("prompt" as const),
              ),
            ),
          ),
      },
    });

    // The manager's first pass registers every enabled instance before it probes,
    // and this waits for it: `ConnectorSelection` reads the live registry, so a
    // client admitted before that pass lands would fail its first turn with
    // `NoConnector`. Probes keep running behind the handshake.
    yield* Context.get(appContext, ConnectorManager).ready;

    const handshake: BootedServer = {
      url: `ws://127.0.0.1:${boundPort}/ws`,
      token,
      serverInstanceId,
    };
    yield* writeHandshake(handshake, { dev: options.dev });
    return handshake;
  });
