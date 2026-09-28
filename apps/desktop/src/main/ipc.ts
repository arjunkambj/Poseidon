/**
 * ipcMain handlers backing the preload bridge: connection info, server-state
 * fan-out, validated external opens, directory picking, and the browser pane's
 * guests.
 *
 * Every pane webview guest is set up once, the moment it is created
 * (`web-contents-created`), never again on a remount:
 * - its `window.open` handler, which always denies the native window and
 *   turns an http(s) popup into a pane tab of the same thread, rate-limited,
 *   capped and in the background unless the page has focus
 *   (`./browser/popups.ts`);
 * - its session's deny-by-default web permissions (`./browser/permissions.ts`),
 *   already installed at attach;
 * - the human-input relay (`./browser/guestInput.ts`), tagged with the
 *   guest's thread and `webContents` id;
 * - the pane's keys (`./browser/guestChords.ts`): a chord the window sent
 *   over is swallowed in the page and relayed as its command, and the default
 *   menu's window reload never fires from inside a page;
 * - the bridge registry (`./browser/guests.ts`), which attaches its debugger
 *   when the bridge is running.
 * The window answers tab requests (`./browser/tabsChannel.ts`) on its own
 * channel, asks for a deleted thread's partition to be cleared
 * (`./browser/clearThread.ts`), and asks for a PNG of a pane tab.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, session, shell, webContents } from "electron";
import type { WebContents } from "electron";

import type { ServerSupervisor } from "../backend/ServerSupervisor";

import { makeClearAll, makeClearThread } from "./browser/clearThread";
import {
  CHORDS_CHANNEL,
  COMMAND_CHANNEL,
  decideChord,
  parseChords,
  type GuestChord,
  type GuestCommandPayload,
} from "./browser/guestChords";
import { makeGuestInputRelay } from "./browser/guestInput";
import { popupUrl, type GuestRegistry } from "./browser/guests";
import { securePaneSession } from "./browser/permissions";
import { makePopupGate } from "./browser/popups";
import {
  CAPTURE_CHANNEL,
  CLEAR_ALL_CHANNEL,
  CLEAR_THREAD_CHANNEL,
  TAB_ANSWER_CHANNEL,
  type TabsChannel,
} from "./browser/tabsChannel";
import { registerServerStateBridge } from "./serverStateBridge";

/** The browser pane's main-process side, built in `./index.ts`. */
export interface PaneGuests {
  readonly guests: GuestRegistry;
  readonly tabs: TabsChannel;
}

export function registerIpc(supervisor: ServerSupervisor, pane: PaneGuests) {
  // `poseidon:connection`, `poseidon:server-state:get` and the push channel —
  // the seam the renderer reconnects against, in its own testable module.
  registerServerStateBridge(
    {
      handle: (channel, handler) => ipcMain.handle(channel, handler),
      senders: () => BrowserWindow.getAllWindows().map((win) => win.webContents),
    },
    supervisor,
  );
  ipcMain.handle("poseidon:open-external", (_event, url: unknown) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) {
      return shell.openExternal(url);
    }
  });
  ipcMain.handle("poseidon:pick-directory", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win === null) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // ── browser pane guests ────────────────────────────────────────

  ipcMain.handle(TAB_ANSWER_CHANNEL, (event, payload: unknown) => {
    pane.tabs.answer(event.sender.id, payload);
  });
  // Electron keeps `persist:<name>` under `<sessionData>/Partitions/<name>`.
  const partitions = () => join(app.getPath("sessionData"), "Partitions");
  const partitionOptions = {
    partitionExists: (threadId: string) => existsSync(join(partitions(), `thread-${threadId}`)),
    fromPartition: (partition: string) => session.fromPartition(partition),
  };
  const clearThread = makeClearThread(partitionOptions);
  ipcMain.handle(CLEAR_THREAD_CHANNEL, async (_event, threadId: unknown) => {
    await clearThread(threadId);
  });
  const clearAll = makeClearAll({
    ...partitionOptions,
    listPartitions: () => (existsSync(partitions()) ? readdirSync(partitions()) : []),
  });
  ipcMain.handle(CLEAR_ALL_CHANNEL, async (event) => {
    if (event.sender.getType() !== "window") throw new Error("not a window");
    return clearAll();
  });
  // Only the window may ask, and only for a pane guest: never the window itself.
  ipcMain.handle(CAPTURE_CHANNEL, async (event, wcId: unknown) => {
    if (event.sender.getType() !== "window") throw new Error("not a window");
    if (typeof wcId !== "number" || pane.guests.threadOf(wcId) === null) {
      throw new Error("not a browser tab");
    }
    const guest = webContents.fromId(wcId);
    if (guest === undefined || guest.isDestroyed()) throw new Error("the tab is closed");
    const image = await guest.capturePage();
    return new Uint8Array(image.toPNG());
  });
  app.on("browser-window-created", (_event, win) => {
    const id = win.webContents.id;
    win.webContents.once("destroyed", () => pane.tabs.abandon(id));
  });

  const relay = makeGuestInputRelay();
  const popups = makePopupGate();

  // The window's resolved `browser.*` chords; only a window may set them.
  let chords: ReadonlyArray<GuestChord> = [];
  ipcMain.handle(CHORDS_CHANNEL, (event, payload: unknown) => {
    if (event.sender.getType() === "window") chords = parseChords(payload);
  });

  const setUpGuest = (guest: WebContents) => {
    const wcId = guest.id;
    // Before anything else: a popup must never become a native window.
    guest.setWindowOpenHandler(({ url }) => {
      const threadId = pane.guests.threadOf(wcId);
      const target = popupUrl(url);
      if (threadId === null || target === null) return { action: "deny" };
      const decision = popups.decide({
        threadId,
        openTabs: pane.guests.tabCount(threadId),
        openerFocused: !guest.isDestroyed() && guest.isFocused(),
      });
      if (decision.kind === "drop") {
        console.warn(`[browser] popup dropped: ${decision.reason}`);
        return { action: "deny" };
      }
      pane.tabs.create(threadId, target, decision.background, wcId).catch((error: unknown) => {
        console.warn(`[browser] popup dropped: ${String(error)}`);
      });
      return { action: "deny" };
    });
    const threadId = pane.guests.track(guest);
    if (threadId === null) return;
    // Already done at attach; a net for a guest that got here another way.
    securePaneSession(guest.session);
    relay.hook(
      {
        id: wcId,
        onKey: (listener) => guest.on("before-input-event", (_event, input) => listener(input)),
        onMouse: (listener) => guest.on("before-mouse-event", (_event, mouse) => listener(mouse)),
        host: () => guest.hostWebContents,
      },
      threadId,
    );
    guest.on("before-input-event", (event, input) => {
      const decision = decideChord(chords, input, process.platform);
      if (decision.kind === "pass") return;
      event.preventDefault();
      const host = guest.hostWebContents;
      if (decision.command === null || host === null || host.isDestroyed()) return;
      const payload: GuestCommandPayload = { threadId, wcId, command: decision.command };
      host.send(COMMAND_CHANNEL, payload);
    });
    guest.once("destroyed", () => relay.forget(wcId));
  };

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() === "webview") setUpGuest(contents);
  });
}
