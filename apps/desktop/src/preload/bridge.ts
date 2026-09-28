/**
 * The renderer-facing bridge object, built against a minimal `ipcRenderer`
 * shape instead of importing `electron`.
 *
 * `index.ts` is the only module that may touch `electron`, and it is loaded
 * by the runtime rather than by a test — so the contract the renderer type
 * declares in `@poseidon/client-runtime/resolver` (`getConnection`,
 * `getServerState`, `onServerState`, …) is asserted here, with a fake channel,
 * rather than left to a hand-check against the running app.
 */

import {
  ATTENTION_BADGE_CHANNEL,
  ATTENTION_BEEP_CHANNEL,
  ATTENTION_BUSY_CHANNEL,
  ATTENTION_KEEP_AWAKE_CHANNEL,
  ATTENTION_NOTIFY_CHANNEL,
  OPEN_THREAD_CHANNEL,
  QUIT_ANSWER_CHANNEL,
  QUIT_REQUEST_CHANNEL,
  type AttentionNotice,
} from "../main/attentionChannels";
import { POINTER_CHANNEL, type AgentPointer } from "../main/browser/agentPointer";
import {
  CHORDS_CHANNEL,
  COMMAND_CHANNEL,
  type GuestChord,
  type GuestCommandPayload,
} from "../main/browser/guestChords";
import {
  CAPTURE_CHANNEL,
  CLEAR_ALL_CHANNEL,
  CLEAR_THREAD_CHANNEL,
  NO_TAB_HOST,
  TAB_ANSWER_CHANNEL,
  TAB_REQUEST_CHANNEL,
  type TabAnswer,
  type TabRequest,
} from "../main/browser/tabsChannel";

export interface ServerConnection {
  readonly url: string;
  readonly token: string;
  readonly serverInstanceId: string;
}

/**
 * `connection` is non-null exactly while the status is `ready`, and it is a
 * *fresh* connection after a restart: the new server binds a new port and
 * mints a new token and instance id, so a client that reconnects with its
 * boot-time values would dial a dead port forever.
 */
export interface ServerState {
  readonly status: "starting" | "ready" | "restarting" | "failed";
  readonly connection: ServerConnection | null;
  /** Which restart is running, while `restarting`; null otherwise. */
  readonly attempt: number | null;
  /** Why the supervisor gave up, while `failed`; null otherwise. */
  readonly reason: string | null;
}

/** One gesture from inside a pane webview, already contract-shaped. */
export interface BrowserPaneGuestInput {
  readonly threadId: string;
  /** The guest's `webContents` id: which tab of the thread it came from. */
  readonly wcId: number;
  readonly input: unknown;
}

/** A pane key pressed inside a page, matched by main against the window's chords. */
export type BrowserPaneCommand = GuestCommandPayload;

/** Where the agent's pointer moved or pressed in a pane tab (`main/browser/agentPointer.ts`). */
export type BrowserPaneAgentPointer = AgentPointer;

/** What main asks the window's tab host to do (`main/browser/tabsChannel.ts`). */
export type BrowserTabRequest = Readonly<{ id: number } & TabRequest>;

/** The tab host's work: resolves the new tab's `webContents` id for `create`. */
export type BrowserTabHandler = (request: TabRequest) => Promise<{ readonly wcId?: number }>;

/** A system notification for a thread (`main/attention.ts`); main validates it. */
export type AttentionNotifyPayload = AttentionNotice;

/** A main→renderer push listener: the event object, then the payload. */
export type PreloadIpcListener = (event: unknown, ...args: Array<unknown>) => void;

/**
 * Just the three `ipcRenderer` members the bridge uses, declared so the real
 * `ipcRenderer` satisfies it structurally — no cast, so a signature drift in
 * a future Electron shows up as a type error here rather than at runtime.
 */
export interface PreloadIpc {
  readonly invoke: (channel: string, ...args: Array<unknown>) => Promise<unknown>;
  readonly on: (channel: string, listener: PreloadIpcListener) => unknown;
  readonly removeListener: (channel: string, listener: PreloadIpcListener) => unknown;
}

/**
 * Subscribes to a main→renderer push channel and hands back its own
 * unsubscribe, so a renderer that unmounts stops receiving without having to
 * know the channel name.
 */
const subscribe = <A>(ipc: PreloadIpc, channel: string, callback: (payload: A) => void) => {
  const listener: PreloadIpcListener = (_event, ...args) => callback(args[0] as A);
  ipc.on(channel, listener);
  return () => {
    ipc.removeListener(channel, listener);
  };
};

/**
 * Answers main's tab requests. At most one handler serves them — the
 * renderer's tab host, once it mounts — and until then, or after it goes,
 * every request is answered with `NO_TAB_HOST` at once instead of leaving
 * main to time out.
 */
