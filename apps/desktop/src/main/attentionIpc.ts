/**
 * The Electron side of the attention seam (`./attention.ts`): system
 * notifications whose click opens their thread, the dock badge, the system
 * beep, the keep-awake blocker, the busy count the quit guard reads, and
 * the window's answer to a held quit.
 *
 * Only a `window` sender is answered, as in `./ipc.ts`; every payload goes
 * through the parsers in `./attention.ts` first.
 */
import { app, BrowserWindow, ipcMain, Notification, powerSaveBlocker, shell } from "electron";
import type { IpcMainInvokeEvent, WebContents } from "electron";

import {
  ATTENTION_BADGE_CHANNEL,
  ATTENTION_BEEP_CHANNEL,
  ATTENTION_BUSY_CHANNEL,
  ATTENTION_KEEP_AWAKE_CHANNEL,
  ATTENTION_NOTIFY_CHANNEL,
  makeKeepAwake,
  OPEN_THREAD_CHANNEL,
  QUIT_ANSWER_CHANNEL,
  parseBadge,
  parseBusyCount,
  parseNotify,
} from "./attention";

export interface AttentionIpcDeps {
  /** The live window's contents, or null when there is none. */
  readonly windowContents: () => WebContents | null;
  /** The window's answer to a held quit (`./quitGuard.ts`). */
  readonly onQuitAnswer: (quit: boolean) => void;
}

const fromWindow = (event: IpcMainInvokeEvent) => {
  if (event.sender.getType() !== "window") throw new Error("not a window");
};

/** Brings the first live window forward: un-minimised, shown and focused. */
export const showWindow = (): boolean => {
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  if (win === undefined) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
};

export function registerAttentionIpc(deps: AttentionIpcDeps) {
  // A notification nobody references is collected, and its click handler with
  // it; each one is held here until it is clicked or closed.
  const live = new Set<Notification>();
  ipcMain.handle(ATTENTION_NOTIFY_CHANNEL, (event, payload: unknown) => {
    fromWindow(event);
    const notice = parseNotify(payload);
    if (notice === null || !Notification.isSupported()) return;
    const notification = new Notification({
      title: notice.title,
      body: notice.body,
      // The renderer plays the sound, once per batch, when the user wants one.
      silent: true,
    });
    const release = () => live.delete(notification);
    notification.on("click", () => {
      release();
      showWindow();
      deps.windowContents()?.send(OPEN_THREAD_CHANNEL, notice.threadId);
    });
    notification.on("close", release);
    live.add(notification);
    notification.show();
  });

  ipcMain.handle(ATTENTION_BADGE_CHANNEL, (event, count: unknown) => {
    fromWindow(event);
    // macOS dock and Linux launchers; 0 clears it.
    app.setBadgeCount(parseBadge(count));
  });

  ipcMain.handle(ATTENTION_BEEP_CHANNEL, (event) => {
    fromWindow(event);
    shell.beep();
  });

  const keepAwake = makeKeepAwake({
    start: () => powerSaveBlocker.start("prevent-app-suspension"),
    stop: (id) => powerSaveBlocker.stop(id),
    isStarted: (id) => powerSaveBlocker.isStarted(id),
  });
  ipcMain.handle(ATTENTION_KEEP_AWAKE_CHANNEL, (event, hold: unknown) => {
    fromWindow(event);
    return keepAwake.set(hold === true);
  });
  app.on("will-quit", () => void keepAwake.set(false));

  let busy = 0;
  ipcMain.handle(ATTENTION_BUSY_CHANNEL, (event, count: unknown) => {
    fromWindow(event);
    busy = parseBusyCount(count);
  });

  ipcMain.handle(QUIT_ANSWER_CHANNEL, (event, quit: unknown) => {
    fromWindow(event);
    deps.onQuitAnswer(quit === true);
  });

  return { busyCount: () => busy };
}
