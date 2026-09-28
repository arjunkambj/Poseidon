/**
 * Schema migrations, numbered and run in order.
 *
 * The migration list is a static record: keys are `<id>_<name>` and ids must
 * be contiguous starting at 1 — the lineage test enforces both, because an
 * out-of-order or renumbered migration would corrupt the databases it runs
 * against after release. New migrations append at the next id; existing files
 * are never edited once merged.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { MigrationError } from "effect/unstable/sql/Migrator";
import * as Migrator from "effect/unstable/sql/Migrator";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import m0001 from "./migrations/0001_events";
import m0002 from "./migrations/0002_projections";
import m0003 from "./migrations/0003_settings";
import m0004 from "./migrations/0004_projector_version";
import m0005 from "./migrations/0005_events_type_index";
import m0006 from "./migrations/0006_terminal_keybinding";
import m0007 from "./migrations/0007_dock_keys_new_task";
import m0008 from "./migrations/0008_message_search";

/** The migration record in apply order. `fromRecord` sorts by id. */
export const migrations = {
  "0001_events": m0001,
  "0002_projections": m0002,
  "0003_settings": m0003,
  "0004_projector_version": m0004,
  "0005_events_type_index": m0005,
  "0006_terminal_keybinding": m0006,
  "0007_dock_keys_new_task": m0007,
  "0008_message_search": m0008,
} as const;

export type MigrationKey = keyof typeof migrations;

/** Applies every pending migration, each in its own transaction. */
export const runMigrations: Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  MigrationError | SqlError,
  SqlClient.SqlClient
> = Migrator.make({})({
  loader: Migrator.fromRecord(migrations),
  table: "schema_migrations",
});

/**
 * The migrations as a layer. Every layer that reads a table provides this, so
 * the graph itself says "the schema exists first": building a store over a
 * client whose tables do not exist used to fail at the first query instead,
 * and only `OrchestrationEngine.layer` ran the migrations at all.
 */
export const layer: Layer.Layer<never, MigrationError | SqlError, SqlClient.SqlClient> =
  Layer.effectDiscard(runMigrations);
