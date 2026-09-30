/**
 * The reconcile loop, proven against the real `SettingsStore` over sqlite:
 * a fresh install seeds one enabled instance per registered definition,
 * toggles and removals open and close registry entries to match, probes feed
 * `connectors.list`, and a settings row from a previous boot is never
 * re-seeded. Waiting is on the manager's `changes` stream — every assertion
 * follows a reconcile that already landed.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import {
  makeConnectorInstanceId,
  makeThreadId,
  type ConnectorInstanceId,
} from "@poseidon/contracts/ids";
import type { ConnectorSummary } from "@poseidon/contracts/connectors";
import { POSEIDON_HOME_ENV } from "@poseidon/shared/paths";
import type { AnyConnectorDefinition, ConnectorServices } from "@poseidon/connector-sdk/definition";
import { eraseConnectorDefinition, ProbeFailed } from "@poseidon/connector-sdk/definition";
import { makeRegistry, type ConnectorRegistry } from "@poseidon/connector-sdk/registry";
import { makeFakeConnector } from "@poseidon/testkit/fakeConnector";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClientTag from "effect/unstable/sql/SqlClient";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import { ConnectorSelection } from "../orchestration/SessionManager";
import type { ThreadDoc } from "../orchestration/state";
import { runMigrations } from "../persistence/Migrations";
import { layer as sqliteLayer, testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { ConnectorCatalog, SettingsStore } from "../rpc/services";
import { ConnectorHost } from "./ConnectorHost";
import { ConnectorManager, ConnectorRegistryService } from "./ConnectorManager";
import {
  readConnectorRouting,
  routingPreference,
  seedModel,
  seedThreadDefaults,
} from "./connectorRouting";

interface Fixture {
  readonly manager: ConnectorManager["Service"];
  /** The RPC-facing catalog over the same manager and registry. */
  readonly catalog: ConnectorCatalog["Service"];
  readonly store: SettingsStore["Service"];
  readonly registry: ConnectorRegistry;
  /** How many times the wrapped definition's probe ran. */
  readonly probes: Ref.Ref<number>;
  /** The façade every instance is opened against; the entrypoint fills it in. */
  readonly host: ConnectorHost["Service"];
  /** The same connection the store writes through — what routing reads. */
  readonly sql: SqlClient.SqlClient;
}

/**
 * A manager over one sqlite layer. `makeSqliteLayer` is a parameter so the
 * restart test can point two boots at the same file.
 */
const fixture = (
  makeSqliteLayer: () => Layer.Layer<
    SqlClient.SqlClient | Reactivity.Reactivity,
    SqlError.SqlError
  > = sqliteTestLayer,
  /** Lets a test swap in a definition whose probe misbehaves. */
  wrap: (definition: AnyConnectorDefinition) => AnyConnectorDefinition = (definition) => definition,
  /** Definitions registered after the fake one. */
  extra: ReadonlyArray<AnyConnectorDefinition> = [],
) =>
  Effect.gen(function* () {
    // Anything the host writes — the attachments directory `install` creates —
    // belongs to this test, never to the developer's real `~/.poseidon`.
    yield* isolatedHome;
    const sqliteContext = yield* Layer.build(makeSqliteLayer());
    const sqlite = Layer.succeedContext(sqliteContext);
    yield* runMigrations.pipe(Effect.provide(sqlite));

    const fake = yield* makeFakeConnector();
    const probes = yield* Ref.make(0);
    const erased = eraseConnectorDefinition(fake.definition);
    const counting = wrap({
      ...erased,
      probe: (config: unknown) =>
        erased.probe(config).pipe(Effect.tap(() => Ref.update(probes, (n) => n + 1))),
    });
    const registry = yield* makeRegistry([counting, ...extra]);

    const ctx = yield* Layer.build(
      ConnectorManager.catalogLayer.pipe(
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
      ),
    );
    // What the entrypoint waits on before it admits a client: the first
    // settings value is upgraded and reconciled by then, so a test's own
    // write cannot land in front of the seed and be seeded around.
    yield* Context.get(ctx, ConnectorManager).ready;
    return {
      manager: Context.get(ctx, ConnectorManager),
      catalog: Context.get(ctx, ConnectorCatalog),
      store: Context.get(ctx, SettingsStore),
      registry,
      probes,
      host: Context.get(ctx, ConnectorHost),
      sql: Context.get(sqliteContext, SqlClientTag.SqlClient),
    } satisfies Fixture;
  });

