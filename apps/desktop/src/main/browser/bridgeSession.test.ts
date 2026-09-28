import { describe, expect, it } from "vitest";

import { recordingNames } from "@poseidon/testkit/recording";

import { FakeGuestPort, openSession, replayScenario, replyTo } from "./test/replay";

const THREAD = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

/** A target id the app window had in the attach spike: never a pane guest. */
const APP_WINDOW_TARGET = "8B72F611C70945049A3495945CEE2739";

const errorOf = (message: Readonly<Record<string, unknown>> | undefined): string | undefined =>
  (message?.["error"] as { message?: string } | undefined)?.message;

describe("replaying agent-browser 0.38.1 through the router", () => {
  it.each(recordingNames("agent-browser"))(
    "%s: every recorded command succeeds where it succeeded live",
    async (scenario) => {
      const { exchanges } = await replayScenario(scenario);
      expect(exchanges.length).toBeGreaterThan(0);
      for (const { request, recorded, live } of exchanges) {
        expect(live, `${String(request["method"])} got no reply`).toBeDefined();
        expect(errorOf(live), `${String(request["method"])}`).toBe(errorOf(recorded));
      }
    },
  );

  it.each(recordingNames("agent-browser"))(
    "%s: lists and announces only the thread's own targets",
    async (scenario) => {
      const { port, sent, threadId, foreign } = await replayScenario(scenario);
      const reported = sent.flatMap((message) => {
        const params = message["params"] as Record<string, unknown> | undefined;
        const result = message["result"] as Record<string, unknown> | undefined;
        const infos = [
          ...((result?.["targetInfos"] as ReadonlyArray<Record<string, unknown>>) ?? []),
          ...(params?.["targetInfo"] === undefined
            ? []
            : [params["targetInfo"] as Record<string, unknown>]),
        ];
        return infos.map((info) => info["targetId"]);
      });
      expect(reported.length).toBeGreaterThan(0);
      expect(reported).not.toContain(foreign.targetId);
      // Every target it reported is one of this thread's, live or since closed.
      expect(reported.filter((id) => port.threadOfTarget.get(String(id)) !== threadId)).toEqual([]);
      for (const message of sent) {
        const info = (message["params"] as Record<string, unknown> | undefined)?.["targetInfo"] as
          | Record<string, unknown>
          | undefined;
        if (info !== undefined && message["sessionId"] === undefined) {
          expect(info["type"]).toBe("page");
        }
      }
    },
  );

  it("turns Page.reload into a guest reload and never forwards it", async () => {
    const { port, exchanges } = await replayScenario("reload");
    expect(exchanges.some(({ request }) => request["method"] === "Page.reload")).toBe(true);
    expect(port.calls.filter((call) => call.op === "reload")).toHaveLength(1);
    expect(port.calls.some((call) => call.op === "send" && call.method === "Page.reload")).toBe(
      false,
    );
  });

  it("selects the pane tab for Page.bringToFront", async () => {
    const { port } = await replayScenario("popup");
    const selected = port.calls.filter((call) => call.op === "selectTab");
    expect(selected).toHaveLength(2);
    expect(
      port.calls.some((call) => call.op === "send" && call.method === "Page.bringToFront"),
    ).toBe(false);
  });

  it("opens a pane tab for createTarget, about:blank included", async () => {
    const empty = await replayScenario("empty-thread-createTarget");
    expect(empty.port.calls.filter((call) => call.op === "createTab")).toEqual([
      { op: "createTab", threadId: empty.threadId, url: "about:blank", background: false },
    ]);
    const tabs = await replayScenario("tab-new-close");
    expect(tabs.port.calls.filter((call) => call.op === "createTab")).toEqual([
      {
        op: "createTab",
        threadId: tabs.threadId,
        url: "http://127.0.0.1:4173/page2",
        background: false,
      },
    ]);
    expect(tabs.port.calls.filter((call) => call.op === "closeTab")).toHaveLength(1);
  });

  it("sends native input only while the guest holds focus", async () => {
    const { port } = await replayScenario("connect-and-drive");
    const input = port.calls.filter(
      (call) => call.op === "send" && call.method.startsWith("Input."),
    );
    expect(input.length).toBeGreaterThan(0);
    expect(input.every((call) => call.op === "send" && call.focused)).toBe(true);
    expect(port.maxConcurrentFocus).toBe(1);
    const other = port.calls.filter(
      (call) => call.op === "send" && !call.method.startsWith("Input."),
    );
    expect(other.every((call) => call.op === "send" && !call.focused)).toBe(true);
  });

  it("detaches every page session the client opened when it disconnects", async () => {
    const { port, session, sent } = await replayScenario("popup");
    const opened = sent
      .filter((message) => message["method"] === "Target.attachedToTarget")
      .map((message) => (message["params"] as Record<string, unknown>)["sessionId"]);
    expect(opened.length).toBe(2);
    await session.close();
    const detached = port.calls.flatMap((call) =>
      call.op === "detachChild" ? [call.sessionId] : [],
    );
    expect(detached.sort()).toEqual([...opened].sort());
  });
});

