/**
 * One CDP client of the browser bridge, routed onto one thread's guests.
 *
 * agent-browser believes it is talking to a browser. What it gets is a
 * virtual one: the root session answers `Browser.getVersion` and the
 * `Target.*` calls itself, reporting the thread's pane webviews — and only
 * those — as `page` targets; a page session is a flat session on that guest's
 * own `webContents.debugger`, reached through the `GuestPort`. `cdpPolicy.ts`
 * decides what each command may do; this file carries it out and keeps the
 * session bookkeeping:
 *
 * - Session ids are the guest debugger's own, so events come back on them
 *   untranslated. The port fans every guest event out to every client; a
 *   client only relays events on sessions it opened, and root-session events
 *   of a guest's debugger (which can see the app window) never reach anyone.
 * - `Network` / `Fetch` events and results lose their cookies on the way
 *   out (`./cdpCookies`): the policy refuses the cookie jar, and the raw
 *   `Cookie` / `Set-Cookie` headers would hand it over anyway.
 * - Child sessions a page auto-attaches (out-of-process frames, workers) are
 *   learned from `Target.attachedToTarget` on a session this client owns.
 * - `targetCreated` / `targetInfoChanged` / `targetDestroyed` are emitted for
 *   this thread's guests alone, once the client asked to discover targets.
 * - Native input runs through a queue shared by every client, inside
 *   `withFocus`, because it lands in whatever widget holds window focus.
 * - When the client goes away, every page session it opened is detached.
 *
 * Electron-free: the port is the Electron side, so the whole router runs
 * against a fake in tests.
 */

import { withoutCookies } from "./cdpCookies";
import { classify } from "./cdpPolicy";

/** One pane webview as the bridge reports it. */
export interface GuestInfo {
  /** Electron's `webContents.id`; never leaves the main process. */
  readonly wcId: number;
  /** The guest's CDP target id, from its own debugger. */
  readonly targetId: string;
  readonly url: string;
  readonly title: string;
}

/** What the Electron side tells the bridge about guests. */
export type GuestEvent =
  /** A CDP event from a guest's debugger on a non-root session. */
  | {
      readonly type: "cdp";
      readonly wcId: number;
      readonly method: string;
      readonly params: unknown;
      readonly sessionId: string;
    }
  | { readonly type: "created"; readonly threadId: string; readonly guest: GuestInfo }
  | { readonly type: "changed"; readonly threadId: string; readonly guest: GuestInfo }
  | {
      readonly type: "destroyed";
      readonly threadId: string;
      readonly wcId: number;
      readonly targetId: string;
    };

/** The Electron side of the bridge, injected. */
export interface GuestPort {
  /** The thread's live pane webviews, in tab order. */
  readonly guestsOf: (threadId: string) => ReadonlyArray<GuestInfo>;
  /** Sends a command on one of the guest's flat sessions. */
  readonly send: (
    wcId: number,
    method: string,
    params: Readonly<Record<string, unknown>> | undefined,
    sessionId: string,
  ) => Promise<unknown>;
  /** Opens a flat session on the guest's own target; resolves its id. */
  readonly attachChild: (wcId: number) => Promise<string>;
  readonly detachChild: (wcId: number, sessionId: string) => Promise<void>;
  /** Subscribes to guest events; returns the unsubscribe. */
  readonly onEvent: (listener: (event: GuestEvent) => void) => () => void;
  /** `webContents.reload()`: a CDP `Page.reload` would reload the app window. */
  readonly reload: (wcId: number, ignoreCache: boolean) => Promise<void>;
  /**
   * Opens a pane tab (hidden when the dock is closed); resolves once it is a
   * target. A tab opened in the `background` does not take the pane's
   * selection unless the thread has no other tab.
   */
  readonly createTab: (threadId: string, url: string, background: boolean) => Promise<GuestInfo>;
  readonly closeTab: (wcId: number) => Promise<void>;
  readonly selectTab: (wcId: number) => Promise<void>;
  /** Runs `operation` while the guest holds window focus, then gives focus back. */
  readonly withFocus: <T>(wcId: number, operation: () => Promise<T>) => Promise<T>;
}

/** What the root session reports for `Browser.getVersion`. */
export interface BrowserVersion {
  readonly protocolVersion: string;
  readonly product: string;
  readonly revision: string;
  readonly userAgent: string;
  readonly jsVersion: string;
}

/** Runs operations one at a time, in the order they were queued. */
export interface SerialQueue {
  readonly run: <T>(operation: () => Promise<T>) => Promise<T>;
}

export const makeSerialQueue = (): SerialQueue => {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run: (operation) => {
      const next = tail.then(operation, operation);
      tail = next.catch(() => undefined);
      return next;
    },
  };
};

