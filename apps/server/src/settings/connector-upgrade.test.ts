/**
 * The harness rank, proven twice: the pure upgrade over a settings document,
 * and the connector manager running it over the real `SettingsStore` and
 * sqlite across boots, with three fake connectors standing in for Claude
 * Code, Codex and Command Code — registered in that order, as `boot.ts` does.
 *
 * The owner-like document is the one an install from when Command Code came
 * first holds: Command Code, then Claude Code, no Codex, and a Command Code
 * model as the app-wide default. The same manager also publishes which
 * instances cannot run, and the default rule on both sides of the engine —
 * `ConnectorSelection` and `seedModel` — has to pass over them together.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

import type { AnyConnectorDefinition, ConnectorProbe } from "@poseidon/connector-sdk/definition";
import { eraseConnectorDefinition, ProbeFailed } from "@poseidon/connector-sdk/definition";
import { makeRegistry, type ConnectorRegistry } from "@poseidon/connector-sdk/registry";
import {
  makeConnectorInstanceId,
  makeThreadId,
  type ConnectorInstanceId,
} from "@poseidon/contracts/ids";
import {
  defaultSettings,
  Settings,
  type ConnectorInstanceConfig,
} from "@poseidon/contracts/settings";
import { POSEIDON_HOME_ENV } from "@poseidon/shared/paths";
import { makeFakeConnector } from "@poseidon/testkit/fakeConnector";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClientTag from "effect/unstable/sql/SqlClient";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { ConnectorSelection } from "../orchestration/SessionManager";
import type { ThreadDoc } from "../orchestration/state";
import { runMigrations } from "../persistence/Migrations";
import { layer as sqliteLayer } from "../persistence/Sqlite";
import { SettingsStore } from "../rpc/services";
import { ConnectorHost } from "./ConnectorHost";
import { ConnectorManager, ConnectorRegistryService } from "./ConnectorManager";
import { routingPreference, seedModel, UnrunnableConnectors } from "./connectorRouting";
import {
  DEFAULT_MODEL_MIGRATION,
  defaultModelVerdict,
  RANK_MIGRATION,
  upgradeConnectors,
} from "./connectorUpgrade";

const CLAUDE_MODEL = "claude/sonnet";
const CODEX_MODEL = "codex/gpt";
const CMD_MODEL = "meta/muse-spark-1.2-contributor";

/** The three kinds in rank order, with the one model each lists. */
const HARNESSES = [
  { kind: "claude", displayName: "Claude Code", model: CLAUDE_MODEL },
  { kind: "codex", displayName: "Codex", model: CODEX_MODEL },
  { kind: "cmd", displayName: "Command Code", model: CMD_MODEL },
] as const;

type Kind = (typeof HARNESSES)[number]["kind"];

const entry = (kind: Kind, displayName: string): ConnectorInstanceConfig => ({
  connectorInstanceId: makeConnectorInstanceId(),
  kind,
  displayName,
  enabled: true,
  config: {},
});

// ── The pure upgrade ─────────────────────────────────────────

