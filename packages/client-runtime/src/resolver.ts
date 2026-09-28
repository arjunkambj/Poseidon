/**
 * Finds `{ url, token }` for the current process, in order:
 * `window.poseidon.getConnection()` (Electron preload) →
 * `GET /__poseidon/connection` (the dev Vite plugin) →
 * `?server=<url>&token=<t>` search params.
 *
 * Everything is guarded so this file also evaluates under plain `node` for
 * tests — it just reports `null` when no channel answers.
 */

export interface ResolvedConnection {
  readonly url: string;
  readonly token: string;
  /**
   * The server's boot id, when the channel knows it. The desktop preload does;
   * the dev endpoint forwards the same handshake line, so it does too. A value
   * that differs from the one the client last saw means the server restarted
   * and every cached snapshot is stale.
   */
  readonly serverInstanceId?: string;
}

/** One gesture from inside a pane webview, shaped like `BrowserHumanInput`. */
export interface BrowserPaneGuestInput {
  readonly threadId: string;
  /** The guest's `webContents` id: which of the thread's tabs it came from. */
  readonly wcId: number;
  readonly input: unknown;
}

/** What the desktop shell asks the window's browser-tab host to do. */
export type BrowserPaneTabRequest =
  | {
      readonly op: "create";
      readonly threadId: string;
      readonly url: string;
      readonly background: boolean;
      /** For a popup: the `webContents` id of the tab whose page opened it. */
      readonly opener?: number;
    }
  | { readonly op: "close"; readonly wcId: number }
  | { readonly op: "select"; readonly wcId: number };

/**
 * A `browser.*` chord as the desktop shell matches it inside a pane page: the
 * platform modifier already resolved to Meta or Control, the key lowercase.
 */