export interface BridgeSessionOptions {
  readonly threadId: string;
  readonly port: GuestPort;
  readonly version: BrowserVersion;
  /** Shared by every client: focus is per window, not per thread. */
  readonly inputQueue: SerialQueue;
  /** Writes one message to the client. */
  readonly emit: (message: Readonly<Record<string, unknown>>) => void;
  /**
   * Sees each native-input command the policy let through, just before it
   * is queued for the guest — where the shell learns what to draw of the
   * agent's pointer (`./agentPointer`).
   */
  readonly onAgentInput?: (wcId: number, method: string, params: Params) => void;
  /** Sees every message either way, for recordings and the shell's log. */
  readonly onFrame?: (
    direction: "from-client" | "to-client",
    message: Readonly<Record<string, unknown>>,
  ) => void;
}

export interface BridgeSession {
  /** Handles one client message (a parsed JSON object). */
  readonly receive: (message: unknown) => Promise<void>;
  /** The client disconnected: detach everything it opened. */
  readonly close: () => Promise<void>;
}

interface OwnedSession {
  readonly wcId: number;
  readonly targetId: string;
  /** `page` sessions were opened by the client; `child` ones auto-attached. */
  readonly kind: "page" | "child";
}

type Params = Readonly<Record<string, unknown>>;

/** The error text Chromium uses, which agent-browser already understands. */
const NO_TARGET = "No target with given id found";

class CdpFailure extends Error {}

const asParams = (value: unknown): Params =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Params) : {};