describe("upgradeConnectors", () => {
  const shipped = HARNESSES.map(({ kind, displayName }) => ({
    kind,
    metadata: { displayName, iconKey: "terminal", accent: "#808080" },
    defaultConfig: () => ({}),
  }));

  const owner = () => {
    const cmd = entry("cmd", "Command Code");
    const claude = entry("claude", "Claude Code");
    const settings: Settings = {
      ...defaultSettings(),
      connectors: [cmd, claude],
      defaults: { ...defaultSettings().defaults, model: CMD_MODEL },
    };
    return { cmd, claude, settings };
  };

  it("ranks an owner's list and adds the kind it never had", () => {
    const { cmd, claude, settings } = owner();
    const codexId = makeConnectorInstanceId();
    const patch = upgradeConnectors(settings, shipped, false, () => codexId);
    expect(patch?.connectors).toEqual([
      claude,
      {
        connectorInstanceId: codexId,
        kind: "codex",
        displayName: "Codex",
        enabled: true,
        config: {},
      },
      cmd,
    ]);
    expect(patch?.offeredConnectorKinds).toEqual(["claude", "codex", "cmd"]);
    // The default model waits for model lists: it is not the upgrade's to settle.
    expect(patch?.connectorMigrations).toEqual([RANK_MIGRATION]);
    expect(patch?.defaults).toBeUndefined();
  });

  it("is idempotent, and never gives a removed kind back", () => {
    const { settings } = owner();
    const patch = upgradeConnectors(settings, shipped, false, makeConnectorInstanceId)!;
    const upgraded: Settings = { ...settings, ...patch } as Settings;
    expect(upgradeConnectors(upgraded, shipped, false, makeConnectorInstanceId)).toBeNull();

    const withoutCodex: Settings = {
      ...upgraded,
      connectors: upgraded.connectors.filter((conn) => conn.kind !== "codex"),
    };
    expect(upgradeConnectors(withoutCodex, shipped, false, makeConnectorInstanceId)).toBeNull();
  });

  it("leaves a later reorder alone", () => {
    const { settings } = owner();
    const patch = upgradeConnectors(settings, shipped, false, makeConnectorInstanceId)!;
    const upgraded: Settings = { ...settings, ...patch } as Settings;
    const reordered: Settings = { ...upgraded, connectors: upgraded.connectors.toReversed() };
    expect(upgradeConnectors(reordered, shipped, false, makeConnectorInstanceId)).toBeNull();
  });

  it("seeds a fresh install in rank order, with nothing left to check", () => {
    const patch = upgradeConnectors(defaultSettings(), shipped, true, makeConnectorInstanceId);
    expect(patch?.connectors?.map((conn) => conn.kind)).toEqual(["claude", "codex", "cmd"]);
    expect(patch?.connectorMigrations).toEqual([RANK_MIGRATION, DEFAULT_MODEL_MIGRATION]);
  });

  it("puts nothing back in a document the user emptied", () => {
    const patch = upgradeConnectors(defaultSettings(), shipped, false, makeConnectorInstanceId);
    expect(patch?.connectors).toEqual([]);
    expect(patch?.offeredConnectorKinds).toEqual(["claude", "codex", "cmd"]);
  });

  it("offers a kind shipped later once, at the end of a ranked list", () => {
    const claude = entry("claude", "Claude Code");
    const settings: Settings = {
      ...defaultSettings(),
      connectors: [claude],
      offeredConnectorKinds: ["claude", "cmd"],
      connectorMigrations: [RANK_MIGRATION, DEFAULT_MODEL_MIGRATION],
    };
    const patch = upgradeConnectors(settings, shipped, false, makeConnectorInstanceId);
    expect(patch?.connectors?.map((conn) => conn.kind)).toEqual(["claude", "codex"]);
    expect(patch?.offeredConnectorKinds).toEqual(["claude", "cmd", "codex"]);
  });

  it("keeps a kind this build does not ship behind the ranked ones", () => {
    const ghost = { ...entry("claude", "Ghost"), kind: "ghost" };
    const cmd = entry("cmd", "Command Code");
    const settings: Settings = { ...defaultSettings(), connectors: [ghost, cmd] };
    const patch = upgradeConnectors(settings, shipped, false, makeConnectorInstanceId);
    expect(patch?.connectors?.map((conn) => conn.kind)).toEqual([
      "claude",
      "codex",
      "cmd",
      "ghost",
    ]);
  });
});

