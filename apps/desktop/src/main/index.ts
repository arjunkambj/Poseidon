/**
 * App lifecycle glue: single instance, protocol privileges, the browser
 * bridge, the server supervisor, and window creation. Everything else lives in
 * the modules alongside (`protocol`, `window`, `ipc`, `attentionIpc`,
 * `quitGuard`, `updater`, `browser/`, and `../platform`).
 */
import { BrowserWindow, app, protocol, session } from "electron";

import { ServerSupervisor } from "../backend/ServerSupervisor";
import { serverSpawnSpec, showServerCrashDialog } from "../backend/serverDeps";
import type { BridgeForServer } from "../backend/serverEnv";
import { registerAttentionIpc, showWindow } from "./attentionIpc";
import { QUIT_REQUEST_CHANNEL } from "./attention";
import { makePointerRelay, POINTER_CHANNEL } from "./browser/agentPointer";
import { createGuestRegistry } from "./browser/guests";
import { startPaneBridge } from "./browser/start";
import { makeTabsChannel } from "./browser/tabsChannel";
import { registerIpc } from "./ipc";
import { applyDevDockIcon, applyPlatformDefaults } from "../platform";
import { resolveBrowserBridge } from "../platform/browserBridge";
import { quitsWhenAllWindowsClosed } from "../platform/lifecycle";
import { APP_SCHEME, registerAppProtocol } from "./protocol";
import { makeQuitHandler } from "./quit";
import { holdsWindowClose, makeQuitGuard } from "./quitGuard";
import { checkForUpdates } from "./updater";
import { createWindow } from "./window";

applyPlatformDefaults();

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
    },
  },
]);

/** How long a quit waits for the server child before exiting without it. */
const QUIT_DEADLINE_MS = 15_000;

const focusExistingWindow = () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win === undefined) return;
  if (win.isMinimized()) win.restore();
  win.focus();
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", focusExistingWindow);

  const bridgeSetting = resolveBrowserBridge(process.env);
  if (bridgeSetting.kind === "disabled") {
    console.warn(`[browser-bridge] ${bridgeSetting.reason}`);
  }
  /** What the server is told on every (re)spawn; set before the first one. */
  let bridge: BridgeForServer = { kind: "disabled" };
  let closeBridge: () => Promise<void> = async () => undefined;

  const windowContents = () =>
    BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())?.webContents ?? null;
  const tabs = makeTabsChannel({ window: windowContents });
  // The agent's pointer, for the cursor the pane draws over its tab.
  const pointer = makePointerRelay({
    send: (moved) => windowContents()?.send(POINTER_CHANNEL, moved),
  });
  const guests = createGuestRegistry({
    fromPartition: (partition) => session.fromPartition(partition),
    tabs,
    debug: bridgeSetting.kind === "enabled",
    log: (entry) => console.info(`[browser-guests] ${JSON.stringify(entry)}`),
  });

  // Filled in once the attention handlers are registered; until then nothing
  // is running, so a quit is never held.
  let busyCount: () => number = () => 0;
  const quitGuard = makeQuitGuard({
    busyCount: () => busyCount(),
    ask: () => {
      const contents = windowContents();
      if (contents === null) return false;
      contents.send(QUIT_REQUEST_CHANNEL);
      showWindow();
      return true;
    },
    quit: () => app.quit(),
  });

  const supervisor = new ServerSupervisor({
    spec: () => serverSpawnSpec(bridge),
    onRepeatedFailure: showServerCrashDialog,
  });

  void app.whenReady().then(async () => {
    applyDevDockIcon();
    registerAppProtocol();
    registerIpc(supervisor, { guests, tabs });
    busyCount = registerAttentionIpc({
      windowContents,
      onQuitAnswer: quitGuard.answer,
    }).busyCount;
    if (bridgeSetting.kind === "enabled") {
      const started = await startPaneBridge(guests.port, pointer);
      bridge = started.forServer;
      if (started.server !== null) closeBridge = started.server.close;
    }
    supervisor.start();
    checkForUpdates();
    await createWindow({ panes: guests });

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow({ panes: guests });
      }
    });
  });
  app.on("will-quit", () => void closeBridge());

  const serverQuit = makeQuitHandler({
    stopServer: () => supervisor.stop(),
    onWaiting: () => {
      for (const win of BrowserWindow.getAllWindows()) win.hide();
    },
    exit: () => app.exit(),
    // The server closes sessions one by one under their own timeouts; the
    // supervisor's own SIGKILL lands well inside this.
    deadlineMs: QUIT_DEADLINE_MS,
  });
  /** Set once a quit is past the guard, so its window closes are not held. */
  let quitting = false;
  // One listener: the guard may hold the quit to ask first; otherwise the
  // graceful server shutdown runs exactly as it always has.
  app.on("before-quit", (event) => {
    if (quitGuard.onBeforeQuit(event)) return;
    quitting = true;
    serverQuit(event);
  });
  // Where closing the last window quits, the window would be gone before the
  // guard could ask it; so while threads are busy that close is held and
  // turned into a quit, which the guard asks about like any other.
  app.on("browser-window-created", (_event, win) => {
    win.on("close", (event) => {
      const hold = holdsWindowClose({
        quitsOnLastClose: quitsWhenAllWindowsClosed(process.platform),
        quitting,
        otherWindows: BrowserWindow.getAllWindows().filter(
          (other) => other !== win && !other.isDestroyed(),
        ).length,
        busy: busyCount(),
      });
      if (!hold) return;
      event.preventDefault();
      app.quit();
    });
  });
  app.on("window-all-closed", () => {
    if (quitsWhenAllWindowsClosed(process.platform)) app.quit();
  });
}