describe("the root session", () => {
  const attach = async (targetId: string, flat: { flatten?: unknown } = { flatten: true }) => {
    const { port, session, sent } = openSession(THREAD);
    port.addGuest(THREAD, "OWN-TARGET", "https://example.com/");
    port.addGuest("another-thread", "FOREIGN-TARGET");
    await session.receive({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId, ...flat },
    });
    return { port, reply: replyTo(sent, 1) };
  };

  it("attaches flat to the thread's own guest", async () => {
    const { port, reply } = await attach("OWN-TARGET");
    expect(reply?.["result"]).toEqual({ sessionId: "SESSION-1" });
    expect(port.calls).toEqual([{ op: "attachChild", wcId: 1 }]);
  });

  it("does not find another thread's guest or the app window", async () => {
    for (const target of ["FOREIGN-TARGET", APP_WINDOW_TARGET]) {
      const { port, reply } = await attach(target);
      expect(errorOf(reply)).toBe("No target with given id found");
      expect(port.calls).toEqual([]);
    }
  });

  it("refuses a non-flat attach", async () => {
    for (const flat of [{ flatten: false }, {}]) {
      const { port, reply } = await attach("OWN-TARGET", flat);
      expect(errorOf(reply)).toBe("Only flat sessions are supported");
      expect(port.calls).toEqual([]);
    }
  });

  it("refuses browser-wide commands without touching a guest", async () => {
    const { port, session, sent } = openSession(THREAD);
    port.addGuest(THREAD, "OWN-TARGET");
    const methods = [
      "Browser.close",
      "Browser.setDownloadBehavior",
      "Target.attachToBrowserTarget",
      "Target.exposeDevToolsProtocol",
      "Target.createBrowserContext",
      "Storage.getCookies",
    ];
    for (const [index, method] of methods.entries()) {
      await session.receive({ id: index + 1, method, params: {} });
      expect(errorOf(replyTo(sent, index + 1))).toContain("not available on this endpoint");
    }
    expect(port.calls).toEqual([]);
  });

  it("answers page commands only on sessions it opened", async () => {
    const { port, session, sent } = openSession(THREAD);
    port.addGuest(THREAD, "OWN-TARGET");
    await session.receive({ id: 1, method: "Runtime.evaluate", sessionId: "GUESSED", params: {} });
    expect(errorOf(replyTo(sent, 1))).toBe("Session with given id not found.");
    expect(port.calls).toEqual([]);
  });

  it("reports the guest going away as a detach and a destroyed target", async () => {
    const { port, session, sent } = openSession(THREAD);
    const guest = port.addGuest(THREAD, "OWN-TARGET");
    await session.receive({
      id: 1,
      method: "Target.setDiscoverTargets",
      params: { discover: true },
    });
    await session.receive({
      id: 2,
      method: "Target.attachToTarget",
      params: { targetId: "OWN-TARGET", flatten: true },
    });
    port.destroyGuest(guest.wcId);
    expect(sent.slice(-2)).toEqual([
      {
        method: "Target.detachedFromTarget",
        params: { sessionId: "SESSION-1", targetId: "OWN-TARGET" },
      },
      { method: "Target.targetDestroyed", params: { targetId: "OWN-TARGET" } },
    ]);
    await session.receive({ id: 3, method: "Runtime.evaluate", sessionId: "SESSION-1" });
    expect(errorOf(replyTo(sent, 3))).toBe("Session with given id not found.");
  });
});