describe("defaultModelVerdict", () => {
  const can = (...models: ReadonlyArray<string>) => ({ models, canRun: true });
  const cannot = (...models: ReadonlyArray<string>) => ({ models, canRun: false });

  it("keeps a model a harness ahead lists, clears one none does, waits for an answer", () => {
    expect(defaultModelVerdict(CODEX_MODEL, [can(CLAUDE_MODEL), can(CODEX_MODEL)], [])).toBe(
      "keep",
    );
    expect(defaultModelVerdict(CMD_MODEL, [can(CLAUDE_MODEL), can()], [can(CMD_MODEL)])).toBe(
      "clear",
    );
    // Command Code could not say either: nothing but the harnesses ahead to go by.
    expect(defaultModelVerdict(CMD_MODEL, [can(CLAUDE_MODEL)], [])).toBe("clear");
    expect(defaultModelVerdict(CMD_MODEL, [can(), can()], [can(CMD_MODEL)])).toBe("undecided");
    expect(defaultModelVerdict(CMD_MODEL, [], [])).toBe("undecided");
  });

  it("keeps a model a harness that cannot run lists, and asks one that can to clear", () => {
    // Codex signed out still lists its models, and the choice was the user's.
    expect(defaultModelVerdict(CODEX_MODEL, [can(CLAUDE_MODEL), cannot(CODEX_MODEL)], [])).toBe(
      "keep",
    );
    // Only signed-out harnesses answered: Command Code's model waits.
    expect(defaultModelVerdict(CMD_MODEL, [cannot(CLAUDE_MODEL)], [can(CMD_MODEL)])).toBe(
      "undecided",
    );
  });

  it("keeps a model Command Code answered without, whoever else was slow", () => {
    // Codex timed out and listed nothing; its model is still not Command Code's.
    expect(defaultModelVerdict(CODEX_MODEL, [can(CLAUDE_MODEL), can()], [can(CMD_MODEL)])).toBe(
      "keep",
    );
  });

  it("waits when a harness ahead listed nothing and Command Code said nothing either", () => {
    // Codex timed out, or is not found, and Command Code is not installed or
    // is switched off: the model may be Codex's, so it is not cleared.
    expect(defaultModelVerdict(CODEX_MODEL, [can(CLAUDE_MODEL), can()], [])).toBe("undecided");
    expect(defaultModelVerdict(CODEX_MODEL, [can(CLAUDE_MODEL), cannot()], [])).toBe("undecided");
    // Once Codex answers without it, it is Command Code's after all.
    expect(defaultModelVerdict(CMD_MODEL, [can(CLAUDE_MODEL), can(CODEX_MODEL)], [])).toBe("clear");
  });
});

// ── The manager, across boots ────────────────────────────────

const notInstalled: ConnectorProbe = {
  status: "not-installed",
  probedAt: new Date(0).toISOString(),
  installed: false,
  auth: "unknown",
  models: [],
  warnings: [],
};

interface Booted {
  readonly manager: ConnectorManager["Service"];
  readonly store: SettingsStore["Service"];
  readonly registry: ConnectorRegistry;
  readonly sql: SqlClient.SqlClient;
  readonly unrunnable: Ref.Ref<ReadonlySet<ConnectorInstanceId>>;
}

/** `POSEIDON_HOME` in a temp directory for the calling scope, then back. */
const isolatedHome = Effect.acquireRelease(
  Effect.sync(() => {
    const previous = process.env[POSEIDON_HOME_ENV];
    process.env[POSEIDON_HOME_ENV] = mkdtempSync(nodePath.join(tmpdir(), "poseidon-rank-"));
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

/** Lets a test swap in a definition that misbehaves, for one kind. */
type Tweak = (kind: Kind, definition: AnyConnectorDefinition) => AnyConnectorDefinition;

/**
 * One boot over the database file: the three fakes in rank order, each probe
 * answering "not installed" while its kind is in `missing`, which a test may
 * change between re-probes.
 */
const bootManager = (
  filename: string,
  missing: Ref.Ref<ReadonlySet<Kind>>,
  tweak: Tweak = (_kind, definition) => definition,
) =>
  Effect.gen(function* () {
    yield* isolatedHome;
    const sqlite = Layer.succeedContext(yield* Layer.build(sqliteLayer({ filename })));
    yield* runMigrations.pipe(Effect.provide(sqlite));
    const definitions: Array<AnyConnectorDefinition> = [];
    for (const { kind, displayName, model } of HARNESSES) {
      const fake = yield* makeFakeConnector({ kind, displayName, model });
      const erased = eraseConnectorDefinition(fake.definition);
      definitions.push(
        tweak(kind, {
          ...erased,
          probe: (config: unknown) =>
            Effect.flatMap(Ref.get(missing), (gone) =>
              gone.has(kind) ? Effect.succeed(notInstalled) : erased.probe(config),
            ),
        }),
      );
    }
    const registry = yield* makeRegistry(definitions);
    const unrunnable = yield* Ref.make<ReadonlySet<ConnectorInstanceId>>(new Set());
    const ctx = yield* Layer.build(
      ConnectorManager.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            SettingsStore.layer,
            ConnectorHost.layer,
            Layer.succeed(ConnectorRegistryService, registry),
            Layer.succeed(UnrunnableConnectors, unrunnable),
          ),
        ),
        Layer.provideMerge(sqlite),
      ),
    );
    const manager = Context.get(ctx, ConnectorManager);
    yield* manager.ready;
    return {
      manager,
      store: Context.get(ctx, SettingsStore),
      registry,
      sql: Context.get(ctx, SqlClientTag.SqlClient),
      unrunnable,
    } satisfies Booted;
  });

