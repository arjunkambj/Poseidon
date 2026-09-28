/**
 * `ConnectorExtensions` routes each call to the instance it names: a project
 * id becomes that project's workspace root before the connector sees it, a
 * connector failure keeps its code on the way out, and an instance without
 * the extension — or one that is not open at all — answers `unavailable`.
 */

import type { ConnectorServices } from "@poseidon/connector-sdk/definition";
import { eraseConnectorDefinition } from "@poseidon/connector-sdk/definition";
import type { ConnectorExtensions as InstanceExtensions } from "@poseidon/connector-sdk/extensions";
import { ConnectorExtensionFailed, type ExtensionScope } from "@poseidon/connector-sdk/extensions";
import { makeRegistry } from "@poseidon/connector-sdk/registry";
import type { McpServerConfig } from "@poseidon/contracts/connectors";
import { makeConnectorInstanceId, makeProjectId } from "@poseidon/contracts/ids";
import type { PoseidonRpcError } from "@poseidon/contracts/rpc";
import { makeFakeConnector } from "@poseidon/testkit/fakeConnector";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runMigrations } from "../persistence/Migrations";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { ConnectorExtensions } from "../rpc/services";
import { layer as connectorExtensionsLayer } from "./ConnectorExtensions";
import { ConnectorRegistryService } from "./ConnectorManager";

const services: Effect.Effect<ConnectorServices> = Effect.clockWith((clock) =>
  Effect.succeed({
    mcpEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/mcp", bearer: "t" }),
    hookEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/hook", bearer: "t" }),
    permissions: { decide: () => Effect.succeed("prompt" as const) },
    attachmentsDir: "/tmp/poseidon-extensions-test",
    logger: { log: () => Effect.void },
    clock,
  }),
);

const WORKSPACE_ROOT = "/work/project";

const server: McpServerConfig = {
  name: "docs",
  scope: "project",
  enabled: true,
  transport: "http",
  url: "https://example.com/mcp",
};

/**
 * In-memory extensions that record the scope each call was handed. Skills
 * carry no shared folder, so `available` and `link` are left out.
 */
const recordingExtensions = (scopes: Array<ExtensionScope>): InstanceExtensions => ({
  skills: {
    list: (scope) =>
      Effect.sync(() => {
        scopes.push(scope);
        return [{ name: "review", path: `${scope.workspaceRoot ?? "~"}/review.md`, enabled: true }];
      }),
  },
  plugins: {
    list: (scope) =>
      Effect.sync(() => {
        scopes.push(scope);
        return [
          { name: "formatter", source: "a-marketplace", scope: "user", enabled: true },
          ...(scope.workspaceRoot === null
            ? []
            : [{ name: "release-notes", scope: "project", enabled: false }]),
        ];
      }),
  },
  commands: {
    list: (scope) =>
      Effect.sync(() => {
        scopes.push(scope);
        return [{ name: "review", description: "Review the branch", argumentHint: "[focus]" }];
      }),
  },
  mcpServers: {
    list: (scope) =>
      Effect.sync(() => {
        scopes.push(scope);
        return [];
      }),
    add: (scope, added) =>
      Effect.sync(() => {
        scopes.push(scope);
        return [added];
      }),
    remove: (_scope, _serverScope, name) =>
      Effect.fail(new ConnectorExtensionFailed({ code: "conflict", message: `${name} is theirs` })),
  },
});

