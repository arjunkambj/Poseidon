/**
 * The renderer's side of the shell's attention seam
 * (`window.poseidon.attention`, apps/desktop/src/main/attention.ts), with a
 * plain-browser fallback for each call:
 *
 * - `notify` posts a web `Notification`, but only when the page already has
 *   permission — it never prompts on its own; the settings page asks.
 * - `beep` plays a short WebAudio blip.
 * - the badge, keep-awake, busy count and quit request have no browser
 *   equivalent and do nothing; `setKeepAwake` resolves `null` so a caller can
 *   say the setting is desktop-only.
 *
 * A notification click, native or web, arrives on `onOpenThread`.
 */

export interface AttentionNotifyPayload {
  readonly threadId: string;
  readonly title: string;
  readonly body: string;
}

type OpenThreadListener = (threadId: string) => void;

const bridge = () => (typeof window === "undefined" ? undefined : window.poseidon?.attention);

/** Whether the desktop shell carries notifications, the badge and keep-awake. */
export const hasDesktopAttention = (): boolean => bridge() !== undefined;

// Web notification clicks, which the shell never sees.
const webOpenListeners = new Set<OpenThreadListener>();

const webNotifications = (): typeof Notification | undefined =>
  typeof Notification === "undefined" ? undefined : Notification;

/** The browser's notification permission, or `null` when it has no Notification API. */
export const webNotificationPermission = (): NotificationPermission | null =>
  webNotifications()?.permission ?? null;

/** Asks the browser for notification permission; resolves what it answered. */
export const requestWebNotifications = async (): Promise<NotificationPermission | null> => {
  const api = webNotifications();
  if (api === undefined) return null;
  try {
    return await api.requestPermission();
  } catch {
    return api.permission;
  }
};

/** A system notification for a thread; a click focuses the window and opens it. */
export const notify = (payload: AttentionNotifyPayload): void => {
  const shell = bridge()?.notify;
  if (shell !== undefined) {
    void shell(payload).catch(() => undefined);
    return;
  }
  const api = webNotifications();
  if (api?.permission !== "granted") return;
  try {
    const notification = new api(payload.title, { body: payload.body, silent: true });
    notification.onclick = () => {
      window.focus();
      notification.close();
      for (const listener of webOpenListeners) listener(payload.threadId);
    };
  } catch {
    // Some browsers only allow notifications from a service worker.
  }
};

const BLIP_SECONDS = 0.12;

/** One short sound: the system beep on the desktop, a WebAudio blip elsewhere. */
export const beep = (): void => {
  const shell = bridge()?.beep;
  if (shell !== undefined) {
    void shell().catch(() => undefined);
    return;
  }
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + BLIP_SECONDS);
    oscillator.connect(gain).connect(context.destination);
    oscillator.onended = () => void context.close();
    oscillator.start();
    oscillator.stop(context.currentTime + BLIP_SECONDS);
  } catch {
    // No audio (autoplay policy, no device): the sound is a nicety.
  }
};

/** The dock badge count; 0 clears it. Desktop only. */
export const setBadge = (count: number): void => {
  void bridge()
    ?.setBadge?.(count)
    .catch(() => undefined);
};

/**
 * Holds or releases the power-save blocker. Resolves whether it is held, or
 * `null` outside the desktop app.
 */
export const setKeepAwake = async (hold: boolean): Promise<boolean | null> => {
  const shell = bridge()?.setKeepAwake;
  if (shell === undefined) return null;
  try {
    return await shell(hold);
  } catch {
    return null;
  }
};

/** How many threads are running or waiting on the user, for the quit guard. */
export const setBusy = (count: number): void => {
  void bridge()
    ?.setBusy?.(count)
    .catch(() => undefined);
};

/** A notification was clicked: open this thread. Returns its unsubscribe. */
export const onOpenThread = (callback: OpenThreadListener): (() => void) => {
  webOpenListeners.add(callback);
  const stopShell = bridge()?.onOpenThread?.(callback);
  return () => {
    webOpenListeners.delete(callback);
    stopShell?.();
  };
};

/** The shell held a quit and asks the user to confirm it. Desktop only. */
export const onQuitRequest = (callback: () => void): (() => void) =>
  bridge()?.onQuitRequest?.(callback) ?? (() => undefined);

/** The user's answer to a held quit: `true` quits, `false` cancels. */
export const answerQuit = (quit: boolean): void => {
  void bridge()
    ?.answerQuit?.(quit)
    .catch(() => undefined);
};
