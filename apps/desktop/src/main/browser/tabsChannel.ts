/**
 * Main → renderer requests for pane tabs.
 *
 * A pane tab is a `<webview>` the renderer owns, so the bridge cannot make one
 * itself: Electron answers `Target.createTarget` with "Not supported", and a
 * guest only exists once the renderer has put the element in the DOM. So
 * `createTarget`, `closeTarget`, `Page.bringToFront` and a guest's popups
 * become requests to the window, each with an id and a deadline, and the
 * window answers on its own channel with the new tab's `webContents` id.
 *
 * No window, a window that goes away, or no answer in time is a plain error
 * whose text reaches the agent as the CDP error — never a hang, and never a
 * browser opened somewhere else instead.
 *
 * Electron-free: the shell passes in how to find the window, and the preload
 * (`../../preload/bridge.ts`) serves the other end.
 */

export const TAB_REQUEST_CHANNEL = "poseidon:browser-tab-request";
export const TAB_ANSWER_CHANNEL = "poseidon:browser-tab-answer";
/**
 * The window asks main to wipe a deleted thread's partition (`./clearThread`).
 * Declared here, beside the other pane channels, because the sandboxed
 * preload imports this module and `./clearThread` pulls in `node:crypto`.
 */
export const CLEAR_THREAD_CHANNEL = "poseidon:browser-clear-thread";
/**
 * The window asks main for a PNG of a pane tab, by its guest's `webContents`
 * id — the pane's "screenshot to chat". Only a pane guest is captured.
 */
export const CAPTURE_CHANNEL = "poseidon:browser-capture";
/** The window asks main to clear every thread's partition (Browser settings). */
export const CLEAR_ALL_CHANNEL = "poseidon:browser-clear-all";
/**
 * The window hands main the ids of every thread that still exists, and main
 * clears each partition on disk whose thread is not among them: threads
 * deleted while this window was not there to see it (`./clearThread`).
 */
export const CLEAR_STALE_CHANNEL = "poseidon:browser-clear-stale";

/** What a window with no tab host answers; the preload sends it on the renderer's behalf. */
export const NO_TAB_HOST = "the Poseidon window cannot open browser tabs";
export const WINDOW_NOT_OPEN = "the Poseidon window is not open";

export type TabRequest =
  | {
      readonly op: "create";
      readonly threadId: string;
      readonly url: string;
      /** Open behind the current tab rather than selecting it. */
      readonly background: boolean;
      /** For a popup: the `webContents` id of the tab whose page opened it. */
      readonly opener?: number;
    }
  | { readonly op: "close"; readonly wcId: number }
  | { readonly op: "select"; readonly wcId: number };

/** The window's answer; `wcId` is the new guest's, for `create`. */
export type TabAnswer =
  | { readonly id: number; readonly ok: true; readonly wcId?: number }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** The window's `webContents`, narrowed to what a request needs. */
export interface TabsWindow {
  readonly id: number;
  readonly isDestroyed: () => boolean;
  readonly send: (channel: string, payload: Readonly<{ id: number } & TabRequest>) => void;
}

export interface TabsChannelOptions {
  /** The window that hosts pane tabs, or `null` when none is open. */
  readonly window: () => TabsWindow | null;
  readonly timeoutMs?: number;
}

export interface TabsChannel {
  /** Resolves the new guest's `webContents` id; `opener` marks a popup. */
  readonly create: (
    threadId: string,
    url: string,
    background: boolean,
    opener?: number,
  ) => Promise<number>;
  readonly close: (wcId: number) => Promise<void>;
  readonly select: (wcId: number) => Promise<void>;
  /** An answer arrived from `senderId`'s window. */
  readonly answer: (senderId: number, payload: unknown) => void;
  /** `senderId`'s window went away: fail everything still waiting on it. */
  readonly abandon: (senderId: number) => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

interface Pending {
  readonly senderId: number;
  readonly resolve: (answer: TabAnswer & { ok: true }) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const parseAnswer = (payload: unknown): TabAnswer | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const { id, ok, wcId, error } = payload as Record<string, unknown>;
  if (typeof id !== "number") return null;
  if (ok === true) {
    return typeof wcId === "number" ? { id, ok, wcId } : { id, ok };
  }
  return { id, ok: false, error: typeof error === "string" ? error : "the tab request failed" };
};

export const makeTabsChannel = (options: TabsChannelOptions): TabsChannel => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Map<number, Pending>();
  let nextId = 0;

  const request = (body: TabRequest): Promise<TabAnswer & { ok: true }> => {
    const target = options.window();
    if (target === null || target.isDestroyed()) {
      return Promise.reject(new Error(WINDOW_NOT_OPEN));
    }
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${WINDOW_NOT_OPEN} (no answer within ${timeoutMs} ms)`));
      }, timeoutMs);
      pending.set(id, { senderId: target.id, resolve, reject, timer });
      try {
        target.send(TAB_REQUEST_CHANNEL, { id, ...body });
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(WINDOW_NOT_OPEN));
      }
    });
  };

  return {
    create: async (threadId, url, background, opener) => {
      const answer = await request({
        op: "create",
        threadId,
        url,
        background,
        ...(opener !== undefined && { opener }),
      });
      if (answer.wcId === undefined) {
        throw new Error("the Poseidon window opened a tab but did not say which");
      }
      return answer.wcId;
    },
    close: async (wcId) => {
      await request({ op: "close", wcId });
    },
    select: async (wcId) => {
      await request({ op: "select", wcId });
    },
    answer: (senderId, payload) => {
      const answer = parseAnswer(payload);
      const entry = answer === null ? undefined : pending.get(answer.id);
      // Only the window that was asked may answer.
      if (answer === null || entry === undefined || entry.senderId !== senderId) return;
      pending.delete(answer.id);
      clearTimeout(entry.timer);
      if (answer.ok) entry.resolve(answer);
      else entry.reject(new Error(answer.error));
    },
    abandon: (senderId) => {
      for (const [id, entry] of pending) {
        if (entry.senderId === senderId) {
          pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(new Error(WINDOW_NOT_OPEN));
        }
      }
    },
  };
};
