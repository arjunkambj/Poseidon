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
import { eraseConnectorDefinition } from "@poseidon/connector-sdk/definition";
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
  it("keeps a model a harness ahead lists, clears one none does, waits for an answer", () => {
    expect(defaultModelVerdict(CODEX_MODEL, [[CLAUDE_MODEL], [CODEX_MODEL]])).toBe("keep");
    expect(defaultModelVerdict(CMD_MODEL, [[CLAUDE_MODEL], []])).toBe("clear");
    expect(defaultModelVerdict(CMD_MODEL, [[], []])).toBe("undecided");
    expect(defaultModelVerdict(CMD_MODEL, [])).toBe("undecided");
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

/**
 * One boot over the database file: the three fakes in rank order, each probe
 * answering "not installed" while its kind is in `missing`, which a test may
 * change between re-probes.
 */
const bootManager = (filename: string, missing: Ref.Ref<ReadonlySet<Kind>>) =>
  Effect.gen(function* () {
    yield* isolatedHome;
    const sqlite = Layer.succeedContext(yield* Layer.build(sqliteLayer({ filename })));
    yield* runMigrations.pipe(Effect.provide(sqlite));
    const definitions: Array<AnyConnectorDefinition> = [];
    for (const { kind, displayName, model } of HARNESSES) {
      const fake = yield* makeFakeConnector({ kind, displayName, model });
      const erased = eraseConnectorDefinition(fake.definition);
      definitions.push({
        ...erased,
        probe: (config: unknown) =>
          Effect.flatMap(Ref.get(missing), (gone) =>
            gone.has(kind) ? Effect.succeed(notInstalled) : erased.probe(config),
          ),
      });
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
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const gone = yield* Ref.make(missing);
      return yield* run(yield* bootManager(filename, gone), gone);
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

/** Where the entrypoint's selection sends a thread, and what the engine seeds it with. */
const route = ({ registry, sql, unrunnable }: Booted, chosen?: ConnectorInstanceId) =>
  Effect.gen(function* () {
    const selection = yield* Effect.scoped(
      Effect.map(
        Layer.build(
          ConnectorSelection.fromRegistry(registry, routingPreference(sql, Ref.get(unrunnable))),
        ),
        (built) => Context.get(built, ConnectorSelection),
      ),
    );
    const instance = yield* selection.instanceFor(routedThread(chosen));
    const open = Effect.map(registry.instances, (all) => all.map((one) => one.instanceId));
    const models = (instanceId: ConnectorInstanceId) =>
      registry.instance(instanceId).pipe(
        Effect.flatMap((one) => one.listModels()),
        Effect.map((listed) => listed.map((model) => model.id)),
        Effect.orDie,
      );
    const model = yield* seedModel(sql, open, models, chosen, Ref.get(unrunnable));
    return { instanceId: instance.instanceId, model };
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
});