const serveTabRequests = (ipc: PreloadIpc) => {
  let handler: BrowserTabHandler | null = null;
  const answer = (payload: TabAnswer) => void ipc.invoke(TAB_ANSWER_CHANNEL, payload);
  ipc.on(TAB_REQUEST_CHANNEL, (_event, ...args) => {
    const request = args[0] as BrowserTabRequest | undefined;
    if (typeof request?.id !== "number") return;
    const { id, ...body } = request;
    if (handler === null) {
      answer({ id, ok: false, error: NO_TAB_HOST });
      return;
    }
    handler(body as TabRequest).then(
      (result) =>
        answer(result.wcId === undefined ? { id, ok: true } : { id, ok: true, wcId: result.wcId }),
      (error: unknown) =>
        answer({ id, ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  });
  return (next: BrowserTabHandler): (() => void) => {
    handler = next;
    return () => {
      if (handler === next) handler = null;
    };
  };
};

export const makePoseidonBridge = (ipc: PreloadIpc) => {
  const serveTabs = serveTabRequests(ipc);
  return {
    getConnection: (): Promise<ServerConnection | null> =>
      ipc.invoke("poseidon:connection") as Promise<ServerConnection | null>,
    /** The current state, for a renderer that mounted after the last transition. */
    getServerState: (): Promise<ServerState> =>
      ipc.invoke("poseidon:server-state:get") as Promise<ServerState>,
    onServerState: (callback: (state: ServerState) => void): (() => void) =>
      subscribe<ServerState>(ipc, "poseidon:server-state", callback),
    openExternal: (url: string): Promise<void> =>
      ipc.invoke("poseidon:open-external", url) as Promise<void>,
    pickDirectory: (): Promise<string | null> =>
      ipc.invoke("poseidon:pick-directory") as Promise<string | null>,
    /**
     * The browser pane's guests. `onInput` delivers every real
     * pointer/keyboard/wheel gesture inside a pane webview — already shaped
     * like `BrowserHumanInput`, tagged with its thread and tab — which the pane
     * forwards as `browser.humanInput` so the server can mark human control.
     * `serveTabs` makes the caller the window's tab host, which opens, closes
     * and selects pane tabs when the agent or a popup asks. `clearThread`
     * wipes a deleted thread's browsing data; main validates the id.
     * `setChords` hands main the pane's resolved `browser.*` chords, and
     * `onCommand` delivers each one pressed while a pane page had focus —
     * which the window's own key listener never sees. `onAgentPointer`
     * delivers where the agent moves and presses its pointer in a tab, for
     * the cursor the pane draws.
     */
    browserPane: {
      onInput: (callback: (payload: BrowserPaneGuestInput) => void): (() => void) =>
        subscribe<BrowserPaneGuestInput>(ipc, "poseidon:browser-input", callback),
      serveTabs,
      /** A PNG of the pane tab whose guest is `wcId`, as it is drawn now. */
      capture: (wcId: number): Promise<Uint8Array> =>
        ipc.invoke(CAPTURE_CHANNEL, wcId) as Promise<Uint8Array>,
      clearThread: async (threadId: string): Promise<void> => {
        await ipc.invoke(CLEAR_THREAD_CHANNEL, threadId);
      },
      /** Wipes every thread's browsing data; resolves how many were cleared. */
      clearAll: (): Promise<number> => ipc.invoke(CLEAR_ALL_CHANNEL) as Promise<number>,
      setChords: async (chords: ReadonlyArray<GuestChord>): Promise<void> => {
        await ipc.invoke(CHORDS_CHANNEL, chords);
      },
      onCommand: (callback: (payload: BrowserPaneCommand) => void): (() => void) =>
        subscribe<BrowserPaneCommand>(ipc, COMMAND_CHANNEL, callback),
      onAgentPointer: (callback: (payload: BrowserPaneAgentPointer) => void): (() => void) =>
        subscribe<BrowserPaneAgentPointer>(ipc, POINTER_CHANNEL, callback),
    },
    /**
     * The attention seam (`main/attention.ts`): the renderer decides when a
     * thread needs the user and main carries it out. `notify` posts a silent
     * system notification whose click brings the window forward and arrives
     * on `onOpenThread`; `setBadge` sets the dock count (0 clears);
     * `setKeepAwake` holds or releases the power-save blocker and resolves
     * whether it is held; `setBusy` reports running or waiting threads, which
     * makes the next quit arrive on `onQuitRequest` for `answerQuit`.
     */
    attention: {
      notify: async (payload: AttentionNotifyPayload): Promise<void> => {
        await ipc.invoke(ATTENTION_NOTIFY_CHANNEL, payload);
      },
      setBadge: async (count: number): Promise<void> => {
        await ipc.invoke(ATTENTION_BADGE_CHANNEL, count);
      },
      beep: async (): Promise<void> => {
        await ipc.invoke(ATTENTION_BEEP_CHANNEL);
      },
      setKeepAwake: (hold: boolean): Promise<boolean> =>
        ipc.invoke(ATTENTION_KEEP_AWAKE_CHANNEL, hold) as Promise<boolean>,
      setBusy: async (count: number): Promise<void> => {
        await ipc.invoke(ATTENTION_BUSY_CHANNEL, count);
      },
      onOpenThread: (callback: (threadId: string) => void): (() => void) =>
        subscribe<string>(ipc, OPEN_THREAD_CHANNEL, callback),
      onQuitRequest: (callback: () => void): (() => void) =>
        subscribe<unknown>(ipc, QUIT_REQUEST_CHANNEL, () => callback()),
      answerQuit: async (quit: boolean): Promise<void> => {
        await ipc.invoke(QUIT_ANSWER_CHANNEL, quit);
      },
    },
  };
};
