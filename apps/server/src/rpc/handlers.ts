/**
 * Wires `PoseidonRpcGroup` to services. Orchestration reads and writes go to
 * the engine; every other surface resolves to its Tag service, so one can be
 * swapped without touching this file.
 */

import { PoseidonRpcError, PoseidonRpcGroup, PROTOCOL_VERSION } from "@poseidon/contracts/rpc";
import type { Command } from "@poseidon/contracts/orchestration";
import { terminalOwnerOf } from "@poseidon/contracts/terminal";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { AttachmentStore } from "../attachments/AttachmentStore";
import { ConcurrencyConflict } from "../persistence/EventStore";
import { OrchestrationEngine } from "../orchestration/Engine";
import {
  BrowserService,
  ConnectorCatalog,
  ConnectorExtensions,
  DevServerDiscovery,
  DirectoryBrowser,
  FileService,
  GitService,
  ServerIdentity,
  SettingsStore,
  TerminalService,
} from "./services";

const toRpcError = (error: unknown): PoseidonRpcError =>
  error instanceof PoseidonRpcError
    ? error
    : error instanceof ConcurrencyConflict
      ? new PoseidonRpcError({
          code: "conflict",
          message: `stale stream version for ${error.streamId}: ${error.message}`,
        })
      : // Internal details (SQL, paths) stay server-side; the client only
        // learns that something failed.
        new PoseidonRpcError({ code: "internal", message: "internal error" });