const withBoot = <A, E>(
  filename: string,
  missing: ReadonlySet<Kind>,
  run: (booted: Booted, missing: Ref.Ref<ReadonlySet<Kind>>) => Effect.Effect<A, E>,
  tweak?: Tweak,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const gone = yield* Ref.make(missing);
      return yield* run(yield* bootManager(filename, gone, tweak), gone);
    }),
  );

/** The first settings value `pred` holds for, replaying the current one — never a timer. */
const awaitSettings = (store: SettingsStore["Service"], pred: (settings: Settings) => boolean) =>
  store.changes.pipe(Stream.filter(pred), Stream.runHead, Effect.map(Option.getOrThrow));

/**
 * Writes the owner's document as a build from before the rank left it: no
 * `offeredConnectorKinds`, no `connectorMigrations`.
 */
const writeLegacyRow = (filename: string, settings: Settings) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(sqliteLayer({ filename }));
      yield* runMigrations.pipe(Effect.provide(Layer.succeedContext(context)));
      const sql = Context.get(context, SqlClientTag.SqlClient);
      const {
        offeredConnectorKinds: _offered,
        connectorMigrations: _migrations,
        ...legacy
      } = Schema.encodeUnknownSync(Settings)(settings) as Record<string, unknown>;
      yield* sql`
        INSERT INTO settings (key, value_json, updated_at)
        VALUES ('settings', ${JSON.stringify(legacy)}, ${new Date().toISOString()})
      `;
    }),
  );

const databaseFile = () =>
  nodePath.join(mkdtempSync(nodePath.join(tmpdir(), "poseidon-rank-db-")), "state.sqlite");

/** An owner-like row on disk: Command Code, then Claude Code, and a Command Code default. */
const ownerRow = (filename: string, model: string) =>
  Effect.gen(function* () {
    const cmd = entry("cmd", "Command Code");
    const claude = entry("claude", "Claude Code");
    yield* writeLegacyRow(filename, {
      ...defaultSettings(),
      connectors: [cmd, claude],
      defaults: { ...defaultSettings().defaults, model },
      onboardingCompleted: true,
    });
    return { cmd, claude };
  });

const threadId = makeThreadId();

/** A thread with only what routing reads; `chosen` is its own pick. */
const routedThread = (chosen?: ConnectorInstanceId) =>
  ({
    threadId,
    settings: {
      model: "any",
      runtimeMode: "approval-required",
      interactionMode: "default",
      ...(chosen === undefined ? {} : { connectorInstanceId: chosen }),
    },
  }) as ThreadDoc;

/**
 * What the engine seeds a new thread with, and where the entrypoint's
 * selection then sends its first turn: the engine pins a thread that chose
 * nothing to the instance it seeded from.
 */
const route = ({ registry, sql, unrunnable }: Booted, chosen?: ConnectorInstanceId) =>
  Effect.gen(function* () {
    const open = Effect.map(registry.instances, (all) => all.map((one) => one.instanceId));
    const models = (instanceId: ConnectorInstanceId) =>
      registry.instance(instanceId).pipe(
        Effect.flatMap((one) => one.listModels()),
        Effect.map((listed) => listed.map((model) => model.id)),
        Effect.orDie,
      );
    const seeded = yield* seedModel(sql, open, models, chosen, Ref.get(unrunnable));
    const selection = yield* Effect.scoped(
      Effect.map(
        Layer.build(
          ConnectorSelection.fromRegistry(registry, routingPreference(sql, Ref.get(unrunnable))),
        ),
        (built) => Context.get(built, ConnectorSelection),
      ),
    );
    const pinned = chosen ?? seeded?.connectorInstanceId ?? undefined;
    const instance = yield* selection.instanceFor(routedThread(pinned));
    return { instanceId: instance.instanceId, model: seeded?.model ?? null };
  });