/** Two open instances — one with extensions, one without — and one project. */
const fixture = Effect.gen(function* () {
  const scopes: Array<ExtensionScope> = [];
  const withExtensions = yield* makeFakeConnector({
    kind: "fake-extended",
    extensions: recordingExtensions(scopes),
  });
  const bare = yield* makeFakeConnector({ kind: "fake-bare" });
  const registry = yield* makeRegistry([
    eraseConnectorDefinition(withExtensions.definition),
    eraseConnectorDefinition(bare.definition),
  ]);
  const extendedId = makeConnectorInstanceId();
  const bareId = makeConnectorInstanceId();
  for (const [instanceId, kind] of [
    [extendedId, "fake-extended"],
    [bareId, "fake-bare"],
  ] as const) {
    yield* registry.open({ instanceId, kind, config: {}, services: yield* services });
  }

  const sqlite = Layer.succeedContext(yield* Layer.build(sqliteTestLayer()));
  yield* runMigrations.pipe(Effect.provide(sqlite));
  const readModels = Context.get(
    yield* Layer.build(ReadModelStore.layer.pipe(Layer.provide(sqlite))),
    ReadModelStore,
  );
  const projectId = makeProjectId();
  const now = new Date().toISOString();
  yield* readModels.putProject({
    projectId,
    name: "test",
    workspaceRoot: WORKSPACE_ROOT,
    createdAt: now,
    updatedAt: now,
    removed: false,
  });

  const context = yield* Layer.build(
    connectorExtensionsLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ReadModelStore, readModels),
          Layer.succeed(ConnectorRegistryService, registry),
        ),
      ),
    ),
  );
  return {
    extensions: Context.get(context, ConnectorExtensions),
    scopes,
    extendedId,
    bareId,
    projectId,
  };
});

describe("ConnectorExtensions", () => {
  it.effect("resolves a project to its workspace root before the connector sees it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const skills = yield* f.extensions.skillsList(f.extendedId, f.projectId);
        expect(skills.map((skill) => skill.path)).toEqual([`${WORKSPACE_ROOT}/review.md`]);
        yield* f.extensions.skillsList(f.extendedId);
        yield* f.extensions.mcpAdd(f.extendedId, f.projectId, server);
        yield* f.extensions.mcpList(f.extendedId);
        expect(f.scopes).toEqual([
          { workspaceRoot: WORKSPACE_ROOT },
          { workspaceRoot: null },
          { workspaceRoot: WORKSPACE_ROOT },
          { workspaceRoot: null },
        ]);
      }),
    ),
  );

  it.effect("lists an instance's plugins, with the project's scope when one is named", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const user = yield* f.extensions.pluginsList(f.extendedId);
        expect(user).toEqual([
          { name: "formatter", source: "a-marketplace", scope: "user", enabled: true },
        ]);
        const project = yield* f.extensions.pluginsList(f.extendedId, f.projectId);
        expect(project.map((plugin) => plugin.name)).toEqual(["formatter", "release-notes"]);
        expect(f.scopes).toEqual([{ workspaceRoot: null }, { workspaceRoot: WORKSPACE_ROOT }]);
      }),
    ),
  );

  it.effect("lists an instance's harness commands", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const commands = yield* f.extensions.commandsList(f.extendedId, f.projectId);
        expect(commands).toEqual([
          { name: "review", description: "Review the branch", argumentHint: "[focus]" },
        ]);
        expect(f.scopes).toEqual([{ workspaceRoot: WORKSPACE_ROOT }]);
      }),
    ),
  );

  it.effect("keeps the connector's failure code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const error = yield* Effect.flip(
          f.extensions.mcpRemove(f.extendedId, undefined, "user", "theirs"),
        );
        expect(error).toMatchObject({ code: "conflict", message: "theirs is theirs" });
      }),
    ),
  );

  it.effect("an instance without the extension answers unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const calls: ReadonlyArray<Effect.Effect<unknown, PoseidonRpcError>> = [
          f.extensions.skillsList(f.bareId),
          f.extensions.skillsAvailable(f.bareId),
          f.extensions.pluginsList(f.bareId),
          f.extensions.pluginsList(f.bareId, f.projectId),
          f.extensions.commandsList(f.bareId),
          f.extensions.mcpList(f.bareId, f.projectId),
          f.extensions.mcpAdd(f.bareId, undefined, server),
          // Not open at all: nothing to route to.
          f.extensions.mcpList(makeConnectorInstanceId()),
          f.extensions.pluginsList(makeConnectorInstanceId()),
          f.extensions.commandsList(makeConnectorInstanceId()),
        ];
        for (const call of calls) {
          expect((yield* Effect.flip(call)).code).toBe("unavailable");
        }
      }),
    ),
  );

  it.effect("skills without a shared folder offer nothing to link", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        expect(yield* f.extensions.skillsAvailable(f.extendedId)).toEqual([]);
        const error = yield* Effect.flip(f.extensions.skillsLink(f.extendedId, "review"));
        expect(error.code).toBe("unavailable");
      }),
    ),
  );
});