/** The RPC handler layer — every method in the group, one implementation each. */
export const handlersLayer = PoseidonRpcGroup.toLayer(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngine;
    const identity = yield* ServerIdentity;
    const connectors = yield* ConnectorCatalog;
    const files = yield* FileService;
    const directories = yield* DirectoryBrowser;
    const git = yield* GitService;
    const browser = yield* BrowserService;
    const devServers = yield* DevServerDiscovery;
    const settings = yield* SettingsStore;
    const extensions = yield* ConnectorExtensions;
    const attachments = yield* AttachmentStore;
    const terminals = yield* TerminalService;

    return {
      "server.hello": () =>
        Effect.succeed({
          protocolVersion: PROTOCOL_VERSION,
          serverInstanceId: identity.serverInstanceId,
        }),

      "orchestration.dispatch": ({ command }: { command: Command }) =>
        engine.dispatch(command).pipe(Effect.mapError(toRpcError)),

      "projects.list": () => engine.listProjects().pipe(Effect.mapError(toRpcError)),

      "threads.list": ({ projectId, includeArchived }) =>
        engine.listThreads(projectId, includeArchived ?? false).pipe(Effect.mapError(toRpcError)),

      "threads.subscribe": ({ threadId, afterSequence }) =>
        Stream.unwrap(
          engine
            .subscribeThread(threadId, afterSequence === undefined ? {} : { afterSequence })
            .pipe(Effect.mapError(toRpcError)),
        ),

      "threads.listSubscribe": ({ projectId, afterSequence }) =>
        Stream.unwrap(
          engine
            .subscribeThreadList({
              ...(projectId === undefined ? {} : { projectId }),
              ...(afterSequence === undefined ? {} : { afterSequence }),
            })
            .pipe(Effect.mapError(toRpcError)),
        ),

      "connectors.list": ({ refresh }) => connectors.list(refresh ?? false),
      "connectors.models": ({ instanceId }) => connectors.models(instanceId),
      "connectors.describe": () => connectors.describe,

      "files.search": ({ projectId, threadId, query, limit }) =>
        files.search({ projectId, threadId }, query, limit),
      "files.read": ({ projectId, threadId, path, offset, limit }) =>
        files.read({ projectId, threadId }, path, offset, limit),
      "files.stat": ({ projectId, threadId, paths }) => files.stat({ projectId, threadId }, paths),

      "fs.browse": ({ path, showHidden }) => directories.browse({ path, showHidden }),

      "attachments.stage": ({ threadId, name, base64 }) =>
        attachments.stage({ threadId, name, base64 }),
      "attachments.read": ({ threadId, path }) => attachments.read(threadId, path),

      "git.status": ({ projectId, threadId }) => git.status({ projectId, threadId }),
      "git.diff": ({ projectId, threadId, from, to, path, mergeBase }) =>
        git.diff({ projectId, threadId }, { from, to, path, mergeBase }),
      "git.branches": ({ projectId, threadId }) => git.branches({ projectId, threadId }),
      "git.branch.create": ({ projectId, threadId, name, from, checkout }) =>
        git.createBranch({ projectId, threadId }, { name, from, checkout }),
      "git.checkout": ({ projectId, threadId, branch }) =>
        git.checkout({ projectId, threadId }, branch),
      "git.commit": ({ projectId, threadId, message, paths }) =>
        git.commit({ projectId, threadId }, { message, paths }),
      "git.push": ({ projectId, threadId }) => git.push({ projectId, threadId }),
      "git.pullRequest.create": ({ projectId, threadId, title, body, base }) =>
        git.createPullRequest({ projectId, threadId }, { title, body, base }),
      "git.worktree.create": ({ projectId, name, baseBranch }) =>
        git.createWorktree(projectId, { name, baseBranch }),
      "git.worktree.list": ({ projectId }) => git.listWorktrees(projectId),
      "git.worktree.remove": ({ projectId, path, force }) =>
        git.removeWorktree(projectId, { path, force: force ?? false }).pipe(Effect.as({})),
      "git.worktree.setup": ({ projectId, path }) => git.setupWorktree(projectId, path),
      "checkpoints.list": ({ projectId, threadId }) => git.checkpoints(projectId, threadId),

      "browser.subscribe": ({ threadId }) => browser.subscribe(threadId),
      "browser.humanInput": ({ threadId, input }) =>
        browser.humanInput(threadId, input).pipe(Effect.mapError(toRpcError), Effect.as({})),
      "browser.discoverServers": ({ threadId }) => devServers.discover(threadId),
      "browser.status": () => Effect.succeed(browser.status),

      "settings.get": () => settings.get,
      "settings.update": ({ patch }) => settings.update(patch).pipe(Effect.mapError(toRpcError)),
      "settings.subscribe": () => settings.changes,

      "connectors.skills.list": ({ instanceId, projectId }) =>
        extensions.skillsList(instanceId, projectId),
      "connectors.skills.available": ({ instanceId }) => extensions.skillsAvailable(instanceId),
      "connectors.skills.link": ({ instanceId, entry }) => extensions.skillsLink(instanceId, entry),
      "connectors.plugins.list": ({ instanceId, projectId }) =>
        extensions.pluginsList(instanceId, projectId),
      "connectors.mcp.list": ({ instanceId, projectId }) =>
        extensions.mcpList(instanceId, projectId),
      "connectors.mcp.add": ({ instanceId, projectId, server }) =>
        extensions.mcpAdd(instanceId, projectId, server),
      "connectors.mcp.remove": ({ instanceId, projectId, scope, name }) =>
        extensions.mcpRemove(instanceId, projectId, scope, name),

      "keybindings.get": () => Effect.map(settings.get, (doc) => doc.keybindings),
      "keybindings.update": ({ keybindings }) =>
        settings.update({ keybindings }).pipe(
          Effect.map((doc) => doc.keybindings),
          Effect.mapError(toRpcError),
        ),

      // Each payload names a thread or a project (`TerminalOwner`); the
      // service is handed that owner and nothing else of the payload.
      "terminal.open": (payload) =>
        terminals.open({
          ...terminalOwnerOf(payload),
          terminalId: payload.terminalId,
          cols: payload.cols,
          rows: payload.rows,
          title: payload.title,
        }),
      "terminal.write": (payload) =>
        terminals
          .write(terminalOwnerOf(payload), payload.terminalId, payload.data)
          .pipe(Effect.as({})),
      "terminal.resize": (payload) =>
        terminals
          .resize(terminalOwnerOf(payload), payload.terminalId, payload.cols, payload.rows)
          .pipe(Effect.as({})),
      "terminal.close": (payload) =>
        terminals.close(terminalOwnerOf(payload), payload.terminalId).pipe(Effect.as({})),
      "terminal.list": (payload) => terminals.list(terminalOwnerOf(payload)),
      "terminal.listRunning": () => terminals.listRunning(),
      "terminal.subscribe": (payload) =>
        terminals.subscribe(terminalOwnerOf(payload), payload.terminalId),
      "terminal.adopt": ({ projectId, threadId }) => terminals.adopt(projectId, threadId),
    };
  }),
);
