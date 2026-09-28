/**
 * `connectors.skills.*`, `connectors.plugins.*`, `connectors.commands.*` and
 * `connectors.mcp.*`, answered by the instance the call names.
 *
 * The files these edit belong to the harness, so the code that reads and
 * writes them is the connector's (`connector-sdk/src/extensions.ts`). This
 * layer only routes: it finds the open instance, turns a `projectId` into the
 * workspace root the extension works in, and maps the connector's
 * `ConnectorExtensionFailed` onto the RPC error. An instance that is not open,
 * or that carries no such extension, answers `unavailable`.
 */

import type {
  ConnectorExtensionFailed,
  ConnectorExtensions as InstanceExtensions,
  ExtensionScope,
} from "@poseidon/connector-sdk/extensions";
import type { ConnectorInstanceId, ProjectId } from "@poseidon/contracts/ids";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ReadModelStore } from "../persistence/ReadModels";
import { ConnectorExtensions } from "../rpc/services";
import { ConnectorRegistryService } from "./ConnectorManager";

const fromExtension = (error: ConnectorExtensionFailed) =>
  new PoseidonRpcError({ code: error.code, message: error.message });

const unavailable = (instanceId: ConnectorInstanceId, what: string) =>
  new PoseidonRpcError({
    code: "unavailable",
    message: `connector instance ${instanceId} does not manage ${what}`,
  });

/** @public Wired in `boot.ts`; tests build it over a fake connector. */
export const layer = Layer.effect(
  ConnectorExtensions,
  Effect.gen(function* () {
    const registry = yield* ConnectorRegistryService;
    const readModels = yield* ReadModelStore;

    /** The open instance's extensions; a closed or unknown instance has none. */
    const extensionsOf = (instanceId: ConnectorInstanceId) =>
      registry.instance(instanceId).pipe(
        Effect.map((instance): InstanceExtensions => instance.extensions ?? {}),
        Effect.orElseSucceed((): InstanceExtensions => ({})),
      );

    const need = <A>(instanceId: ConnectorInstanceId, what: string, found: A | undefined) =>
      found === undefined ? Effect.fail(unavailable(instanceId, what)) : Effect.succeed(found);

    const skillsOf = (instanceId: ConnectorInstanceId) =>
      Effect.flatMap(extensionsOf(instanceId), (all) => need(instanceId, "skills", all.skills));

    const pluginsOf = (instanceId: ConnectorInstanceId) =>
      Effect.flatMap(extensionsOf(instanceId), (all) => need(instanceId, "plugins", all.plugins));

    const commandsOf = (instanceId: ConnectorInstanceId) =>
      Effect.flatMap(extensionsOf(instanceId), (all) =>
        need(instanceId, "harness commands", all.commands),
      );

    const mcpOf = (instanceId: ConnectorInstanceId) =>
      Effect.flatMap(extensionsOf(instanceId), (all) =>
        need(instanceId, "MCP servers", all.mcpServers),
      );

    /** The user scope, plus the project's workspace root when one is named. */
    const scopeOf = (
      projectId: ProjectId | undefined,
    ): Effect.Effect<ExtensionScope, PoseidonRpcError> =>
      projectId === undefined
        ? Effect.succeed({ workspaceRoot: null })
        : readModels.getProjectDoc(projectId).pipe(
            Effect.mapError(
              (error) =>
                new PoseidonRpcError({
                  code: "internal",
                  message: `project lookup failed: ${error.message}`,
                }),
            ),
            // A project the read model no longer has is the user scope alone,
            // and a project-scope write then fails in the extension.
            Effect.map((doc) => ({ workspaceRoot: doc?.workspaceRoot ?? null })),
          );

    return ConnectorExtensions.of({
      skillsList: (instanceId, projectId) =>
        Effect.gen(function* () {
          const skills = yield* skillsOf(instanceId);
          const scope = yield* scopeOf(projectId);
          return yield* skills.list(scope).pipe(Effect.mapError(fromExtension));
        }),
      // An extension that offers no shared folder has nothing to link from.
      skillsAvailable: (instanceId) =>
        Effect.flatMap(skillsOf(instanceId), (skills) =>
          skills.available === undefined
            ? Effect.succeed([])
            : skills.available.pipe(Effect.mapError(fromExtension)),
        ),
      skillsLink: (instanceId, entry) =>
        Effect.gen(function* () {
          const skills = yield* skillsOf(instanceId);
          const link = yield* need(instanceId, "linked skills", skills.link);
          return yield* link(entry).pipe(Effect.mapError(fromExtension));
        }),
      pluginsList: (instanceId, projectId) =>
        Effect.gen(function* () {
          const plugins = yield* pluginsOf(instanceId);
          const scope = yield* scopeOf(projectId);
          return yield* plugins.list(scope).pipe(Effect.mapError(fromExtension));
        }),
      commandsList: (instanceId, projectId) =>
        Effect.gen(function* () {
          const commands = yield* commandsOf(instanceId);
          const scope = yield* scopeOf(projectId);
          return yield* commands.list(scope).pipe(Effect.mapError(fromExtension));
        }),
      mcpList: (instanceId, projectId) =>
        Effect.gen(function* () {
          const mcp = yield* mcpOf(instanceId);
          const scope = yield* scopeOf(projectId);
          return yield* mcp.list(scope).pipe(Effect.mapError(fromExtension));
        }),
      mcpAdd: (instanceId, projectId, server) =>
        Effect.gen(function* () {
          const mcp = yield* mcpOf(instanceId);
          const scope = yield* scopeOf(projectId);
          return yield* mcp.add(scope, server).pipe(Effect.mapError(fromExtension));
        }),
      mcpRemove: (instanceId, projectId, serverScope, name) =>
        Effect.gen(function* () {
          const mcp = yield* mcpOf(instanceId);
          const scope = yield* scopeOf(projectId);
          return yield* mcp.remove(scope, serverScope, name).pipe(Effect.mapError(fromExtension));
        }),
    });
  }),
);
