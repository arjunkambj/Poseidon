/**
 * The generated-text service over a real engine, settings store and registry,
 * with the testkit's SDK-level fake connector as the one open instance. The
 * fake's `generateText` is the test's own function, called in process, so no
 * harness is involved. The title reactor is started separately, so a test can
 * write history before it listens.
 */

import {
  eraseConnectorDefinition,
  type ConnectorServices,
} from "@poseidon/connector-sdk/definition";
import { makeRegistry } from "@poseidon/connector-sdk/registry";
import { makeConnectorInstanceId, type ThreadId } from "@poseidon/contracts/ids";
import { makeFakeConnector, type FakeConnectorOptions } from "@poseidon/testkit/fakeConnector";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";

import { OrchestrationEngine } from "../../orchestration/Engine";
import { EventStore } from "../../persistence/EventStore";
import { ReadModelStore } from "../../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../../persistence/Sqlite";
import { ConnectorCatalog, SettingsStore } from "../../rpc/services";
import { ConnectorRegistryService } from "../../settings/ConnectorManager";
import { TextGeneration } from "../TextGeneration";
import { makeTitleReactor } from "../TitleReactor";

const services: Effect.Effect<ConnectorServices> = Effect.clockWith((clock) =>
  Effect.succeed({
    mcpEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/mcp", bearer: "t" }),
    hookEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/hook", bearer: "t" }),
    permissions: { decide: () => Effect.succeed("prompt" as const) },
    attachmentsDir: "/tmp/poseidon-generation-test",
    logger: { log: () => Effect.void },
    clock,
  }),
);

export const generationStack = (options: Pick<FakeConnectorOptions, "generateText">) =>
  Effect.gen(function* () {
    const sqlite = Layer.succeedContext(yield* Layer.build(sqliteTestLayer()));
    const persistence = Layer.mergeAll(
      sqlite,
      Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
    );
    const fake = yield* makeFakeConnector(options);
    const registry = yield* makeRegistry([eraseConnectorDefinition(fake.definition)]);
    const instance = yield* registry.open({
      instanceId: makeConnectorInstanceId(),
      kind: fake.definition.kind,
      config: {},
      services: yield* services,
    });
    const catalog = Layer.succeed(
      ConnectorCatalog,
      ConnectorCatalog.of({
        list: () => Effect.succeed([]),
        changes: Stream.never,
        models: () => instance.listModels().pipe(Effect.catch(() => Effect.succeed([]))),
        describe: Effect.succeed([]),
      }),
    );
    const engine = OrchestrationEngine.layer.pipe(Layer.provide(persistence));
    const settings = SettingsStore.layer.pipe(Layer.provide(sqlite));
    const generation = TextGeneration.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          persistence,
          engine,
          settings,
          catalog,
          Layer.succeed(ConnectorRegistryService, registry),
        ),
      ),
    );
    const context = yield* Layer.build(Layer.mergeAll(engine, settings, generation));
    const settled = yield* Queue.unbounded<ThreadId>();
    return {
      instance,
      engine: Context.get(context, OrchestrationEngine),
      settings: Context.get(context, SettingsStore),
      generation: Context.get(context, TextGeneration),
      /** Starts the title reactor over the same engine, as a boot would. */
      startTitleReactor: Layer.build(
        makeTitleReactor({ onSettled: (threadId) => Queue.offer(settled, threadId) }).pipe(
          Layer.provide(Layer.succeedContext(context)),
        ),
      ),
      /** Waits until the reactor's job for `threadId` has ended. */
      settledFor: (threadId: ThreadId) =>
        Effect.gen(function* () {
          while ((yield* Queue.take(settled)) !== threadId) {
            // Another thread's job: keep waiting for this one.
          }
        }),
    };
  });
