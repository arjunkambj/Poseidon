/**
 * One reading of "which connector a new thread belongs to".
 *
 * Two places need that answer and they must not disagree. `ConnectorSelection`
 * picks the instance a thread's turns run on, and the engine seeds a new
 * thread's model from a connector's `defaultModel` when nothing else supplies
 * one — a seeded model that names a different instance than the one the turn
 * routes to fails on the first request.
 *
 * They used to be two different rules. The engine read the first enabled entry
 * of the settings document; selection took the first instance the registry
 * happened to hold, which is the order `registry.open` was *called* in. The
 * connector manager only reopens entries whose signature changed, so disabling
 * and re-enabling a connector moved it to the end of that order and the two
 * definitions came apart: settings `[A, B]` routed to B and seeded A's model.
 *
 * So both read this instead: the enabled connectors, in the order the settings
 * document lists them — the order the connectors page shows, which is the only
 * one a user can reason about. Straight off the stored row rather than through
 * `SettingsStore`, because the engine's call runs inside its dispatch
 * transaction and the store is not in its layer graph.
 *
 * An enabled entry whose instance failed to open — a bad `binaryPath`, a
 * harness that is installed but dies on `createInstance` — is not in the
 * registry, so selection falls through to the next one that did open. The
 * seed follows it there rather than staying on the document's first entry:
 * with two connectors on different accounts a thread routed to B and seeded
 * with A's model fails its first turn on a model B has never heard of. Which
 * instances are open is `OpenConnectors`, below.
 *
 * All of that is now the fallback. A thread that chose its connector instance
 * (`ThreadSettings.connectorInstanceId`) runs on that one while it is open, and
 * its model is seeded from that one; the rule above answers only for a thread
 * that chose none, or whose choice is no longer open.
 */

import { Effort, RuntimeMode } from "@poseidon/contracts/enums";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/** The `settings` table's single row. */
const SETTINGS_KEY = "settings";

/** @public One enabled connector, as the stored settings document has it. */
export interface RoutableConnector {
  readonly connectorInstanceId: ConnectorInstanceId;
  /** What "new threads on this connector" start on, if it was filled in. */
  readonly defaultModel: string | null;
}

/** @public The routing view of the settings document. */
export interface ConnectorRouting {
  /** The app-wide default model, which outranks any connector's own. */
  readonly sharedModel: string | null;
  /** What the Models page's defaults hold besides the model, when they are filled in. */
  readonly sharedEffort: Effort | null;
  readonly sharedRuntimeMode: RuntimeMode | null;
  /** Enabled connectors, in document order. The first is the one to route to. */
  readonly enabled: ReadonlyArray<RoutableConnector>;
}

const EMPTY: ConnectorRouting = {
  sharedModel: null,
  sharedEffort: null,
  sharedRuntimeMode: null,
  enabled: [],
};

/** Straight from the contract, so a rung added there is never dropped here. */
const EFFORTS = new Set<string>(Effort.literals);
const RUNTIME_MODES = new Set<string>(RuntimeMode.literals);

/**
 * The stored document is read raw rather than decoded, so a field written by a
 * newer build cannot take routing down. That means the two enums have to be
 * checked here: an unknown string is treated as "not set" rather than handed to
 * the decider, which would put it straight onto `thread.created`.
 */
const asEffort = (value: unknown): Effort | null =>
  typeof value === "string" && EFFORTS.has(value) ? (value as Effort) : null;

const asRuntimeMode = (value: unknown): RuntimeMode | null =>
  typeof value === "string" && RUNTIME_MODES.has(value) ? (value as RuntimeMode) : null;

interface StoredSettings {
  readonly defaults?: {
    readonly model?: string | null;
    readonly effort?: unknown;
    readonly runtimeMode?: unknown;
  };
  readonly connectors?: ReadonlyArray<{
    readonly connectorInstanceId?: string;
    readonly enabled?: boolean;
    readonly config?: { readonly defaultModel?: string | null };
  }>;
}

/**
 * @public Reads the routing view. A missing or undecodable row answers empty:
 * a settings document nobody can read must not decide where turns go.
 */
export const readConnectorRouting = (
  sql: SqlClient.SqlClient,
): Effect.Effect<ConnectorRouting, SqlError> =>
  Effect.map(
    sql<{ readonly value_json: string }>`
      SELECT value_json FROM settings WHERE key = ${SETTINGS_KEY}
    `,
    (rows) => {
      const row = rows[0];
      if (row === undefined) {
        return EMPTY;
      }
      try {
        const doc = JSON.parse(row.value_json) as StoredSettings;
        return {
          sharedModel: doc.defaults?.model ?? null,
          sharedEffort: asEffort(doc.defaults?.effort),
          sharedRuntimeMode: asRuntimeMode(doc.defaults?.runtimeMode),
          enabled: (doc.connectors ?? [])
            .filter((connector) => connector.enabled === true)
            .flatMap((connector) =>
              connector.connectorInstanceId === undefined
                ? []
                : [
                    {
                      connectorInstanceId: connector.connectorInstanceId as ConnectorInstanceId,
                      defaultModel: connector.config?.defaultModel ?? null,
                    },
                  ],
            ),
        };
      } catch {
        return EMPTY;
      }
    },
  );

/**
 * @public The instance ids a new thread should be routed to, best first —
 * what `ConnectorSelection` prefers over the registry's own insertion order.
 * A read that fails must not take routing down with it, so it answers empty
 * and the registry's order stands.
 */
