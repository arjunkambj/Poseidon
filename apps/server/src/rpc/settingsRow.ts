/**
 * The settings document's own row in the `settings` table, as `SettingsStore`
 * reads it at boot, and where it archives a row this build cannot decode.
 */

import { migrateLegacyKeybindingTable } from "@poseidon/contracts/keybindings";
import { defaultSettings, Settings } from "@poseidon/contracts/settings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export const SETTINGS_ROW_KEY = "settings";

/**
 * The server has no defaults of its own: `defaultSettings` and
 * `DEFAULT_KEYBINDINGS` in the contracts are the one copy, and the stored
 * keybindings are only the user's overrides on top of them. A second copy here
 * would silently drift (it did — it shipped an empty keybinding table, which
 * disabled every shortcut in the app back when a table was the whole keymap).
 */

/**
 * Where a row this build cannot decode is kept. One field from a newer build,
 * or one truncated write, used to be swallowed silently and then overwritten
 * by the first save — taking the user's connector instances and permission
 * rules with it. The raw text is copied here instead, and never clobbered, so
 * a downgrade or a hand repair still has the original.
 */
export const SETTINGS_UNREADABLE_ROW_KEY = "settings.unreadable";

/**
 * A stored document with its keybindings as overrides. One written before the
 * marker existed holds the whole keymap of the build that wrote it, and served
 * as it is it would shadow every default added since; it is served migrated
 * instead, and the first write through `update` (which reads through here)
 * persists that. Migrating an untouched row again gives the same answer, so a
 * restart before any write changes nothing. A document that has the marker is
 * served exactly as written: an unbound command is a choice the user made.
 */
const withKeybindingOverrides = (settings: Settings): Settings =>
  settings.keybindingsFormat === "overrides"
    ? settings
    : {
        ...settings,
        keybindings: migrateLegacyKeybindingTable(settings.keybindings),
        keybindingsFormat: "overrides",
      };

/**
 * The document at boot. `freshInstall` when there is no row; `unreadable`
 * holds the raw text of a row that does not decode, which is served as the
 * defaults; `replacedUnreadable` when such a row was archived by a save, on
 * any boot so far — the archive is never removed.
 */
export const loadSettingsRow = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly value_json: string }>`
      SELECT value_json FROM settings WHERE key = ${SETTINGS_ROW_KEY}
    `;
    if (rows.length === 0) {
      return {
        settings: defaultSettings(),
        freshInstall: true,
        unreadable: null,
        replacedUnreadable: false,
      };
    }
    const raw = rows[0]!.value_json;
    const decoded = yield* Effect.exit(Schema.decodeEffect(Schema.fromJsonString(Settings))(raw));
    if (decoded._tag === "Failure") {
      yield* Effect.logError("settings row could not be decoded; serving defaults", decoded.cause);
      return {
        settings: defaultSettings(),
        freshInstall: false,
        unreadable: raw,
        replacedUnreadable: false,
      };
    }
    const archived = yield* sql<{ readonly key: string }>`
      SELECT key FROM settings WHERE key = ${SETTINGS_UNREADABLE_ROW_KEY}
    `;
    return {
      settings: withKeybindingOverrides(decoded.value),
      freshInstall: false,
      unreadable: null,
      replacedUnreadable: archived.length > 0,
    };
  });
