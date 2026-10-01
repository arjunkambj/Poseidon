/**
 * The SQLite-backed settings document: what a fresh install gets, how a
 * document stored before keybinding overrides is migrated, that a current one
 * is served exactly as written, and what happens to a row this build cannot
 * read at all.
 */

import {
  makeCommandId,
  makeEventId,
  makeProjectId,
  makeRequestId,
  makeThreadId,
  type ThreadId,
} from "@poseidon/contracts/ids";
import { LEGACY_DEFAULT_KEYBINDINGS } from "@poseidon/contracts/keybindings";
import {
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_GIT_SETTINGS,
  defaultSettings,
  type Keybinding,
} from "@poseidon/contracts/settings";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EventStore, type PlannedEvent } from "../persistence/EventStore";
import { runMigrations } from "../persistence/Migrations";
import { OrchestrationEngine } from "../orchestration/Engine";
import { ReadModelStore } from "../persistence/ReadModels";
import { PermissionService } from "../permissions/PermissionService";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { SettingsStore } from "./services";

/** A migrated database, optionally pre-seeded with one raw settings row. */
const rowJson = (sql: SqlClient.SqlClient, key: string) =>
  sql<{ readonly value_json: string }>`
    SELECT value_json FROM settings WHERE key = ${key}
  `.pipe(Effect.map((rows) => rows[0]?.value_json ?? null));

const NOW = "2026-01-01T00:00:00.000Z";

/** A document as stored before the keybindings marker: no marker, a whole table. */
const legacyRow = (keybindings: ReadonlyArray<Keybinding>) => {
  const { keybindingsFormat: _format, ...rest } = defaultSettings();
  return JSON.stringify({ ...rest, theme: "dark", keybindings });
};

const planned = (
  streamId: ThreadId,
  type: string,
  payload: Record<string, unknown>,
): PlannedEvent =>
  ({
    eventId: makeEventId(),
    streamKind: "thread",
    streamId,
    occurredAt: NOW,
    actor: "connector",
    type,
    payload,
  }) as PlannedEvent;

const fixture = (row?: string) =>
  Effect.gen(function* () {
    const sqliteContext = yield* Layer.build(sqliteTestLayer());
    const sqlite = Layer.succeedContext(sqliteContext);
    yield* runMigrations.pipe(Effect.provide(sqlite));
    const sql = Context.get(sqliteContext, SqlClient.SqlClient);
    if (row !== undefined) {
      yield* sql`
        INSERT INTO settings (key, value_json, updated_at)
        VALUES ('settings', ${row}, '2026-01-01T00:00:00.000Z')
      `;
    }
    const ctx = yield* Layer.build(
      Layer.mergeAll(
        SettingsStore.layer,
        PermissionService.layer,
        OrchestrationEngine.layer.pipe(
          Layer.provide(
            Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
          ),
        ),
      ).pipe(Layer.provide(sqlite)),
    );
    return {
      store: Context.get(ctx, SettingsStore),
      // Built over the same SQLite layer on purpose: that is what makes the two
      // share one `Reactivity`, which is how a rule written here reaches there.
      permissions: Context.get(ctx, PermissionService),
      // The other writer of `permission_rules`, and the one the approval card
      // actually goes through.
      engine: Context.get(ctx, OrchestrationEngine),
      sql,
    };
  });

