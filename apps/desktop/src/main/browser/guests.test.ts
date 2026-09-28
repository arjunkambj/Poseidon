import { EventEmitter } from "node:events";

import type { Session, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { GuestEvent } from "./bridgeSession";
import { createGuestRegistry, popupUrl, threadIdOfPartition } from "./guests";
import type { TabsChannel } from "./tabsChannel";

describe("threadIdOfPartition", () => {
  it("reads the thread out of a pane partition", () => {
    expect(threadIdOfPartition("persist:thread-x")).toBe("x");
    expect(threadIdOfPartition("persist:thread-0199a1b2-c3d4_7e5f")).toBe("0199a1b2-c3d4_7e5f");
  });

  it("gives null for every other partition", () => {
    for (const partition of [
      "",
      "persist:thread-",
      "thread-x",
      "persist:other",
      "persist:thread-a/b",
      "persist:thread-a b",
      "persist:THREAD-x",
      undefined,
      null,
      7,
    ]) {
      expect(threadIdOfPartition(partition)).toBeNull();
    }
  });
});

describe("popupUrl", () => {
  it("keeps http(s) popups and drops the rest", () => {
    expect(popupUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(popupUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000/");
    for (const url of ["about:blank", "file:///etc/passwd", "javascript:alert(1)", "nope"]) {
      expect(popupUrl(url)).toBeNull();
    }
  });
});

/** A guest `webContents` with a debugger, narrowed to what the registry calls. */
class FakeDebugger extends EventEmitter {
  attaches = 0;
  attached = false;
  readonly sent: Array<{ method: string; params: unknown; sessionId?: string }> = [];
  constructor(private readonly targetId: string) {
    super();
  }
  isAttached = () => this.attached;
  attach = () => {
    this.attaches += 1;
    this.attached = true;
  };
  sendCommand = async (method: string, params?: unknown, sessionId?: string) => {
    this.sent.push({ method, params, ...(sessionId === undefined ? {} : { sessionId }) });
    if (method === "Target.getTargetInfo") return { targetInfo: { targetId: this.targetId } };
    if (method === "Target.attachToTarget") return { sessionId: `S-${this.targetId}` };
    return {};
  };
}

class FakeHost {
  readonly scripts: Array<string> = [];
  focusResult = true;
  isDestroyed = () => false;
  executeJavaScript = async (script: string) => {
    this.scripts.push(script);
    return this.focusResult;
  };
}

class FakeGuest extends EventEmitter {
  destroyed = false;
  reloads: Array<string> = [];
  readonly debugger: FakeDebugger;
  constructor(
    readonly id: number,
    readonly session: Session,
    targetId: string,
    readonly hostWebContents: FakeHost | null = new FakeHost(),
  ) {
    super();
    this.debugger = new FakeDebugger(targetId);
  }
  isDestroyed = () => this.destroyed;
  getURL = () => `https://guest-${this.id}.test/`;
  getTitle = () => `Guest ${this.id}`;
  reload = () => this.reloads.push("reload");
  reloadIgnoringCache = () => this.reloads.push("ignoring-cache");
  /** What the window's `did-attach-webview` hands the registry. */
  onAttach: (() => void) | null = null;
  attach() {
    this.onAttach?.();
  }
  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

const setup = (debug = true) => {
  const sessions = new Map<string, Session>();
  const fromPartition = (partition: string): Session => {
    let found = sessions.get(partition);
    if (found === undefined) {
      found = { partition } as unknown as Session;
      sessions.set(partition, found);
    }
    return found;
  };
  const tabCalls: Array<string> = [];
  let onCreate: (threadId: string, url: string) => number = () => 0;
  const tabs: TabsChannel = {
    create: async (threadId, url, background) => {
      tabCalls.push(`create ${threadId} ${url} ${background}`);
      return onCreate(threadId, url);
    },
    close: async (wcId) => void tabCalls.push(`close ${wcId}`),
    select: async (wcId) => void tabCalls.push(`select ${wcId}`),
    answer: () => undefined,
    abandon: () => undefined,
  };
  const registry = createGuestRegistry({ fromPartition, tabs, debug, registerTimeoutMs: 200 });
  const events: Array<GuestEvent> = [];
  registry.port.onEvent((event) => events.push(event));
  /** The receipt for a guest's registration: its `created` event. */
  const created = (wcId: number): Promise<void> =>
    new Promise((resolve) => {
      const seen = (event: GuestEvent) => event.type === "created" && event.guest.wcId === wcId;
      if (events.some(seen)) {
        resolve();
        return;
      }
      const stop = registry.port.onEvent((event) => {
        if (seen(event)) {
          stop();
          resolve();
        }
      });
    });
  const guest = (id: number, partition: string, targetId = `T${id}`) => {
    const fake = new FakeGuest(id, fromPartition(partition), targetId);
    fake.onAttach = () => registry.attached(fake as unknown as WebContents);
    return fake;
  };
  const asWc = (fake: FakeGuest) => fake as unknown as WebContents;
  return {
    registry,
    events,
    created,
    tabCalls,
    guest,
    asWc,
    onCreate: (fn: typeof onCreate) => (onCreate = fn),
  };
};

describe("createGuestRegistry", () => {
  it("tracks only guests in a partition the attach policy admitted", () => {
    const { registry, guest, asWc } = setup();
    registry.noteThread("a");
    expect(registry.track(asWc(guest(1, "persist:thread-a")))).toBe("a");
    expect(registry.track(asWc(guest(2, "persist:thread-b")))).toBeNull();
    expect(registry.track(asWc(guest(3, "persist:other")))).toBeNull();
    expect(registry.threadOf(1)).toBe("a");
    expect(registry.threadOf(2)).toBeNull();
    expect(registry.tabCount("a")).toBe(1);
    expect(registry.tabCount("b")).toBe(0);
  });

  it("attaches each guest's debugger once and reports it as its thread's target", async () => {
    const { registry, events, created, guest, asWc } = setup();
    registry.noteThread("a");
    registry.noteThread("b");
    const a = guest(1, "persist:thread-a");
    const b = guest(2, "persist:thread-b");
    registry.track(asWc(a));
    registry.track(asWc(b));
    expect(registry.port.guestsOf("a")).toEqual([]);

    a.attach();
    b.attach();
    // A `dom-ready` while the first registration is in flight, and one after.
    a.emit("dom-ready");
    await Promise.all([created(1), created(2)]);
    a.emit("dom-ready");

    expect(a.debugger.attaches).toBe(1);
    expect(registry.port.guestsOf("a")).toEqual([
      { wcId: 1, targetId: "T1", url: "https://guest-1.test/", title: "Guest 1" },
    ]);
    expect(registry.port.guestsOf("b").map((info) => info.wcId)).toEqual([2]);
    expect(events.filter((event) => event.type === "created")).toHaveLength(2);
  });

  it("attaches no debugger when the bridge is off", async () => {
    const { registry, guest, asWc } = setup(false);
    registry.noteThread("a");
    const a = guest(1, "persist:thread-a");
    registry.track(asWc(a));
    a.attach();
    a.emit("dom-ready");
    expect(a.debugger.attaches).toBe(0);
    expect(registry.port.guestsOf("a")).toEqual([]);
  });

  it("routes child-session messages and drops the debugger's root session", async () => {
    const { registry, created, events, guest, asWc } = setup();
    registry.noteThread("a");
    const a = guest(1, "persist:thread-a");
    registry.track(asWc(a));
    a.attach();
    await created(1);

    a.debugger.emit("message", {}, "Target.targetCreated", { targetInfo: { type: "page" } }, "");
    a.debugger.emit("message", {}, "Page.loadEventFired", { timestamp: 1 }, "S1");
    expect(events.filter((event) => event.type === "cdp")).toEqual([
      {
        type: "cdp",
        wcId: 1,
        method: "Page.loadEventFired",
        params: { timestamp: 1 },
        sessionId: "S1",
      },
    ]);
  });

  it("opens flat child sessions on the guest's own target", async () => {
    const { registry, created, guest, asWc } = setup();
    registry.noteThread("a");
    const a = guest(1, "persist:thread-a");
    registry.track(asWc(a));
    a.attach();
    await created(1);

    await expect(registry.port.attachChild(1)).resolves.toBe("S-T1");
    await registry.port.send(1, "Runtime.evaluate", { expression: "1" }, "S-T1");
    expect(a.debugger.sent.slice(1)).toEqual([
      { method: "Target.attachToTarget", params: { targetId: "T1", flatten: true } },
      { method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "S-T1" },
    ]);
    await expect(registry.port.attachChild(99)).rejects.toThrow("No target with given id found");
  });

  it("reports navigation and destruction, and forgets a destroyed guest", async () => {
    const { registry, created, events, guest, asWc } = setup();
    registry.noteThread("a");
    const a = guest(1, "persist:thread-a");
    registry.track(asWc(a));
    a.attach();
    await created(1);

    a.emit("page-title-updated");
    a.destroy();
    expect(events.map((event) => event.type)).toEqual(["created", "changed", "destroyed"]);
    expect(events.at(-1)).toEqual({ type: "destroyed", threadId: "a", wcId: 1, targetId: "T1" });
    expect(registry.port.guestsOf("a")).toEqual([]);
    expect(registry.threadOf(1)).toBeNull();
    expect(registry.tabCount("a")).toBe(0);
  });

  it("reloads the guest itself and never sends Page.reload", async () => {
    const { registry, created, guest, asWc } = setup();
    registry.noteThread("a");
    const a = guest(1, "persist:thread-a");
    registry.track(asWc(a));
    a.attach();
    await created(1);

    await registry.port.reload(1, false);
    await registry.port.reload(1, true);
    expect(a.reloads).toEqual(["reload", "ignoring-cache"]);
    expect(a.debugger.sent.map((sent) => sent.method)).not.toContain("Page.reload");
  });

  it("creates a tab through the window and resolves once it is a target", async () => {
    const { registry, tabCalls, guest, asWc, onCreate } = setup();
    registry.noteThread("a");
    onCreate(() => {
      // The window answers with the id before the guest has registered.
      const tab = guest(7, "persist:thread-a");
      registry.track(asWc(tab));
      tab.attach();
      return 7;
    });

    await expect(registry.port.createTab("a", "about:blank", false)).resolves.toMatchObject({
      wcId: 7,
      targetId: "T7",
    });
    // The agent's tab is a foreground one unless it asked for the background.
    expect(tabCalls).toEqual(["create a about:blank false"]);
  });

  it("fails a created tab that never becomes a target", async () => {
    vi.useFakeTimers();
    try {
      const { registry, onCreate } = setup();
      onCreate(() => 42);
      const failed = expect(registry.port.createTab("a", "about:blank", true)).rejects.toThrow(
        /in time/,
      );
      await vi.advanceTimersByTimeAsync(200);
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("focuses the guest's webview by numeric id around native input, one at a time", async () => {
    const { registry, created, guest, asWc } = setup();
    registry.noteThread("a");
    const a = guest(1, "persist:thread-a");
    registry.track(asWc(a));
    a.attach();
    await created(1);
    const host = a.hostWebContents as FakeHost;

    const order: Array<string> = [];
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = () => undefined as void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const both = Promise.all([
      registry.port.withFocus(1, async () => {
        order.push(`run 1 after ${host.scripts.length} scripts`);
        started();
        await gate;
      }),
      registry.port.withFocus(1, async () => {
        order.push(`run 2 after ${host.scripts.length} scripts`);
      }),
    ]);
    await running;
    // The second hand-off has not focused anything while the first runs.
    expect(host.scripts).toHaveLength(1);
    release();
    await both;
    // Focus, run, restore — then the next one.
    expect(order).toEqual(["run 1 after 1 scripts", "run 2 after 3 scripts"]);
    expect(host.scripts).toHaveLength(4);
    for (const script of host.scripts) {
      expect(script).toContain("getWebContentsId() === 1;");
    }

    host.focusResult = false;
    await expect(registry.port.withFocus(1, async () => "ran")).rejects.toThrow(
      /not in the Poseidon window/,
    );
  });
});