describe("ConnectorManager and the harness rank", () => {
  it.effect("an owner's install is ranked, given Codex once and taken off Command Code", () =>
    Effect.gen(function* () {
      const filename = databaseFile();
      const { cmd, claude } = yield* ownerRow(filename, CMD_MODEL);

      const upgraded = yield* withBoot(filename, new Set(), ({ store }) =>
        awaitSettings(store, (settings) =>
          settings.connectorMigrations.includes(DEFAULT_MODEL_MIGRATION),
        ),
      );
      expect(upgraded.connectors.map((conn) => conn.kind)).toEqual(["claude", "codex", "cmd"]);
      // The two it had are the same instances, moved; Codex is new.
      expect(upgraded.connectors[0]!.connectorInstanceId).toBe(claude.connectorInstanceId);
      expect(upgraded.connectors[2]!.connectorInstanceId).toBe(cmd.connectorInstanceId);
      expect(upgraded.connectors[1]).toMatchObject({ displayName: "Codex", enabled: true });
      // Neither harness ahead of Command Code runs its model, so New task and
      // the engine's seed now start where routing does.
      expect(upgraded.defaults.model).toBeNull();
      expect(upgraded.offeredConnectorKinds).toEqual(["claude", "codex", "cmd"]);
      expect(upgraded.connectorMigrations).toEqual([RANK_MIGRATION, DEFAULT_MODEL_MIGRATION]);

      // The next boot finds nothing to do, and the user removing Codex holds.
      yield* withBoot(filename, new Set(), ({ manager, store }) =>
        Effect.gen(function* () {
          yield* manager.list(true);
          expect(yield* store.get).toEqual(upgraded);
          yield* store.update({
            connectors: upgraded.connectors.filter((conn) => conn.kind !== "codex"),
          });
        }),
      );
      const last = yield* withBoot(filename, new Set(), ({ manager, store }) =>
        Effect.andThen(manager.list(true), store.get),
      );
      expect(last.connectors.map((conn) => conn.kind)).toEqual(["claude", "cmd"]);
      expect(last.defaults.model).toBeNull();
    }),
  );

  it.effect("a default model waits while no harness ahead of Command Code can run", () =>
    Effect.gen(function* () {
      const filename = databaseFile();
      yield* ownerRow(filename, CMD_MODEL);

      yield* withBoot(filename, new Set<Kind>(["claude", "codex"]), ({ manager, store }, gone) =>
        Effect.gen(function* () {
          // A refresh settles the check before it answers.
          yield* manager.list(true);
          const waiting = yield* store.get;
          expect(waiting.connectors.map((conn) => conn.kind)).toEqual(["claude", "codex", "cmd"]);
          expect(waiting.defaults.model).toBe(CMD_MODEL);
          expect(waiting.connectorMigrations).toEqual([RANK_MIGRATION]);

          // Installing Codex and pressing re-check is enough, in the same boot.
          yield* Ref.set(gone, new Set<Kind>(["claude"]));
          yield* manager.list(true);
          const settled = yield* store.get;
          expect(settled.defaults.model).toBeNull();
          expect(settled.connectorMigrations).toContain(DEFAULT_MODEL_MIGRATION);
        }),
      );
    }),
  );

  it.effect("a default model of a harness that cannot run this boot is kept", () =>
    Effect.gen(function* () {
      const filename = databaseFile();
      yield* ownerRow(filename, CODEX_MODEL);
      // Codex is signed out or not found this boot, but its instance still
      // lists the model: the user's choice is not the check's to undo.
      const settled = yield* withBoot(filename, new Set<Kind>(["codex"]), ({ store }) =>
        awaitSettings(store, (settings) =>
          settings.connectorMigrations.includes(DEFAULT_MODEL_MIGRATION),
        ),
      );
      expect(settled.defaults.model).toBe(CODEX_MODEL);
    }),
  );

  it.effect("the default-model check writes over no default changed while it asked", () =>
    Effect.gen(function* () {
      const filename = databaseFile();
      yield* ownerRow(filename, CMD_MODEL);
      const asked = yield* Deferred.make<void>();
      const answer = yield* Deferred.make<void>();
      // Codex's probe finds no models, so the check asks its instance, which
      // answers only once the test has changed the defaults under it.
      const slowCodex: Tweak = (kind, definition) =>
        kind !== "codex"
          ? definition
          : {
              ...definition,
              probe: (config) =>
                Effect.map(definition.probe(config), (probe) => ({ ...probe, models: [] })),
              createInstance: (input) =>
                Effect.map(definition.createInstance(input), (instance) => ({
                  ...instance,
                  listModels: () =>
                    Effect.andThen(
                      Deferred.succeed(asked, undefined),
                      Effect.andThen(Deferred.await(answer), instance.listModels()),
                    ),
                })),
            };
      const settled = yield* withBoot(
        filename,
        new Set(),
        ({ store }) =>
          Effect.gen(function* () {
            yield* Deferred.await(asked);
            const current = yield* store.get;
            yield* store.update({
              defaults: { ...current.defaults, model: CLAUDE_MODEL, effort: "high" },
            });
            yield* Deferred.succeed(answer, undefined);
            return yield* awaitSettings(store, (settings) =>
              settings.connectorMigrations.includes(DEFAULT_MODEL_MIGRATION),
            );
          }),
        slowCodex,
      );
      expect(settled.defaults.model).toBe(CLAUDE_MODEL);
      expect(settled.defaults.effort).toBe("high");
    }),
  );

  it.effect("a settings row that cannot be decoded is not rewritten at boot", () =>
    Effect.gen(function* () {
      const filename = databaseFile();
      const corrupt = JSON.stringify({ theme: "dark", writtenByANewerBuild: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(sqliteLayer({ filename }));
          yield* runMigrations.pipe(Effect.provide(Layer.succeedContext(context)));
          const sql = Context.get(context, SqlClientTag.SqlClient);
          yield* sql`
            INSERT INTO settings (key, value_json, updated_at)
            VALUES ('settings', ${corrupt}, ${new Date().toISOString()})
          `;
        }),
      );
      yield* withBoot(filename, new Set(), ({ manager, sql }) =>
        Effect.gen(function* () {
          yield* manager.list(true);
          const rows = yield* sql<{ readonly value_json: string }>`
            SELECT value_json FROM settings WHERE key = 'settings'
          `;
          expect(rows.map((row) => row.value_json)).toEqual([corrupt]);
        }),
      );
    }),
  );

  it.effect("a save over an undecodable row is seeded in the same session", () =>
    Effect.gen(function* () {
      const filename = databaseFile();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(sqliteLayer({ filename }));
          yield* runMigrations.pipe(Effect.provide(Layer.succeedContext(context)));
          const sql = Context.get(context, SqlClientTag.SqlClient);
          yield* sql`
            INSERT INTO settings (key, value_json, updated_at)
            VALUES ('settings', ${JSON.stringify({ theme: 7 })}, ${new Date().toISOString()})
          `;
        }),
      );
      // The user's save archives the row and stores defaults under its patch:
      // no connectors, and no kinds offered. That is a first run's document,
      // and it is seeded at once rather than on the next boot.
      const seeded = yield* withBoot(filename, new Set(), ({ store }) =>
        Effect.andThen(
          store.update({ theme: "dark" }),
          awaitSettings(store, (settings) => settings.connectors.length > 0),
        ),
      );
      expect(seeded.theme).toBe("dark");
      expect(seeded.connectors.map((conn) => conn.kind)).toEqual(["claude", "codex", "cmd"]);

      // And the next boot keeps them, as any user's document.
      const next = yield* withBoot(filename, new Set(), ({ manager, store }) =>
        Effect.andThen(manager.list(true), store.get),
      );
      expect(next.connectors.map((conn) => conn.kind)).toEqual(["claude", "codex", "cmd"]);
    }),
  );

  it.effect("a default model a harness ahead of Command Code runs is kept", () =>
    Effect.gen(function* () {
      const filename = databaseFile();
      yield* ownerRow(filename, CODEX_MODEL);
      const settled = yield* withBoot(filename, new Set(), ({ store }) =>
        awaitSettings(store, (settings) =>
          settings.connectorMigrations.includes(DEFAULT_MODEL_MIGRATION),
        ),
      );
      expect(settled.defaults.model).toBe(CODEX_MODEL);
    }),
  );

  it.effect("the default rule passes over a harness that cannot run, on both sides", () =>
    Effect.gen(function* () {
      const filename = databaseFile();
      yield* withBoot(filename, new Set<Kind>(["claude"]), (booted, gone) =>
        Effect.gen(function* () {
          const { manager, store } = booted;
          // A fresh install: seeded in rank order, then probed.
          yield* manager.list(true);
          const [claude, codex, cmd] = (yield* store.get).connectors;
          expect([claude!.kind, codex!.kind, cmd!.kind]).toEqual(["claude", "codex", "cmd"]);

          // Claude Code is not installed, so a thread that chose nothing runs
          // on Codex, and is seeded with Codex's model rather than Claude's.
          expect(yield* route(booted)).toEqual({
            instanceId: codex!.connectorInstanceId,
            model: CODEX_MODEL,
          });
          // A thread that chose Claude Code keeps it: the health banner says why
          // it cannot run, and the choice was the user's.
          expect(yield* route(booted, claude!.connectorInstanceId)).toEqual({
            instanceId: claude!.connectorInstanceId,
            model: CLAUDE_MODEL,
          });

          // Codex gone too: Command Code.
          yield* Ref.set(gone, new Set<Kind>(["claude", "codex"]));
          yield* manager.list(true);
          expect((yield* route(booted)).instanceId).toBe(cmd!.connectorInstanceId);

          // Nothing can run: the first enabled one, as before the rule existed.
          yield* Ref.set(gone, new Set<Kind>(["claude", "codex", "cmd"]));
          yield* manager.list(true);
          expect(yield* route(booted)).toEqual({
            instanceId: claude!.connectorInstanceId,
            model: CLAUDE_MODEL,
          });

          // And back: Claude Code installed, Claude Code again.
          yield* Ref.set(gone, new Set<Kind>());
          yield* manager.list(true);
          expect((yield* route(booted)).instanceId).toBe(claude!.connectorInstanceId);
        }),
      );
    }),
  );

  it.effect("a saved default model starts a thread on the harness that lists it", () =>
    Effect.gen(function* () {
      const filename = databaseFile();
      yield* withBoot(filename, new Set(), (booted) =>
        Effect.gen(function* () {
          const { manager, store } = booted;
          yield* manager.list(true);
          const current = yield* store.get;
          const [, codex] = current.connectors;
          // Claude Code routes first, but the default is Codex's model: the
          // thread goes where the model is, as New task's pick does.
          yield* store.update({ defaults: { ...current.defaults, model: CODEX_MODEL } });
          expect(yield* route(booted)).toEqual({
            instanceId: codex!.connectorInstanceId,
            model: CODEX_MODEL,
          });
        }),
      );
    }),
  );

  it.effect("a probe that crashed or timed out moves nothing", () =>
    Effect.gen(function* () {
      const filename = databaseFile();
      // The manager's stand-in for such a probe says `installed: false`; it
      // found nothing, and an installed Claude Code must stay the default.
      const crashingClaude: Tweak = (kind, definition) =>
        kind !== "claude"
          ? definition
          : {
              ...definition,
              probe: () => Effect.fail(new ProbeFailed({ kind, message: "killed" })),
            };
      yield* withBoot(
        filename,
        new Set(),
        (booted) =>
          Effect.gen(function* () {
            const summaries = yield* booted.manager.list(true);
            expect(summaries[0]).toMatchObject({ kind: "claude", probe: { status: "error" } });
            expect(yield* Ref.get(booted.unrunnable)).toEqual(new Set());
            expect((yield* route(booted)).instanceId).toBe(summaries[0]!.connectorInstanceId);
          }),
        crashingClaude,
      );
    }),
  );

  it.effect("each probe is pushed as it lands, with routing already moved", () =>
    Effect.gen(function* () {
      const filename = databaseFile();
      const claudeAnswers = yield* Deferred.make<void>();
      const codexAnswers = yield* Deferred.make<void>();
      // Claude Code turns out missing, and Codex's probe is still running
      // behind it: the pass is not over when Claude Code's result is known.
      const held: Tweak = (kind, definition) =>
        kind === "claude"
          ? { ...definition, probe: () => Effect.as(Deferred.await(claudeAnswers), notInstalled) }
          : kind === "codex"
            ? {
                ...definition,
                probe: (config) =>
                  Effect.andThen(Deferred.await(codexAnswers), definition.probe(config)),
              }
            : definition;
      yield* withBoot(
        filename,
        new Set(),
        ({ manager, unrunnable }) =>
          Effect.gen(function* () {
            // Admitted before any probe: the first list names every entry.
            const first = yield* manager.changes.pipe(
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
            expect(first.map((summary) => summary.probe.status)).toEqual([
              "probing",
              "probing",
              "probing",
            ]);

            yield* Deferred.succeed(claudeAnswers, undefined);
            const landed = yield* manager.changes.pipe(
              Stream.filter((all) => all[0]?.probe.status === "not-installed"),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
            expect(landed[1]!.probe.status).toBe("probing");
            // The server's rule took it in no later than the renderer can see it.
            expect(yield* Ref.get(unrunnable)).toEqual(new Set([landed[0]!.connectorInstanceId]));
            yield* Deferred.succeed(codexAnswers, undefined);
          }),
        held,
      );
    }),
  );
});