describe("SettingsStore", () => {
  it.effect("a fresh install overrides no keybinding, and carries the marker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { store } = yield* fixture();
        const settings = yield* store.get;
        expect(settings.keybindings).toEqual([]);
        expect(settings.keybindingsFormat).toBe("overrides");
        expect(store.freshInstall).toBe(true);
        expect(yield* store.unreadable).toBe(false);
      }),
    ),
  );

  it.effect("a legacy row holding the old default table is served as no overrides", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // What every install stored before the marker: the whole keymap of the
        // build that wrote it. Served as written, it would shadow every default
        // added since.
        const { store } = yield* fixture(legacyRow(LEGACY_DEFAULT_KEYBINDINGS));
        const settings = yield* store.get;
        expect(settings.keybindings).toEqual([]);
        expect(settings.keybindingsFormat).toBe("overrides");
        expect(settings.theme).toBe("dark");
        expect(store.freshInstall).toBe(false);
      }),
    ),
  );

  it.effect("a row written before the git settings existed reads them as defaults", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Not a decode failure served as the whole default document: the
        // user's own theme survives, and only the missing keys are filled in.
        const { git: _git, projectSettings: _projects, ...older } = defaultSettings();
        const { store, sql } = yield* fixture(JSON.stringify({ ...older, theme: "dark" }));
        const settings = yield* store.get;
        expect(settings.theme).toBe("dark");
        expect(settings.git).toEqual(DEFAULT_GIT_SETTINGS);
        expect(settings.git.branchPrefix).toBe(DEFAULT_BRANCH_PREFIX);
        expect(settings.projectSettings).toEqual({});
        expect(yield* rowJson(sql, "settings.unreadable")).toBeNull();
      }),
    ),
  );

  it.effect("a legacy row keeps a rebinding the user made", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { store } = yield* fixture(
          legacyRow(
            LEGACY_DEFAULT_KEYBINDINGS.map((row) =>
              row.command === "thread.new" ? { ...row, shortcut: "Cmd+Shift+T" } : row,
            ),
          ),
        );
        const settings = yield* store.get;
        expect(settings.keybindings).toEqual([{ command: "thread.new", shortcut: "Cmd+Shift+T" }]);
      }),
    ),
  );

  it.effect("a legacy row keeps a binding the user removed removed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { store } = yield* fixture(
          legacyRow(LEGACY_DEFAULT_KEYBINDINGS.filter((row) => row.command !== "sidebar.toggle")),
        );
        const settings = yield* store.get;
        expect(settings.keybindings).toEqual([{ command: "-sidebar.toggle", shortcut: "Cmd+B" }]);
      }),
    ),
  );

  it.effect("an update persists the migrated overrides with the marker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { store, sql } = yield* fixture(
          legacyRow(LEGACY_DEFAULT_KEYBINDINGS.filter((row) => row.command !== "skills.open")),
        );
        yield* store.update({ theme: "light" });
        const stored = JSON.parse((yield* rowJson(sql, "settings"))!) as Record<string, unknown>;
        expect(stored["keybindingsFormat"]).toBe("overrides");
        expect(stored["keybindings"]).toEqual([
          { command: "-skills.open", shortcut: "Cmd+Shift+S" },
        ]);
      }),
    ),
  );

  it.effect("a stored override table survives a restart as written", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // With the marker, the table is the user's own choice: an empty one
        // means "all defaults", and an unbound command stays unbound.
        const overrides = [{ command: "-thread.interrupt", shortcut: "Escape" }];
        const { store } = yield* fixture(
          JSON.stringify({ ...defaultSettings(), keybindings: overrides }),
        );
        expect((yield* store.get).keybindings).toEqual(overrides);
        const updated = yield* store.update({ keybindings: [] });
        expect(updated.keybindings).toEqual([]);
        expect(yield* store.get).toEqual(updated);
      }),
    ),
  );

  it.effect("an undecodable row is archived before the first write replaces it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // One field from a newer build is enough. The store cannot serve this
        // document, but overwriting it would destroy the connector instances
        // and permission rules a downgrade would otherwise still find.
        const corrupt = JSON.stringify({ theme: "dark", writtenByANewerBuild: true });
        const { store, sql } = yield* fixture(corrupt);
        expect(yield* store.unreadable).toBe(true);
        yield* store.update({ theme: "light" });
        expect(yield* store.unreadable).toBe(false);
        expect(store.unreadableAtBoot).toBe(true);

        expect(yield* rowJson(sql, "settings.unreadable")).toBe(corrupt);
        const settings = yield* store.get;
        expect(settings.theme).toBe("light");

        // A second save must not overwrite the archive with a readable row.
        yield* store.update({ theme: "dark" });
        expect(yield* rowJson(sql, "settings.unreadable")).toBe(corrupt);
      }),
    ),
  );

  it.effect("a write that fails archives nothing and keeps the raw text pending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The archive is what makes overwriting the row safe, so it has to
        // become durable in the same transaction as the overwrite. Ran outside
        // it, a rolled-back save left the copy behind and the store with
        // nothing left to archive on the next attempt.
        const corrupt = JSON.stringify({ theme: "dark", writtenByANewerBuild: true });
        const { store, sql } = yield* fixture(corrupt);

        // A trigger is the only way to make this particular write fail: there
        // is no constraint on the document a caller could violate.
        yield* sql`
          CREATE TRIGGER refuse_settings_write BEFORE UPDATE ON settings
          BEGIN SELECT RAISE(ABORT, 'refused'); END
        `;
        expect(Exit.isFailure(yield* Effect.exit(store.update({ theme: "light" })))).toBe(true);
        expect(yield* rowJson(sql, "settings.unreadable")).toBeNull();
        expect(yield* rowJson(sql, "settings")).toBe(corrupt);

        yield* sql`DROP TRIGGER refuse_settings_write`;
        yield* store.update({ theme: "light" });
        expect(yield* rowJson(sql, "settings.unreadable")).toBe(corrupt);
      }),
    ),
  );

  it.effect("a rule the approval flow appends reaches an open subscriber", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // "Allow always" writes to `permission_rules` directly, so the stored
        // document never changes and the settings page saw its list freeze at
        // whatever it loaded with.
        const { store, permissions } = yield* fixture();
        const subscribed = yield* Deferred.make<void>();
        const collected = yield* store.changes.pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        // The feed replays the current document, so the first element proves
        // the subscription exists — no timer, and no write into a gap.
        yield* Deferred.await(subscribed);

        yield* permissions.addRule({
          scope: "global",
          pattern: "Shell(git status)",
          decision: "allow",
        });

        const seen = yield* Fiber.join(collected);
        expect(seen[0]!.permissions).toEqual([]);
        expect(seen[1]!.permissions.map((rule) => rule.pattern)).toEqual(["Shell(git status)"]);
      }),
    ),
  );

  it.effect("a rule the approval card answers with reaches an open subscriber", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The path a real "allow always" takes: the engine writes the rule
        // inside the dispatch that resolves the approval, `PermissionService`
        // is never called, and the stored settings document does not change.
        // Both writers have to announce themselves, and the announcement has to
        // come after the transaction — a subscriber told to re-read while it is
        // still open can see a rule the rest of the dispatch then rolls back.
        const { store, engine } = yield* fixture();
        const projectId = makeProjectId();
        const threadId = makeThreadId();
        const requestId = makeRequestId();

        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "project.create",
          projectId,
          name: "settings",
          workspaceRoot: "/tmp/poseidon-settings-rules",
        });
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.create",
          threadId,
          projectId,
          settings: { model: "fake/model" },
        });
        yield* engine.appendThreadEvents(threadId, [
          planned(threadId, "thread.approval.opened", {
            request: {
              requestId,
              kind: "command",
              toolName: "shell_command",
              input: { command: "git status" },
              description: "Run git status",
            },
          }),
        ]);

        const subscribed = yield* Deferred.make<void>();
        const collected = yield* store.changes.pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);

        const receipt = yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.approval.respond",
          threadId,
          requestId,
          decision: "allow-always",
          pattern: "Shell(git status)",
        });
        expect(receipt.status).toBe("accepted");

        const seen = yield* Fiber.join(collected);
        expect(seen[0]!.permissions).toEqual([]);
        expect(seen[1]!.permissions.map((rule) => rule.pattern)).toEqual(["Shell(git status)"]);
      }),
    ),
  );
});