/** `POSEIDON_HOME` in a temp directory for the calling scope, then back. */
const isolatedHome = Effect.acquireRelease(
  Effect.sync(() => {
    const previous = process.env[POSEIDON_HOME_ENV];
    process.env[POSEIDON_HOME_ENV] = mkdtempSync(nodePath.join(tmpdir(), "poseidon-host-"));
    return previous;
  }),
  (previous) =>
    Effect.sync(() => {
      if (previous === undefined) {
        delete process.env[POSEIDON_HOME_ENV];
      } else {
        process.env[POSEIDON_HOME_ENV] = previous;
      }
    }),
);

const withFixture = <A, E>(
  run: (fixture: Fixture) => Effect.Effect<A, E>,
  makeSqliteLayer?: Parameters<typeof fixture>[0],
  wrap?: Parameters<typeof fixture>[1],
  extra?: Parameters<typeof fixture>[2],
) => Effect.scoped(Effect.flatMap(fixture(makeSqliteLayer, wrap, extra), run));

/** First summaries matching `pred`, replaying the current value — never a timer. */
const awaitSummaries = (
  manager: ConnectorManager["Service"],
  pred: (summaries: ReadonlyArray<ConnectorSummary>) => boolean,
) => manager.changes.pipe(Stream.filter(pred), Stream.runHead, Effect.map(Option.getOrThrow));

/** Whether every entry's probe has landed: the list is pushed before any has. */
const probed = (summaries: ReadonlyArray<ConnectorSummary>) =>
  summaries.every((summary) => summary.probe.status !== "probing");

/** The open-instance reading the entrypoint hands the engine. */
const openIds = (registry: ConnectorRegistry) =>
  Effect.map(registry.instances, (instances) => instances.map((instance) => instance.instanceId));

/** The models reading the entrypoint hands the engine, for the last-resort seed. */
const connectorModels = (registry: ConnectorRegistry) => (instanceId: ConnectorInstanceId) =>
  registry.instance(instanceId).pipe(
    Effect.flatMap((instance) => instance.listModels()),
    Effect.map((models) => models.map((model) => model.id)),
    Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<string>)),
  );

const threadId = makeThreadId();

/** A thread document with only what routing reads: its id and its settings. */
const routedThread = (connectorInstanceId?: ConnectorInstanceId) =>
  ({
    threadId,
    settings: {
      model: "acme/any",
      runtimeMode: "approval-required",
      interactionMode: "default",
      ...(connectorInstanceId === undefined ? {} : { connectorInstanceId }),
    },
  }) as ThreadDoc;

/** `ConnectorSelection.fromRegistry` over the settings document's routing order. */
const selectionOver = (registry: ConnectorRegistry, sql: SqlClient.SqlClient) =>
  // `fromRegistry` holds no resources of its own, so a scope just for the
  // lookup is enough.
  Effect.scoped(
    Effect.map(
      Layer.build(ConnectorSelection.fromRegistry(registry, routingPreference(sql))),
      (built) => Context.get(built, ConnectorSelection),
    ),
  );