export interface BrowserPaneChord {
  readonly command: string;
  readonly key: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/** A pane chord pressed inside one of the thread's pages. */
export interface BrowserPaneCommand {
  readonly threadId: string;
  readonly wcId: number;
  readonly command: string;
}

/**
 * Where the agent moved (`move`) or pressed (`press`) its pointer in a pane
 * tab, in CSS pixels of the page's viewport.
 */
export interface BrowserPaneAgentPointer {
  readonly threadId: string;
  readonly wcId: number;
  readonly x: number;
  readonly y: number;
  readonly kind: "move" | "press";
}

/**
 * What the desktop supervisor is doing with the server process. `connection`
 * is null until the server is up and whenever it is being replaced, and it
 * carries the new port, token and boot id once a restart lands — which is how
 * the renderer reconnects without reloading the window.
 *
 * It is optional because the shipping preload does not send it yet: a build
 * that pushes `{ status }` alone would otherwise arrive here as an object
 * whose declared-non-null `connection` is `undefined`, and a reader doing
 * `connection === null` would take a server with no connection for one that
 * has it. Read it as `connection ?? null`.
 */
export interface DesktopServerState {
  readonly status: "starting" | "ready" | "restarting" | "failed";
  readonly connection?: ResolvedConnection | null;
  /**
   * Which restart is running, while `restarting`. Optional for the same
   * reason as `connection` — an older preload omits it — and read as
   * `attempt ?? null`.
   */
  readonly attempt?: number | null;
  /**
   * Why the supervisor stopped retrying, while `failed`. The banner says this
   * instead of promising a retry that is not coming.
   */
  readonly reason?: string | null;
}

declare global {
  interface Window {
    /**
     * The desktop preload bridge (apps/desktop/src/preload). Every member is
     * optional — a browser tab has none of them, and older builds may lack the
     * newer ones.
     */
    readonly poseidon?: {
      readonly getConnection?: () => Promise<ResolvedConnection | null> | ResolvedConnection | null;
      /**
       * The supervisor's current view, including the live connection. Newer
       * than `getConnection` and the first thing a reconnect asks, so a
       * restarted server's new port and token are picked up.
       */
      readonly getServerState?: () => Promise<DesktopServerState> | DesktopServerState;
      /** Pushes every supervisor transition; returns its own unsubscribe. */
      readonly onServerState?: (callback: (state: DesktopServerState) => void) => () => void;
      /** Native directory picker; resolves `null` when the user cancels. */
      readonly pickDirectory?: () => Promise<string | null>;
      /** Opens `url` in the system browser — the only sanctioned way out. */
      readonly openExternal?: (url: string) => Promise<void>;
      /**
       * Desktop-only browser-pane bridge: human input from the pane's
       * webviews, the tab host the shell asks to open, close and select
       * pane tabs (resolving the new tab's `webContents` id for `create`),
       * and `clearThread`, which wipes a deleted thread's browsing data.
       * Absent under a plain browser — the pane then renders the
       * owned-Chromium frame stream.
       */
      readonly browserPane?: {
        readonly onInput: (callback: (payload: BrowserPaneGuestInput) => void) => () => void;
        readonly serveTabs?: (
          handler: (request: BrowserPaneTabRequest) => Promise<{ readonly wcId?: number }>,
        ) => () => void;
        readonly clearThread?: (threadId: string) => Promise<void>;
        /** Wipes every thread's browsing data; resolves how many were cleared. */
        readonly clearAll?: () => Promise<number>;
        /** A PNG of the pane tab whose guest is `wcId`. */
        readonly capture?: (wcId: number) => Promise<Uint8Array>;
        /** Hands the shell the `browser.*` chords to match inside pane pages. */
        readonly setChords?: (chords: ReadonlyArray<BrowserPaneChord>) => Promise<void>;
        /** A pane chord pressed while a pane page had focus. */
        readonly onCommand?: (callback: (payload: BrowserPaneCommand) => void) => () => void;
        /** The agent's pointer in a pane tab, for the cursor drawn over it. */
        readonly onAgentPointer?: (
          callback: (payload: BrowserPaneAgentPointer) => void,
        ) => () => void;
      };
      /**
       * Desktop-only attention seam: the renderer decides when a thread
       * needs the user, the shell carries it out. `notify` posts a silent
       * system notification whose click focuses the window and arrives on
       * `onOpenThread`; `setBadge` sets the dock count (0 clears); `beep`
       * plays the system sound; `setKeepAwake` holds or releases the
       * power-save blocker and resolves whether it is held; `setBusy`
       * reports running or waiting threads, which makes the next quit
       * arrive on `onQuitRequest` for `answerQuit`. Absent under a plain
       * browser.
       */
      readonly attention?: {
        readonly notify?: (payload: {
          readonly threadId: string;
          readonly title: string;
          readonly body: string;
        }) => Promise<void>;
        readonly setBadge?: (count: number) => Promise<void>;
        readonly beep?: () => Promise<void>;
        readonly setKeepAwake?: (hold: boolean) => Promise<boolean>;
        readonly setBusy?: (count: number) => Promise<void>;
        readonly onOpenThread?: (callback: (threadId: string) => void) => () => void;
        readonly onQuitRequest?: (callback: () => void) => () => void;
        readonly answerQuit?: (quit: boolean) => Promise<void>;
      };
    };
  }
}

/**
 * The supervisor's state first, then its plain connection getter: on a
 * reconnect after a restart the state is the one that already knows the new
 * port and token, and an older preload that only has `getConnection` still
 * answers.
 */
const fromPreload = async (): Promise<ResolvedConnection | null> => {
  if (typeof window === "undefined") {
    return null;
  }
  const bridge = window.poseidon;
  if (bridge?.getServerState !== undefined) {
    const state = await bridge.getServerState();
    const connection = state.connection ?? null;
    if (connection !== null) {
      return connection;
    }
  }
  if (bridge?.getConnection === undefined) {
    return null;
  }
  return (await bridge.getConnection()) ?? null;
};

const fromDevEndpoint = async (): Promise<ResolvedConnection | null> => {
  if (typeof fetch === "undefined" || typeof window === "undefined") {
    return null;
  }
  try {
    const response = await fetch("/__poseidon/connection", { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as Partial<ResolvedConnection>;
    if (typeof body.url !== "string" || typeof body.token !== "string") {
      return null;
    }
    return {
      url: body.url,
      token: body.token,
      ...(typeof body.serverInstanceId === "string"
        ? { serverInstanceId: body.serverInstanceId }
        : {}),
    };
  } catch {
    return null;
  }
};

const fromSearchParams = (): ResolvedConnection | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  const url = params.get("server");
  const token = params.get("token");
  return url !== null && token !== null ? { url, token } : null;
};

/**
 * `null` means "no channel configured" — the UI shows its connect screen.
 *
 * @public The web entry point calls this before mounting the atom runtime.
 */
export const resolveConnection = async (): Promise<ResolvedConnection | null> =>
  (await fromPreload()) ?? (await fromDevEndpoint()) ?? fromSearchParams();