export const openBridgeSession = (options: BridgeSessionOptions): BridgeSession => {
  const { threadId, port } = options;
  const sessions = new Map<string, OwnedSession>();
  const announced = new Set<string>();
  let discover = false;
  let closed = false;

  const emit = (message: Readonly<Record<string, unknown>>): void => {
    if (closed) {
      return;
    }
    options.onFrame?.("to-client", message);
    options.emit(message);
  };

  const attachedHere = (targetId: string): boolean =>
    [...sessions.values()].some((owned) => owned.kind === "page" && owned.targetId === targetId);

  const infoOf = (guest: GuestInfo): Params => ({
    targetId: guest.targetId,
    type: "page",
    title: guest.title,
    url: guest.url,
    attached: attachedHere(guest.targetId),
    canAccessOpener: false,
    browserContextId: `poseidon-thread-${threadId}`,
  });

  const guestByTarget = (targetId: unknown): GuestInfo => {
    const guest = port.guestsOf(threadId).find((candidate) => candidate.targetId === targetId);
    if (guest === undefined) {
      throw new CdpFailure(NO_TARGET);
    }
    return guest;
  };

  const announce = (guest: GuestInfo): void => {
    if (discover && !announced.has(guest.targetId)) {
      announced.add(guest.targetId);
      emit({ method: "Target.targetCreated", params: { targetInfo: infoOf(guest) } });
    }
  };

  const dropSession = (sessionId: string, owned: OwnedSession): void => {
    sessions.delete(sessionId);
    if (owned.kind === "page") {
      emit({
        method: "Target.detachedFromTarget",
        params: { sessionId, targetId: owned.targetId },
      });
    }
  };

  const onGuestEvent = (event: GuestEvent): void => {
    if (event.type === "cdp") {
      const owner = sessions.get(event.sessionId);
      if (owner === undefined || owner.wcId !== event.wcId) {
        return;
      }
      const params = asParams(event.params);
      const child = params["sessionId"];
      if (event.method === "Target.attachedToTarget" && typeof child === "string") {
        const info = asParams(params["targetInfo"]);
        const targetId = typeof info["targetId"] === "string" ? info["targetId"] : "";
        sessions.set(child, { wcId: event.wcId, targetId, kind: "child" });
      }
      if (event.method === "Target.detachedFromTarget" && typeof child === "string") {
        sessions.delete(child);
      }
      emit({
        method: event.method,
        params: withoutCookies(event.method, event.params),
        sessionId: event.sessionId,
      });
      return;
    }
    if (event.threadId !== threadId) {
      return;
    }
    if (event.type === "created") {
      announce(event.guest);
    } else if (event.type === "changed") {
      if (discover && announced.has(event.guest.targetId)) {
        emit({ method: "Target.targetInfoChanged", params: { targetInfo: infoOf(event.guest) } });
      }
    } else {
      // Deleting the entry being visited is safe while iterating a Map.
      for (const [sessionId, owned] of sessions) {
        if (owned.wcId === event.wcId) {
          dropSession(sessionId, owned);
        }
      }
      if (announced.delete(event.targetId)) {
        emit({ method: "Target.targetDestroyed", params: { targetId: event.targetId } });
      }
    }
  };

  const unsubscribe = port.onEvent(onGuestEvent);

  const rootCommand = async (method: string, params: Params): Promise<unknown> => {
    switch (method) {
      case "Browser.getVersion":
        return options.version;
      case "Target.setDiscoverTargets":
        discover = params["discover"] === true;
        if (discover) {
          port.guestsOf(threadId).forEach(announce);
        } else {
          announced.clear();
        }
        return {};
      case "Target.getTargets":
        return { targetInfos: port.guestsOf(threadId).map(infoOf) };
      case "Target.attachToTarget": {
        const guest = guestByTarget(params["targetId"]);
        const sessionId = await port.attachChild(guest.wcId);
        if (closed) {
          // The client hung up while the attach was in flight.
          await port.detachChild(guest.wcId, sessionId).catch(() => undefined);
          throw new CdpFailure("The client disconnected");
        }
        sessions.set(sessionId, { wcId: guest.wcId, targetId: guest.targetId, kind: "page" });
        emit({
          method: "Target.attachedToTarget",
          params: { sessionId, targetInfo: infoOf(guest), waitingForDebugger: false },
        });
        return { sessionId };
      }
      case "Target.detachFromTarget": {
        const sessionId = params["sessionId"];
        const owned = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
        if (typeof sessionId !== "string" || owned === undefined || owned.kind !== "page") {
          throw new CdpFailure("No session with given id");
        }
        await port.detachChild(owned.wcId, sessionId);
        dropSession(sessionId, owned);
        return {};
      }
      case "Target.createTarget": {
        const url = params["url"];
        // CDP's default is a foreground tab, as in a browser: the pane shows
        // what the agent opened unless it asked for the background.
        const guest = await port.createTab(
          threadId,
          typeof url === "string" && url !== "" ? url : "about:blank",
          params["background"] === true,
        );
        announce(guest);
        return { targetId: guest.targetId };
      }
      case "Target.closeTarget":
        await port.closeTab(guestByTarget(params["targetId"]).wcId);
        return { success: true };
      default:
        // `classify` only lets the cases above through.
        throw new CdpFailure(`${method} is not available on this endpoint`);
    }
  };

  const pageCommand = async (
    method: string,
    params: Params,
    sessionId: string,
    owned: OwnedSession,
    kind: "answer-locally" | "virtualize" | "forward" | "forward-with-focus",
  ): Promise<unknown> => {
    if (kind === "answer-locally") {
      // `Target.getTargetInfo`: this session's own guest, or another of the thread's.
      const asked = params["targetId"];
      const targetId = typeof asked === "string" ? asked : owned.targetId;
      return { targetInfo: infoOf(guestByTarget(targetId)) };
    }
    if (kind === "virtualize") {
      if (method === "Page.reload") {
        await port.reload(owned.wcId, params["ignoreCache"] === true);
      } else {
        await port.selectTab(owned.wcId);
      }
      return {};
    }
    // Auto-attach is only ever flat: a nested session would bypass the router.
    const sent = method === "Target.setAutoAttach" ? { ...params, flatten: true } : params;
    if (kind === "forward-with-focus") {
      options.onAgentInput?.(owned.wcId, method, sent);
      return options.inputQueue.run(() =>
        port.withFocus(owned.wcId, () => port.send(owned.wcId, method, sent, sessionId)),
      );
    }
    return withoutCookies(method, await port.send(owned.wcId, method, sent, sessionId));
  };

  const receive = async (message: unknown): Promise<void> => {
    const raw = asParams(message);
    options.onFrame?.("from-client", raw);
    const { id, method } = raw;
    if (typeof id !== "number" || typeof method !== "string") {
      return;
    }
    const params = asParams(raw["params"]);
    const sessionId =
      typeof raw["sessionId"] === "string" && raw["sessionId"] !== "" ? raw["sessionId"] : null;
    const reply = (body: Params): void =>
      emit({ id, ...(sessionId === null ? {} : { sessionId }), ...body });
    try {
      let result: unknown;
      if (sessionId === null) {
        const decision = classify("root", method, params);
        if (decision.kind === "deny") {
          throw new CdpFailure(decision.reason);
        }
        result = await rootCommand(method, params);
      } else {
        const owned = sessions.get(sessionId);
        if (owned === undefined) {
          throw new CdpFailure("Session with given id not found.");
        }
        const decision = classify("page", method, params);
        if (decision.kind === "deny") {
          throw new CdpFailure(decision.reason);
        }
        result = await pageCommand(method, params, sessionId, owned, decision.kind);
      }
      reply({ result: result ?? {} });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      reply({ error: { code: -32000, message: text } });
    }
  };

  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribe();
    const pages = [...sessions].filter(([, owned]) => owned.kind === "page");
    sessions.clear();
    await Promise.all(
      pages.map(([sessionId, owned]) =>
        port.detachChild(owned.wcId, sessionId).catch(() => undefined),
      ),
    );
  };

  return { receive, close };
};