describe("page sessions", () => {
  const attached = async () => {
    const { port, session, sent } = openSession(THREAD);
    port.addGuest(THREAD, "OWN-TARGET");
    await session.receive({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "OWN-TARGET", flatten: true },
    });
    return { port, session, sent };
  };

  it("runs native input one command at a time, across the whole bridge", async () => {
    const port = new FakeGuestPort();
    const { session } = openSession(THREAD, port);
    port.addGuest(THREAD, "OWN-TARGET");
    await session.receive({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "OWN-TARGET", flatten: true },
    });
    const releases: Array<() => void> = [];
    port.focusGate = () => new Promise<void>((resolve) => releases.push(resolve));
    const first = session.receive({
      id: 2,
      method: "Input.dispatchMouseEvent",
      sessionId: "SESSION-1",
      params: { type: "mousePressed", x: 1, y: 1 },
    });
    const second = session.receive({
      id: 3,
      method: "Input.insertText",
      sessionId: "SESSION-1",
      params: { text: "a" },
    });
    await expect.poll(() => releases.length).toBe(1);
    releases[0]?.();
    await first;
    await expect.poll(() => releases.length).toBe(2);
    releases[1]?.();
    await second;
    expect(port.maxConcurrentFocus).toBe(1);
  });

  it("shows the shell each native input it lets through, and nothing else", async () => {
    const seen: Array<unknown> = [];
    const { port, session } = openSession(THREAD, new FakeGuestPort(), (wcId, method, params) =>
      seen.push({ wcId, method, params }),
    );
    port.addGuest(THREAD, "OWN-TARGET");
    await session.receive({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "OWN-TARGET", flatten: true },
    });
    await session.receive({
      id: 2,
      method: "Input.dispatchMouseEvent",
      sessionId: "SESSION-1",
      params: { type: "mousePressed", x: 3, y: 4 },
    });
    await session.receive({ id: 3, method: "Runtime.evaluate", sessionId: "SESSION-1" });
    expect(seen).toEqual([
      {
        wcId: 1,
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: 3, y: 4 },
      },
    ]);
  });

  it("forces auto-attach flat and relays the children it creates", async () => {
    const { port, session, sent } = await attached();
    const forwarded: Array<unknown> = [];
    const send = port.send;
    Object.assign(port, {
      send: async (wcId: number, method: string, params: unknown) => {
        forwarded.push(params);
        return send(wcId, method);
      },
    });
    await session.receive({
      id: 2,
      method: "Target.setAutoAttach",
      sessionId: "SESSION-1",
      params: { autoAttach: true, flatten: false, waitForDebuggerOnStart: true },
    });
    expect(forwarded).toEqual([{ autoAttach: true, flatten: true, waitForDebuggerOnStart: true }]);
    port.emit({
      type: "cdp",
      wcId: 1,
      method: "Target.attachedToTarget",
      sessionId: "SESSION-1",
      params: { sessionId: "CHILD-1", targetInfo: { targetId: "FRAME-1", type: "iframe" } },
    });
    await session.receive({ id: 3, method: "Runtime.enable", sessionId: "CHILD-1" });
    expect(replyTo(sent, 3)?.["error"]).toBeUndefined();
    // An event on a session nobody here opened goes nowhere.
    port.emit({
      type: "cdp",
      wcId: 1,
      method: "Page.loadEventFired",
      sessionId: "OTHER",
      params: {},
    });
    expect(sent.some((message) => message["sessionId"] === "OTHER")).toBe(false);
  });

  it("refuses navigation off the web and the denied methods", async () => {
    const { port, session, sent } = await attached();
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["Page.navigate", { url: "file:///etc/passwd" }],
      ["Page.navigate", { url: "chrome://settings" }],
      ["Page.navigate", { url: "devtools://devtools/bundled/inspector.html" }],
      ["Page.close", {}],
      ["DOM.setFileInputFiles", { files: ["/etc/passwd"] }],
      ["Network.getAllCookies", {}],
      ["IO.read", { handle: "1" }],
      ["Target.createTarget", { url: "https://example.com" }],
      ["Browser.getVersion", {}],
    ];
    for (const [index, [method, params]] of cases.entries()) {
      await session.receive({ id: 10 + index, method, sessionId: "SESSION-1", params });
      expect(errorOf(replyTo(sent, 10 + index)), method).toBeDefined();
    }
    expect(port.calls.filter((call) => call.op !== "attachChild")).toEqual([]);
  });

  it("never lets an emulated viewport reach the guest, so the page keeps the pane's size", async () => {
    const { port, session, sent } = await attached();
    // `agent-browser set viewport 1280 720`, as it sends it, then the other sizing calls.
    const sizing: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      [
        "Emulation.setDeviceMetricsOverride",
        { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false },
      ],
      ["Browser.getWindowForTarget", { targetId: "OWN-TARGET" }],
      ["Emulation.setVisibleSize", { width: 1280, height: 720 }],
      ["Emulation.setPageScaleFactor", { pageScaleFactor: 2 }],
    ];
    for (const [index, [method, params]] of sizing.entries()) {
      await session.receive({ id: 10 + index, method, sessionId: "SESSION-1", params });
      expect(errorOf(replyTo(sent, 10 + index)), method).toBeDefined();
    }
    expect(errorOf(replyTo(sent, 10))).toContain("the browser pane's size");
    expect(port.calls.filter((call) => call.op !== "attachChild")).toEqual([]);

    // The emulation that leaves the size alone still reaches the page.
    await session.receive({
      id: 20,
      method: "Emulation.setEmulatedMedia",
      sessionId: "SESSION-1",
      params: { features: [{ name: "prefers-color-scheme", value: "dark" }] },
    });
    expect(errorOf(replyTo(sent, 20))).toBeUndefined();
    expect(port.calls.filter((call) => call.op === "send")).toMatchObject([
      { op: "send", method: "Emulation.setEmulatedMedia" },
    ]);
  });

  it("opens a background tab only when createTarget asks for one", async () => {
    const { port, session } = openSession(THREAD);
    await session.receive({
      id: 1,
      method: "Target.createTarget",
      params: { url: "http://127.0.0.1:4173/", background: true },
    });
    await session.receive({ id: 2, method: "Target.createTarget", params: { url: "" } });
    expect(port.calls.filter((call) => call.op === "createTab")).toEqual([
      { op: "createTab", threadId: THREAD, url: "http://127.0.0.1:4173/", background: true },
      { op: "createTab", threadId: THREAD, url: "about:blank", background: false },
    ]);
  });

  it("answers Target.getTargetInfo from the thread's guests", async () => {
    const { session, sent } = await attached();
    await session.receive({ id: 2, method: "Target.getTargetInfo", sessionId: "SESSION-1" });
    expect(replyTo(sent, 2)?.["result"]).toMatchObject({
      targetInfo: { targetId: "OWN-TARGET", type: "page", attached: true },
    });
  });
});

describe("closing", () => {
  it("detaches an attach that lands after the client hung up", async () => {
    const port = new FakeGuestPort();
    const { session } = openSession(THREAD, port);
    port.addGuest(THREAD, "OWN-TARGET");
    const attaching = session.receive({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "OWN-TARGET", flatten: true },
    });
    await session.close();
    await attaching;
    expect(port.calls).toEqual([
      { op: "attachChild", wcId: 1 },
      { op: "detachChild", wcId: 1, sessionId: "SESSION-1" },
    ]);
  });
});
