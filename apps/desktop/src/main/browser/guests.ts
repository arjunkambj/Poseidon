/**
 * The Electron side of the browser bridge: the pane webviews as a `GuestPort`.
 *
 * - **Registry.** A pane guest is a `webContents` of type `webview` whose
 *   session is `persist:thread-<id>`'s. The attach policy admits nothing else,
 *   and it tells the registry each thread it saw (`noteThread`) before the
 *   guest exists, so `track` can match the guest's session against
 *   `session.fromPartition` rather than trusting anything the page says.
 * - **Debugger.** Exactly one `debugger.attach("1.3")` per guest, once it has
 *   attached to its window (`did-attach-webview` on the window, or the
 *   guest's first `dom-ready`); the guest's own target id comes from
 *   `Target.getTargetInfo`. Clients get flat child sessions on that target,
 *   and the debugger's messages are routed by session id. Root-session
 *   messages are dropped here: a guest's debugger can see the app window.
 * - **Target events** come from the guest's own life: `created` once it is
 *   registered, `changed` on navigation and title, `destroyed` when the
 *   webContents (or its debugger) goes away.
 * - **Tabs** are the renderer's `<webview>` elements, so creating, closing and
 *   selecting one goes through `./tabsChannel`.
 * - **Focus.** CDP input lands in whichever widget has window focus, so a
 *   native-input command runs with the guest's `<webview>` focused in its
 *   window and focus handed back afterwards. The host is told only the
 *   numeric `webContents` id, and every hand-off runs through one queue.
 *
 * Only `electron` types are imported: the runtime pieces come in through
 * `GuestRegistryOptions`, so the registry runs against fakes in tests.
 */
import type { Session, WebContents } from "electron";

import { BRIDGE_THREAD_ID } from "@poseidon/shared/browserBridge";

import { makeSerialQueue, type GuestEvent, type GuestInfo, type GuestPort } from "./bridgeSession";
import type { TabsChannel } from "./tabsChannel";

const PANE_PARTITION_PREFIX = "persist:thread-";

/** The thread a pane partition belongs to, or `null` for any other partition. */
export const threadIdOfPartition = (partition: unknown): string | null => {
  if (typeof partition !== "string" || !partition.startsWith(PANE_PARTITION_PREFIX)) {
    return null;
  }
  const threadId = partition.slice(PANE_PARTITION_PREFIX.length);
  return BRIDGE_THREAD_ID.test(threadId) ? threadId : null;
};

/** The url a guest's `window.open` becomes a pane tab for, or `null` to drop it. */
export const popupUrl = (url: string): string | null => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

/** Chromium's own text, which agent-browser already understands. */
const NO_TARGET = "No target with given id found";

const DEFAULT_REGISTER_TIMEOUT_MS = 10_000;

export interface GuestRegistryOptions {
  /** `session.fromPartition`. */
  readonly fromPartition: (partition: string) => Session;
  readonly tabs: TabsChannel;
  /** Attach each guest's debugger: the bridge is running. */
  readonly debug: boolean;
  readonly log?: (entry: Readonly<Record<string, unknown>>) => void;
  /** How long a new tab may take to become a target. */
  readonly registerTimeoutMs?: number;
}

export interface GuestRegistry {
  readonly port: GuestPort;
  /** The attach policy admitted a `persist:thread-<id>` webview. */
  readonly noteThread: (threadId: string) => void;
  /** A webview guest was created; returns its thread, or `null` for a non-pane guest. */
  readonly track: (wc: WebContents) => string | null;
  /** A tracked guest attached to its window (`did-attach-webview`): register it. */
  readonly attached: (wc: WebContents) => void;
  /** The thread of a tracked guest. */
  readonly threadOf: (wcId: number) => string | null;
  /** How many live guests (pane tabs) a thread has. */
  readonly tabCount: (threadId: string) => number;
}

