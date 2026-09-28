/**
 * Whether the shell starts the browser bridge, and the Chromium switches it
 * refuses to run with.
 *
 * The in-app browser is driven through the bridge in `../main/browser/` — a
 * loopback CDP endpoint scoped to the pane webviews, behind a per-launch
 * capability (docs/architecture.md, "The browser bridge"). It is on by
 * default, because it exposes nothing but the pane. `POSEIDON_REMOTE_DEBUG=0`
 * (or `false`) is the kill switch: no bridge, and the desktop browser tools
 * report that the in-app browser is disabled. Any other value is ignored.
 *
 * Chromium's own remote-debugging port is never opened: it exposes the app
 * window, the RPC token the preload hands the renderer, and every partition.
 * The switches that would open it are removed from the command line even when
 * the app was launched with them, before Chromium reads them at startup.
 *
 * Electron-free: `./index` hands the real `app.commandLine` in.
 */

export type BrowserBridgeSetting =
  | { readonly kind: "enabled" }
  | { readonly kind: "disabled"; readonly reason: string };

/**
 * What the shell logs at startup when the kill switch is on. Only the log
 * reads it: the tools answer the server's own `BROWSER_DISABLED_MESSAGE`, and
 * the pane and the settings page show their own disabled text.
 */
export const KILL_SWITCH_REASON = "POSEIDON_REMOTE_DEBUG=0 turned the in-app browser off";

export const resolveBrowserBridge = (env: NodeJS.ProcessEnv): BrowserBridgeSetting => {
  const flag = env["POSEIDON_REMOTE_DEBUG"]?.trim().toLowerCase();
  return flag === "0" || flag === "false"
    ? { kind: "disabled", reason: KILL_SWITCH_REASON }
    : { kind: "enabled" };
};

/**
 * Every switch that opens, widens or redirects Chromium's DevTools endpoint.
 * `remote-debugging-pipe` is on the list too: it hands the endpoint to
 * whoever holds the process's fds 3 and 4.
 */
export const REMOTE_DEBUGGING_SWITCHES = [
  "remote-debugging-port",
  "remote-debugging-address",
  "remote-debugging-pipe",
  "remote-allow-origins",
] as const;

/** The part of `Electron.CommandLine` the strip touches. */
export interface SwitchLine {
  readonly hasSwitch: (name: string) => boolean;
  readonly removeSwitch: (name: string) => void;
}

/** Removes any remote-debugging switch the app was launched with; returns what it removed. */
export const stripRemoteDebugging = (commandLine: SwitchLine): ReadonlyArray<string> => {
  const removed: Array<string> = [];
  for (const name of REMOTE_DEBUGGING_SWITCHES) {
    if (commandLine.hasSwitch(name)) {
      commandLine.removeSwitch(name);
      removed.push(name);
    }
  }
  return removed;
};