describe("ConnectorManager", () => {
  it.effect("a fresh install seeds one enabled, probed, open instance per definition", () =>
    withFixture(({ manager, registry }) =>
      Effect.gen(function* () {
        const summaries = yield* awaitSummaries(
          manager,
          (all) => all.length === 1 && all[0]!.probe.status === "ready",
        );
        const seeded = summaries[0]!;
        expect(seeded.kind).toBe("fake");
        // Named after the definition's own metadata.
        expect(seeded.displayName).toBe("Fake");
        expect(seeded.enabled).toBe(true);
        expect(seeded.capabilities).not.toBeNull();
        // The fake connector manages no harness files of its own.
        expect(seeded.extensions).toEqual({ skills: false, plugins: false, mcpServers: false });
        expect(seeded.probe.modelCount).toBe(1);
        // The health facts the renderer reads without knowing the harness.
        expect(seeded.probe.installed).toBe(true);
        expect(seeded.probe.authenticated).toBe(true);
        expect(yield* registry.instances).toHaveLength(1);
      }),
    ),
  );

  it.effect("describe lists every definition, configured or not", () =>
    Effect.gen(function* () {
      const other = yield* makeFakeConnector({
        kind: "other",
        metadata: { displayName: "Other", iconKey: "server", accent: "#123456" },
      });
      yield* withFixture(
        ({ catalog }) =>
          Effect.gen(function* () {
            const described = yield* catalog.describe;
            expect(described).toEqual([
              {
                kind: "fake",
                metadata: { displayName: "Fake", iconKey: "terminal", accent: "#808080" },
                configFields: [{ key: "label", label: "Label", control: "text", optional: true }],
              },
              {
                kind: "other",
                metadata: { displayName: "Other", iconKey: "server", accent: "#123456" },
                configFields: [{ key: "label", label: "Label", control: "text", optional: true }],
              },
            ]);
          }),
        undefined,
        undefined,
        [eraseConnectorDefinition(other.definition)],
      );
    }),
  );

  it.effect("`ready` waits for the open instance, not for its probe", () =>
    Effect.gen(function* () {
      // The entrypoint writes the handshake once `ready` completes. A probe can
      // burn its full timeout, so what must be true by then is registration:
      // `ConnectorSelection` answers `NoConnector` off an empty registry.
      const release = yield* Deferred.make<void>();
      yield* withFixture(
        ({ manager, registry }) =>
          Effect.gen(function* () {
            yield* manager.ready;
            expect(yield* registry.instances).toHaveLength(1);
            // Still inside the first probe: the summary has nothing to report.
            const pending = yield* manager.list();
            expect(pending[0]!.probe.status).toBe("probing");
            expect(pending[0]!.probe.installed).toBeUndefined();

            yield* Deferred.succeed(release, undefined);
            const probed = yield* awaitSummaries(
              manager,
              (all) => all.length === 1 && all[0]!.probe.status === "ready",
            );
            expect(probed[0]!.probe.modelCount).toBe(1);
          }),
        undefined,
        (definition) => ({
          ...definition,
          probe: (config: unknown) =>
            Effect.andThen(Deferred.await(release), definition.probe(config)),
        }),
      );
    }),
  );

  it.effect("disabling closes the instance and re-enabling reopens it", () =>
    withFixture(({ manager, store, registry }) =>
      Effect.gen(function* () {
        yield* awaitSummaries(manager, (all) => all.length === 1);
        const conn = (yield* store.get).connectors[0]!;

        yield* store.update({ connectors: [{ ...conn, enabled: false }] });
        const disabled = yield* awaitSummaries(
          manager,
          (all) => all.length === 1 && all[0]!.enabled === false && probed(all),
        );
        // Disabled stays probed — the connectors page still wants binary state.
        expect(disabled[0]!.probe.status).toBe("ready");
        expect(disabled[0]!.capabilities).toBeNull();
        expect(yield* registry.instances).toHaveLength(0);

        yield* store.update({ connectors: [{ ...conn, enabled: true }] });
        yield* awaitSummaries(manager, (all) => all.length === 1 && all[0]!.capabilities !== null);
        expect(yield* registry.instances).toHaveLength(1);
      }),
    ),
  );

  it.effect("an instance re-enabled after boot is lent the running app's endpoints", () =>
    Effect.gen(function* () {
      /** What `registry.open` handed the connector, per open. */
      const lent: Array<ConnectorServices> = [];
      const record = (definition: AnyConnectorDefinition): AnyConnectorDefinition => ({
        ...definition,
        createInstance: (input) => {
          lent.push(input.services);
          return definition.createInstance(input);
        },
      });

      yield* withFixture(
        ({ manager, store, registry, host }) =>
          Effect.gen(function* () {
            yield* awaitSummaries(manager, (all) => all.length === 1);
            const conn = (yield* store.get).connectors[0]!;

            // The order production runs in: the manager opens instances while
            // the graph is built, and only the booted app can say where its
            // gateway and hook bridge listen.
            yield* host.install({
              mcpEndpoint: (id) => Effect.succeed({ url: `http://mcp/${id}`, bearer: "mcp" }),
              hookEndpoint: (id) => Effect.succeed({ url: `http://hooks/${id}`, bearer: "hook" }),
              permissions: { decide: () => Effect.succeed("allow" as const) },
            });

            yield* store.update({ connectors: [{ ...conn, enabled: false }] });
            yield* awaitSummaries(manager, (all) => all[0]!.enabled === false);
            yield* store.update({ connectors: [{ ...conn, enabled: true }] });
            yield* awaitSummaries(manager, (all) => all[0]!.capabilities !== null);

            // One live instance, and the object it was opened against answers
            // with the installed endpoints rather than dying on first use —
            // which is what a second, placeholder-backed open used to leave
            // behind for whichever copy routing happened to pick.
            expect(yield* registry.instances).toHaveLength(1);
            const services = lent.at(-1)!;
            expect((yield* services.hookEndpoint(threadId)).url).toBe(`http://hooks/${threadId}`);
            expect((yield* services.mcpEndpoint(threadId)).url).toBe(`http://mcp/${threadId}`);
          }),
        undefined,
        record,
      );
    }),
  );

  it.effect("removing the entry deregisters the instance", () =>
    withFixture(({ manager, store, registry }) =>
      Effect.gen(function* () {
        yield* awaitSummaries(manager, (all) => all.length === 1);
        yield* store.update({ connectors: [] });
        yield* awaitSummaries(manager, (all) => all.length === 0);
        expect(yield* registry.instances).toHaveLength(0);
      }),
    ),
  );

  it.effect("list(true) re-probes; models come from the probe", () =>
    withFixture(({ manager, probes }) =>
      Effect.gen(function* () {
        const seeded = yield* awaitSummaries(manager, (all) => all.length === 1 && probed(all));
        const afterReconcile = yield* Ref.get(probes);
        const list = yield* manager.list(true);
        expect(yield* Ref.get(probes)).toBe(afterReconcile + 1);
        expect(list[0]!.probe.status).toBe("ready");
        const models = yield* manager.models(seeded[0]!.connectorInstanceId as ConnectorInstanceId);
        expect(models.map((model) => model.id)).toEqual(["fake/model"]);
      }),
    ),
  );

  it.effect("models fall back to the open instance when the probe failed", () =>
    withFixture(
      ({ manager }) =>
        Effect.gen(function* () {
          const summaries = yield* awaitSummaries(
            manager,
            (all) => all.length === 1 && all[0]!.probe.status === "error",
          );
          const instanceId = summaries[0]!.connectorInstanceId as ConnectorInstanceId;
          // The instance opened fine; only its probe is broken, so the model
          // pickers must still be filled from `listModels()`.
          const models = yield* manager.models(instanceId);
          expect(models.map((model) => model.id)).toEqual(["fake/model"]);
        }),
      undefined,
      (definition) => ({
        ...definition,
        probe: () => Effect.fail(new ProbeFailed({ kind: definition.kind, message: "no binary" })),
      }),
    ),
  );

  it.effect("a refresh straight after a write answers from the reconciled document", () =>
    withFixture(({ manager, store, registry }) =>
      Effect.gen(function* () {
        yield* awaitSummaries(
          manager,
          (all) => all.length === 1 && all[0]!.probe.status === "ready",
        );
        const existing = (yield* store.get).connectors[0]!;
        const added = {
          connectorInstanceId: makeConnectorInstanceId(),
          kind: "fake",
          displayName: "Second",
          enabled: true,
          config: {},
        };
        yield* store.update({ connectors: [existing, added] });

        // What the connectors panel does the moment a save lands. The refresh
        // and the reconcile the write woke both want the reconcile mutex, so
        // the refresh reconciles the document itself: whichever gets there
        // first, the panel is handed an opened, probed instance.
        const listed = yield* manager.list(true);
        const fresh = listed.find(
          (summary) => summary.connectorInstanceId === added.connectorInstanceId,
        )!;
        expect(fresh.probe.status).toBe("ready");
        expect(fresh.capabilities).not.toBeNull();
        expect(yield* registry.instances).toHaveLength(2);
      }),
    ),
  );

  it.effect("the model fallback is asked once, and again after the next probe", () =>
    Effect.gen(function* () {
      // `listModels()` is a re-probe for a real connector — two child processes
      // for the cmd one — and every model picker asks on mount, so the answer
      // has to be held until something replaces it.
      const listed = yield* Ref.make(0);
      yield* withFixture(
        ({ manager }) =>
          Effect.gen(function* () {
            const summaries = yield* awaitSummaries(
              manager,
              (all) => all.length === 1 && all[0]!.probe.status === "error",
            );
            const instanceId = summaries[0]!.connectorInstanceId as ConnectorInstanceId;
            yield* manager.models(instanceId);
            yield* manager.models(instanceId);
            expect(yield* Ref.get(listed)).toBe(1);

            // A fresh probe retires the memo — a connector that got its binary
            // back must not keep answering from the empty list.
            yield* manager.list(true);
            yield* manager.models(instanceId);
            expect(yield* Ref.get(listed)).toBe(2);
          }),
        undefined,
        (definition) => ({
          ...definition,
          probe: () =>
            Effect.fail(new ProbeFailed({ kind: definition.kind, message: "no binary" })),
          createInstance: (input) =>
            Effect.map(definition.createInstance(input), (instance) => ({
              ...instance,
              listModels: () =>
                Effect.andThen(
                  Ref.update(listed, (count) => count + 1),
                  instance.listModels(),
                ),
            })),
        }),
      );
    }),
  );

  it.effect("routes to the connector the document lists first, however it was opened", () =>
    withFixture(({ manager, store, registry, sql }) =>
      Effect.gen(function* () {
        yield* awaitSummaries(manager, (all) => all.length === 1);
        const first = {
          ...(yield* store.get).connectors[0]!,
          config: { defaultModel: "acme/first" },
        };
        const second = {
          connectorInstanceId: makeConnectorInstanceId(),
          kind: "fake",
          displayName: "Second",
          enabled: true,
          config: { defaultModel: "acme/second" },
        };
        const bothOpen = (all: ReadonlyArray<ConnectorSummary>) =>
          all.length === 2 && all.every((summary) => summary.capabilities !== null);

        yield* store.update({ connectors: [first, second] });
        yield* awaitSummaries(manager, bothOpen);

        // Disabling and re-enabling the *first* entry is all it takes: only a
        // changed signature is reopened, so it goes to the back of the
        // registry's insertion order while the document still lists it first.
        yield* store.update({ connectors: [{ ...first, enabled: false }, second] });
        yield* awaitSummaries(manager, (all) => all[0]!.capabilities === null);
        yield* store.update({ connectors: [first, second] });
        yield* awaitSummaries(manager, bothOpen);

        const instances = yield* registry.instances;
        expect(instances.map((instance) => instance.instanceId)).toEqual([
          second.connectorInstanceId,
          first.connectorInstanceId,
        ]);

        // `fromRegistry` holds no resources of its own, so a scope just for
        // the lookup is enough.
        const selection = yield* Effect.scoped(
          Effect.map(
            Layer.build(ConnectorSelection.fromRegistry(registry, routingPreference(sql))),
            (built) => Context.get(built, ConnectorSelection),
          ),
        );
        const routed = yield* selection.instanceFor(routedThread());
        expect(routed.instanceId).toBe(first.connectorInstanceId);

        // And the model a new thread is seeded with is that same instance's —
        // the engine reads this, so a thread can never start on a model its
        // connector was never asked about.
        const routing = yield* readConnectorRouting(sql);
        expect(routing.enabled[0]!.connectorInstanceId).toBe(routed.instanceId);
        expect(yield* seedModel(sql, openIds(registry))).toEqual({
          model: "acme/first",
          connectorInstanceId: first.connectorInstanceId,
        });
      }),
    ),
  );

  it.effect("a thread routed past a connector that never opened is not seeded from it", () =>
    withFixture(({ manager, store, registry, sql }) =>
      Effect.gen(function* () {
        // The document's first enabled entry names a kind this build does not
        // ship, so it is probed, reported as an error and never registered.
        // Selection therefore routes to the second entry; the seed has to
        // follow it there, or the thread starts on a model the connector it
        // actually runs on has never heard of.
        const ghost = {
          connectorInstanceId: makeConnectorInstanceId(),
          kind: "no-such-connector",
          displayName: "Ghost",
          enabled: true,
          config: { defaultModel: "ghost/never-opened" },
        };
        const working = {
          connectorInstanceId: makeConnectorInstanceId(),
          kind: "fake",
          displayName: "Working",
          enabled: true,
          config: { defaultModel: "acme/working" },
        };
        yield* store.update({ connectors: [ghost, working] });
        yield* awaitSummaries(
          manager,
          (all) =>
            all.length === 2 && all[0]!.probe.status === "error" && all[1]!.capabilities !== null,
        );

        const selection = yield* Effect.scoped(
          Effect.map(
            Layer.build(ConnectorSelection.fromRegistry(registry, routingPreference(sql))),
            (built) => Context.get(built, ConnectorSelection),
          ),
        );
        const routed = yield* selection.instanceFor(routedThread());
        expect(routed.instanceId).toBe(working.connectorInstanceId);
        expect(yield* seedModel(sql, openIds(registry))).toEqual({
          model: "acme/working",
          connectorInstanceId: working.connectorInstanceId,
        });

        // Without the registry to consult, the document's order is all there
        // is — which is the reading every engine test without a connector gets.
        expect(yield* seedModel(sql, null)).toEqual({
          model: "ghost/never-opened",
          connectorInstanceId: ghost.connectorInstanceId,
        });
      }),
    ),
  );

  it.effect("nothing open seeds nothing, and a shared default stands when none can say", () =>
    withFixture(({ manager, store, sql, registry }) =>
      Effect.gen(function* () {
        const ghost = {
          connectorInstanceId: makeConnectorInstanceId(),
          kind: "no-such-connector",
          displayName: "Ghost",
          enabled: true,
          config: { defaultModel: "ghost/never-opened" },
        };
        yield* store.update({ connectors: [ghost] });
        yield* awaitSummaries(
          manager,
          (all) => all.length === 1 && all[0]!.probe.status === "error",
        );
        // No enabled entry is open, so no entry speaks for whatever the
        // registry falls back to: the thread starts on the connector's own.
        expect(yield* seedModel(sql, openIds(registry))).toBeNull();

        // Nobody to ask which instance runs it: the app-wide default, unpinned.
        const current = yield* store.get;
        yield* store.update({ defaults: { ...current.defaults, model: "acme/shared" } });
        expect(yield* seedModel(sql, openIds(registry))).toEqual({
          model: "acme/shared",
          connectorInstanceId: null,
        });
      }),
    ),
  );

  it.effect("the new-thread defaults carry effort and runtime mode too", () =>
    withFixture(({ store, sql }) =>
      Effect.gen(function* () {
        const current = yield* store.get;
        yield* store.update({
          defaults: { ...current.defaults, effort: "high", runtimeMode: "full-access" },
        });
        expect(yield* seedThreadDefaults(sql)).toEqual({
          effort: "high",
          runtimeMode: "full-access",
        });

        // A value from a build that knows an enum member this one does not
        // must read as "not set", never travel onto `thread.created`.
        yield* sql`
          UPDATE settings
          SET value_json = ${JSON.stringify({
            ...current,
            defaults: { model: null, effort: "galactic", runtimeMode: "yolo" },
          })}
          WHERE key = 'settings'
        `;
        expect(yield* seedThreadDefaults(sql)).toEqual({ effort: null, runtimeMode: null });
      }),
    ),
  );

  it.effect("every rung of the effort ladder survives as a new-thread default", () =>
    withFixture(({ store, sql }) =>
      Effect.gen(function* () {
        const current = yield* store.get;
        // The routing read once knew only low/medium/high, so `xhigh` and `max`
        // chosen in settings silently fell back to the decider's `medium`.
        for (const effort of ["minimal", "xhigh", "max"] as const) {
          yield* store.update({ defaults: { ...current.defaults, effort } });
          expect((yield* seedThreadDefaults(sql)).effort).toBe(effort);
        }
      }),
    ),
  );

  it.effect("a fresh install seeds the routed connector's own first model", () =>
    withFixture(({ manager, registry, sql }) =>
      Effect.gen(function* () {
        // Exactly what a first launch leaves behind: `defaultSettings()` writes
        // `model: null`, and the seeded entry carries the kind's empty
        // `defaultConfig()`, so neither the document's default nor the
        // connector's has anything in it. Before the fallback existed this
        // answered null and every `thread.create` was rejected.
        yield* awaitSummaries(manager, (all) => all.length === 1 && all[0]!.capabilities !== null);
        const routing = yield* readConnectorRouting(sql);
        expect(routing.sharedModel).toBeNull();
        expect(routing.enabled[0]!.defaultModel).toBeNull();
        expect(yield* seedModel(sql, openIds(registry))).toBeNull();

        expect(yield* seedModel(sql, openIds(registry), connectorModels(registry))).toEqual({
          model: "fake/model",
          connectorInstanceId: routing.enabled[0]!.connectorInstanceId,
        });
      }),
    ),
  );

  it.effect("a thread that chose its instance runs on it and is seeded from it", () =>
    withFixture(({ manager, store, registry, sql }) =>
      Effect.gen(function* () {
        yield* awaitSummaries(manager, (all) => all.length === 1);
        const first = (yield* store.get).connectors[0]!;
        const chosen = {
          connectorInstanceId: makeConnectorInstanceId(),
          kind: "fake",
          displayName: "Chosen",
          enabled: true,
          config: { defaultModel: "acme/chosen" },
        };
        const current = yield* store.get;
        yield* store.update({
          defaults: { ...current.defaults, model: "acme/shared" },
          connectors: [first, chosen],
        });
        yield* awaitSummaries(
          manager,
          (all) => all.length === 2 && all.every((summary) => summary.capabilities !== null),
        );
        const selection = yield* selectionOver(registry, sql);
        const open = openIds(registry);
        const models = connectorModels(registry);

        // The choice outranks the document's order, and the app-wide default
        // does not outrank the chosen instance's own — it may name another
        // harness's model.
        expect(
          (yield* selection.instanceFor(routedThread(chosen.connectorInstanceId))).instanceId,
        ).toBe(chosen.connectorInstanceId);
        expect(yield* seedModel(sql, open, models, chosen.connectorInstanceId)).toEqual({
          model: "acme/chosen",
          connectorInstanceId: chosen.connectorInstanceId,
        });
        // A thread that chose nothing still goes by the default rule. No
        // instance lists the app-wide default, and that is no reason to put
        // another model in place of the user's: it stands, unpinned, as New
        // task's pick sends it (`defaultModelPick` in the renderer).
        const sharedSeed = { model: "acme/shared", connectorInstanceId: null };
        expect((yield* selection.instanceFor(routedThread())).instanceId).toBe(
          first.connectorInstanceId,
        );
        expect(yield* seedModel(sql, open, models)).toEqual(sharedSeed);

        // The seeded entry has no default of its own: choosing it starts on
        // its first model, still ahead of the app-wide default.
        expect(yield* seedModel(sql, open, models, first.connectorInstanceId)).toEqual({
          model: "fake/model",
          connectorInstanceId: first.connectorInstanceId,
        });

        // Disabled since: routing and the seed both fall back to the default rule.
        yield* store.update({ connectors: [first, { ...chosen, enabled: false }] });
        yield* awaitSummaries(manager, (all) => all[1]!.capabilities === null);
        expect(
          (yield* selection.instanceFor(routedThread(chosen.connectorInstanceId))).instanceId,
        ).toBe(first.connectorInstanceId);
        expect(yield* seedModel(sql, open, models, chosen.connectorInstanceId)).toEqual(sharedSeed);

        // Removed altogether: the same fallback.
        yield* store.update({ connectors: [first] });
        yield* awaitSummaries(manager, (all) => all.length === 1);
        expect(
          (yield* selection.instanceFor(routedThread(chosen.connectorInstanceId))).instanceId,
        ).toBe(first.connectorInstanceId);
      }),
    ),
  );

  it.effect("an unknown kind reports an error probe and opens nothing", () =>
    withFixture(({ manager, store, registry }) =>
      Effect.gen(function* () {
        yield* store.update({
          connectors: [
            {
              connectorInstanceId: makeConnectorInstanceId(),
              kind: "no-such-connector",
              displayName: "Ghost",
              enabled: true,
              config: {},
            },
          ],
        });
        const summaries = yield* awaitSummaries(
          manager,
          (all) => all.length === 1 && all[0]!.probe.status === "error",
        );
        expect(summaries[0]!.probe.message).toContain("no-such-connector");
        // Nothing ran, so nothing is installed and nothing is known about sign-in.
        expect(summaries[0]!.probe.installed).toBe(false);
        expect(summaries[0]!.probe.authenticated).toBeUndefined();
        expect(yield* registry.instances).toHaveLength(0);
      }),
    ),
  );

  it.effect("a settings row from a previous boot is never re-seeded", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(nodePath.join(tmpdir(), "poseidon-settings-"));
      const fileLayer = () => sqliteLayer({ filename: nodePath.join(dir, "state.sqlite") });

      // Boot 1: seed lands, then the user removes every connector and leaves
      // one disabled entry — a positive signal the next boot's reconcile ran
      // (a disabled instance is still probed) without opening anything.
      const left = {
        connectorInstanceId: makeConnectorInstanceId(),
        kind: "fake",
        displayName: "Leftover",
        enabled: false,
        config: {},
      };
      yield* withFixture(
        ({ manager, store }) =>
          Effect.gen(function* () {
            yield* awaitSummaries(manager, (all) => all.length === 1);
            yield* store.update({ connectors: [] });
            yield* awaitSummaries(manager, (all) => all.length === 0);
            yield* store.update({ connectors: [left] });
            yield* awaitSummaries(manager, (all) => all.length === 1);
          }),
        fileLayer,
      );

      // Boot 2 over the same file: not a fresh install. Reconcile probes the
      // leftover entry; had the seed fired, a second connector would exist.
      yield* withFixture(
        ({ manager, store, registry }) =>
          Effect.gen(function* () {
            const summaries = yield* awaitSummaries(
              manager,
              (all) => all.length === 1 && all[0]!.probe.status === "ready",
            );
            expect(summaries[0]!.connectorInstanceId).toBe(left.connectorInstanceId);
            expect(summaries[0]!.enabled).toBe(false);
            expect((yield* store.get).connectors).toHaveLength(1);
            expect(yield* registry.instances).toHaveLength(0);
          }),
        fileLayer,
      );
    }),
  );
});