export const routingPreference = (
  sql: SqlClient.SqlClient,
): Effect.Effect<ReadonlyArray<ConnectorInstanceId>> =>
  readConnectorRouting(sql).pipe(
    Effect.map((routing) => routing.enabled.map((connector) => connector.connectorInstanceId)),
    Effect.catch(() => Effect.succeed([] as ReadonlyArray<ConnectorInstanceId>)),
  );

/**
 * @public Which instances the registry currently holds open, read fresh each
 * time. A `Context.Reference` because the engine is built long before the
 * registry exists in the layer graph, and because most tests have no registry
 * at all: `null` is "nobody is tracking that", and then the settings document
 * stands alone, which is what those tests already assert.
 */
export const OpenConnectors = Context.Reference<Effect.Effect<
  ReadonlyArray<ConnectorInstanceId>
> | null>("server/settings/OpenConnectors", { defaultValue: () => null });

/**
 * @public The rest of the new-thread defaults, for a `thread.create` whose
 * command patch left them out.
 *
 * `Settings.defaults` holds `{ model, effort, runtimeMode }` and the Models
 * page renders all three, but only the model was
 * ever read: a thread created after setting effort to `high` and runtime mode
 * to `full-access` still opened on `medium` / "Ask first". `null` for either
 * one means the stored document says nothing usable, and the decider's own
 * fallback stands.
 */
export const seedThreadDefaults = (
  sql: SqlClient.SqlClient,
): Effect.Effect<
  { readonly effort: Effort | null; readonly runtimeMode: RuntimeMode | null },
  SqlError
> =>
  Effect.map(readConnectorRouting(sql), (routing) => ({
    effort: routing.sharedEffort,
    runtimeMode: routing.sharedRuntimeMode,
  }));

/**
 * @public What a live connector says it can run, best first.
 *
 * A `Context.Reference` for the same reason `OpenConnectors` is one: the engine
 * is built before the registry has opened anything, and most tests have no
 * connector at all. `null` is "nobody can answer that", and then the settings
 * document stands alone.
 */
export const ConnectorModels = Context.Reference<
  ((instanceId: ConnectorInstanceId) => Effect.Effect<ReadonlyArray<string>>) | null
>("server/settings/ConnectorModels", { defaultValue: () => null });

/**
 * @public The model a `thread.create` without one starts on.
 *
 * The app-wide default outranks everything. Otherwise it is the `defaultModel`
 * of the connector this thread will actually run on — the first enabled entry
 * that is open, which is exactly what `ConnectorSelection` picks. When none of
 * the enabled entries is open, selection falls back to whatever the registry
 * holds and no document entry can speak for it, so nothing is seeded and the
 * thread starts on that connector's own default instead of a foreign model.
 *
 * Last comes the connector itself. A fresh install has filled in none of the
 * three: `defaultSettings()` writes `model: null`, the connector seed writes
 * the kind's empty `defaultConfig()`, and nothing ever fills either from a
 * probe — so every `thread.create` was rejected and the app could not be used
 * until the user found Settings → Models by themselves. Asking the routed
 * instance for its first model is what makes the first thread possible, and it
 * names a model that instance certainly has.
 *
 * A thread that chose its instance (`chosen`) skips all of that while the
 * instance is open: its `defaultModel`, then its first model. The app-wide
 * default does not outrank it there — it is one model, and it may well belong
 * to another harness. Only when the chosen instance has neither, or is not
 * open (so the turn will be routed by the default rule anyway), does the rule
 * above answer. A model named on the command itself outranks all of this; the
 * engine does not ask for a seed then.
 */
export const seedModel = (
  sql: SqlClient.SqlClient,
  open: Effect.Effect<ReadonlyArray<ConnectorInstanceId>> | null,
  models: ((instanceId: ConnectorInstanceId) => Effect.Effect<ReadonlyArray<string>>) | null = null,
  chosen?: ConnectorInstanceId,
): Effect.Effect<string | null, SqlError> =>
  Effect.gen(function* () {
    const routing = yield* readConnectorRouting(sql);
    const openIds = open === null ? null : yield* open;
    if (chosen !== undefined) {
      const entry = routing.enabled.find((connector) => connector.connectorInstanceId === chosen);
      // With nobody tracking the registry, the document's enabled list is the
      // only reading of "open" there is — the same one selection falls back to.
      const isOpen = openIds === null ? entry !== undefined : openIds.includes(chosen);
      if (isOpen) {
        if (entry?.defaultModel != null) {
          return entry.defaultModel;
        }
        const first = models === null ? undefined : (yield* models(chosen))[0];
        if (first !== undefined) {
          return first;
        }
      }
    }
    if (routing.sharedModel !== null) {
      return routing.sharedModel;
    }
    const routed =
      openIds === null
        ? routing.enabled[0]
        : routing.enabled.find((connector) => openIds.includes(connector.connectorInstanceId));
    if (routed?.defaultModel != null) {
      return routed.defaultModel;
    }
    if (models === null) {
      return null;
    }
    // Whichever instance the turn would run on: the routed entry when there is
    // one, and otherwise the instance `ConnectorSelection` falls back to.
    const instanceId = routed?.connectorInstanceId ?? openIds?.[0];
    if (instanceId === undefined) {
      return null;
    }
    return (yield* models(instanceId))[0] ?? null;
  });