interface Entry {
  readonly wc: WebContents;
  /** Kept apart from `wc`: a destroyed webContents' members may throw. */
  readonly wcId: number;
  readonly threadId: string;
  /** Set once the debugger is attached and the target id is known. */
  targetId: string | null;
  registering: boolean;
  /** The debugger's listeners are on; they survive a detach and re-attach. */
  listening: boolean;
}

/** The host-side script that finds a pane `<webview>` by its guest's id. */
const findView = (wcId: number): string =>
  `[...document.querySelectorAll("webview")].find((view) => {
    try { return view.getWebContentsId() === ${wcId}; } catch { return false; }
  })`;

const focusScript = (wcId: number): string => `(() => {
  const view = ${findView(wcId)};
  if (view === undefined) return false;
  globalThis.__poseidonFocusRestore = document.activeElement;
  view.focus();
  return true;
})()`;

const restoreScript = (wcId: number): string => `(() => {
  const previous = globalThis.__poseidonFocusRestore;
  delete globalThis.__poseidonFocusRestore;
  const view = ${findView(wcId)};
  if (previous instanceof HTMLElement && previous.isConnected && previous !== view && previous !== document.body) {
    previous.focus({ preventScroll: true });
  } else if (view !== undefined && document.activeElement === view) {
    view.blur();
  }
})()`;

