/**
 * Web permissions for the browser pane's `persist:thread-<id>` sessions.
 *
 * A session with no permission handler approves every request and every check,
 * so without these a page the agent browsed to could launch any registered
 * URL-scheme app (`openExternal` — the path a top-level navigation to an
 * unknown scheme takes), read the clipboard, or reach the camera, location,
 * notifications and the local network, all without a prompt. Pane pages are
 * untrusted, so each pane session denies by default and grants only what a
 * page needs to render and copy: going fullscreen, and writing plain text to
 * the clipboard. Device access (USB, HID, serial) is denied the same way.
 *
 * Each session is secured once, before its first guest attaches (from the
 * attach policy in `../window.ts`), and again at guest creation as a net;
 * both are no-ops after the first.
 *
 * Only `electron` types are imported, so the policy runs against fakes.
 */
import type { Session } from "electron";

/** The only permissions a pane page is granted. */
const PANE_ALLOWED: ReadonlySet<string> = new Set(["fullscreen", "clipboard-sanitized-write"]);

/** Whether a pane page may have `permission`. */
export const panePermissionAllowed = (permission: string): boolean => PANE_ALLOWED.has(permission);

/** The part of a `Session` that carries its permission handlers. */
export type PermissionSession = Pick<
  Session,
  "setPermissionRequestHandler" | "setPermissionCheckHandler" | "setDevicePermissionHandler"
>;

const secured = new WeakSet<PermissionSession>();

/** Installs the pane's deny-by-default handlers on `session`, once. */
export const securePaneSession = (session: PermissionSession): void => {
  if (secured.has(session)) return;
  secured.add(session);
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(panePermissionAllowed(permission));
  });
  session.setPermissionCheckHandler((_contents, permission) => panePermissionAllowed(permission));
  session.setDevicePermissionHandler(() => false);
};