export const createGuestRegistry = (options: GuestRegistryOptions): GuestRegistry => {
  const log = options.log ?? (() => undefined);
  const registerTimeoutMs = options.registerTimeoutMs ?? DEFAULT_REGISTER_TIMEOUT_MS;
  const threads = new Set<string>();
  const entries = new Map<number, Entry>();
  const listeners = new Set<(event: GuestEvent) => void>();
  const focusQueue = makeSerialQueue();

  const emit = (event: GuestEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const infoOf = (entry: Entry & { targetId: string }): GuestInfo => ({
    wcId: entry.wcId,
    targetId: entry.targetId,
    url: entry.wc.getURL(),
    title: entry.wc.getTitle(),
  });

  const registered = (wcId: number): (Entry & { targetId: string }) | null => {
    const entry = entries.get(wcId);
    return entry !== undefined && entry.targetId !== null && !entry.wc.isDestroyed()
      ? (entry as Entry & { targetId: string })
      : null;
  };

  const target = (wcId: number): Entry & { targetId: string } => {
    const entry = registered(wcId);
    if (entry === null) throw new Error(NO_TARGET);
    return entry;
  };

  const unregister = (entry: Entry): void => {
    if (entry.targetId === null) return;
    const targetId = entry.targetId;
    entry.targetId = null;
    emit({ type: "destroyed", threadId: entry.threadId, wcId: entry.wcId, targetId });
  };

  const register = async (entry: Entry): Promise<void> => {
    if (entry.registering || entry.targetId !== null || entry.wc.isDestroyed()) return;
    entry.registering = true;
    const { wc, wcId } = entry;
    try {
      const debug = wc.debugger;
      if (!entry.listening) {
        entry.listening = true;
        debug.on("message", (_event, method, params, sessionId) => {
          if (typeof sessionId === "string" && sessionId !== "")
            emit({ type: "cdp", wcId, method, params, sessionId });
        });
        debug.on("detach", (_event, reason) => {
          log({ event: "debugger-detached", wcId, reason });
          unregister(entry);
        });
      }
      if (!debug.isAttached()) debug.attach("1.3");
      const { targetInfo } = (await debug.sendCommand("Target.getTargetInfo")) as {
        targetInfo: { targetId: string };
      };
      if (wc.isDestroyed() || !entries.has(wcId)) return;
      entry.targetId = targetInfo.targetId;
      emit({ type: "created", threadId: entry.threadId, guest: infoOf(target(wcId)) });
    } catch (error) {
      log({ event: "register-failed", wcId, error: String(error) });
    } finally {
      entry.registering = false;
    }
  };

  /** Resolves once `wcId` is a registered guest, or fails after the deadline. */
  const whenRegistered = (wcId: number): Promise<GuestInfo> =>
    new Promise((resolve, reject) => {
      const now = registered(wcId);
      if (now !== null) {
        resolve(infoOf(now));
        return;
      }
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error("the new tab did not become a browser target in time"));
      }, registerTimeoutMs);
      const listener = (event: GuestEvent) => {
        if (event.type === "created" && event.guest.wcId === wcId) {
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(event.guest);
        }
      };
      listeners.add(listener);
    });

  const hostOf = (wcId: number): WebContents => {
    const host = target(wcId).wc.hostWebContents;
    if (host === null || host.isDestroyed()) throw new Error("the Poseidon window is not open");
    return host;
  };

  const port: GuestPort = {
    guestsOf: (threadId) =>
      [...entries.values()]
        .filter((entry) => entry.threadId === threadId)
        .map((entry) => registered(entry.wcId))
        .filter((entry) => entry !== null)
        .map(infoOf),
    send: (wcId, method, params, sessionId) =>
      target(wcId).wc.debugger.sendCommand(method, params ?? {}, sessionId),
    attachChild: async (wcId) => {
      const entry = target(wcId);
      const { sessionId } = (await entry.wc.debugger.sendCommand("Target.attachToTarget", {
        targetId: entry.targetId,
        flatten: true,
      })) as { sessionId: string };
      return sessionId;
    },
    detachChild: async (wcId, sessionId) => {
      const entry = registered(wcId);
      if (entry !== null) {
        await entry.wc.debugger.sendCommand("Target.detachFromTarget", { sessionId });
      }
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload: async (wcId, ignoreCache) => {
      const { wc } = target(wcId);
      if (ignoreCache) wc.reloadIgnoringCache();
      else wc.reload();
    },
    createTab: async (threadId, url, background) =>
      whenRegistered(await options.tabs.create(threadId, url, background)),
    closeTab: (wcId) => options.tabs.close(target(wcId).wcId),
    selectTab: (wcId) => options.tabs.select(target(wcId).wcId),
    withFocus: (wcId, operation) =>
      focusQueue.run(async () => {
        const host = hostOf(wcId);
        const focused = (await host.executeJavaScript(focusScript(wcId))) as boolean;
        if (!focused) throw new Error("the pane tab is not in the Poseidon window");
        try {
          return await operation();
        } finally {
          if (!host.isDestroyed()) {
            await host.executeJavaScript(restoreScript(wcId)).catch(() => undefined);
          }
        }
      }),
  };

  const track = (wc: WebContents): string | null => {
    let threadId: string | null = null;
    for (const candidate of threads) {
      if (wc.session === options.fromPartition(`${PANE_PARTITION_PREFIX}${candidate}`)) {
        threadId = candidate;
        break;
      }
    }
    const wcId = wc.id;
    if (threadId === null || entries.has(wcId)) return threadId;
    const entry: Entry = {
      wc,
      wcId,
      threadId,
      targetId: null,
      registering: false,
      listening: false,
    };
    entries.set(wcId, entry);
    const changed = () => {
      const now = registered(wcId);
      if (now !== null) emit({ type: "changed", threadId: entry.threadId, guest: infoOf(now) });
    };
    wc.on("did-navigate", changed);
    wc.on("did-navigate-in-page", changed);
    wc.on("page-title-updated", changed);
    if (options.debug) {
      // A crashed renderer takes the debugger with it; the reload re-registers.
      wc.on("dom-ready", () => void register(entry));
    }
    wc.once("destroyed", () => {
      entries.delete(wcId);
      unregister(entry);
    });
    return threadId;
  };

  return {
    port,
    noteThread: (threadId) => {
      if (BRIDGE_THREAD_ID.test(threadId)) threads.add(threadId);
    },
    track,
    attached: (wc) => {
      const entry = entries.get(wc.id);
      if (options.debug && entry !== undefined) void register(entry);
    },
    threadOf: (wcId) => entries.get(wcId)?.threadId ?? null,
    tabCount: (threadId) =>
      [...entries.values()].filter((entry) => entry.threadId === threadId).length,
  };
};
