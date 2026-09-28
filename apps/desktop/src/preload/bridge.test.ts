/**
 * The renderer half of the server-state seam, asserted against a fake channel.
 *
 * Two earlier passes each believed the *other* side of this bridge was the
 * incomplete one, so the members the renderer's `Window["poseidon"]` type
 * declares are pinned here: all three server-state members exist, the state
 * carries its `connection`, and every subscription hands back an unsubscribe
 * that actually detaches the listener.
 */

import { describe, expect, it } from "vitest";

import {
  ATTENTION_BADGE_CHANNEL,
  ATTENTION_BEEP_CHANNEL,
  ATTENTION_BUSY_CHANNEL,
  ATTENTION_KEEP_AWAKE_CHANNEL,
  ATTENTION_NOTIFY_CHANNEL,
  OPEN_THREAD_CHANNEL,
  QUIT_ANSWER_CHANNEL,
  QUIT_REQUEST_CHANNEL,
} from "../main/attentionChannels";
import { POINTER_CHANNEL } from "../main/browser/agentPointer";
import { CHORDS_CHANNEL, COMMAND_CHANNEL } from "../main/browser/guestChords";
import {
  CAPTURE_CHANNEL,
  CLEAR_ALL_CHANNEL,
  CLEAR_THREAD_CHANNEL,
  NO_TAB_HOST,
  TAB_ANSWER_CHANNEL,
  TAB_REQUEST_CHANNEL,
} from "../main/browser/tabsChannel";
import { makePoseidonBridge, type PreloadIpc, type ServerState } from "./bridge";

type Listener = (event: unknown, ...args: never) => void;

/** Records invokes and lets a test push on a channel, as the main process does. */
const fakeIpc = () => {
  const invokes: Array<{ channel: string; args: ReadonlyArray<unknown> }> = [];
  const invokeWaiters: Array<() => void> = [];
  const listeners = new Map<string, Array<Listener>>();
  const answers = new Map<string, unknown>();
  const ipc: PreloadIpc = {
    invoke: (channel, ...args) => {
      invokes.push({ channel, args });
      invokeWaiters.splice(0).forEach((wake) => wake());
      return Promise.resolve(answers.get(channel));
    },
    on: (channel, listener) => {
      const existing = listeners.get(channel) ?? [];
      existing.push(listener);
      listeners.set(channel, existing);
    },
    removeListener: (channel, listener) => {
      listeners.set(
        channel,
        (listeners.get(channel) ?? []).filter((entry) => entry !== listener),
      );
    },
  };
  return {
    ipc,
    invokes,
    answer: (channel: string, value: unknown) => answers.set(channel, value),
    listenerCount: (channel: string) => (listeners.get(channel) ?? []).length,
    /** Resolves once `count` invokes have been made in all. */
    invoked: (count: number): Promise<void> =>
      new Promise((resolve) => {
        const check = () => {
          if (invokes.length >= count) resolve();
          else invokeWaiters.push(check);
        };
        check();
      }),
    push: (channel: string, payload: unknown) => {
      for (const listener of listeners.get(channel) ?? []) {
        (listener as (event: unknown, payload: unknown) => void)({}, payload);
      }
    },
  };
};

const READY: ServerState = {
  status: "ready",
  connection: { url: "ws://127.0.0.1:4711/ws", token: "t-1", serverInstanceId: "boot-1" },
  attempt: null,
  reason: null,
};

describe("makePoseidonBridge", () => {
  it("exposes the three server-state members the renderer type declares", () => {
    const bridge = makePoseidonBridge(fakeIpc().ipc);
    expect(typeof bridge.getConnection).toBe("function");
    expect(typeof bridge.getServerState).toBe("function");
    expect(typeof bridge.onServerState).toBe("function");
  });

  it("answers getServerState with the connection the main process published", async () => {
    const fake = fakeIpc();
    fake.answer("poseidon:server-state:get", READY);
    const state = await makePoseidonBridge(fake.ipc).getServerState();
    expect(state).toEqual(READY);
    expect(state.connection?.serverInstanceId).toBe("boot-1");
    expect(fake.invokes).toEqual([{ channel: "poseidon:server-state:get", args: [] }]);
  });

  it("delivers a restart's fresh connection to an onServerState subscriber", () => {
    const fake = fakeIpc();
    const seen: Array<ServerState> = [];
    const stop = makePoseidonBridge(fake.ipc).onServerState((state) => seen.push(state));

    fake.push("poseidon:server-state", {
      status: "restarting",
      connection: null,
      attempt: 1,
      reason: null,
    });
    const restarted: ServerState = {
      status: "ready",
      connection: { url: "ws://127.0.0.1:5822/ws", token: "t-2", serverInstanceId: "boot-2" },
      attempt: null,
      reason: null,
    };
    fake.push("poseidon:server-state", restarted);

    expect(seen.map((state) => state.status)).toEqual(["restarting", "ready"]);
    expect(seen[1]?.connection).toEqual(restarted.connection);
    stop();
  });

  it("detaches its own listener on unsubscribe and leaves other subscribers alone", () => {
    const fake = fakeIpc();
    const bridge = makePoseidonBridge(fake.ipc);
    const first: Array<ServerState> = [];
    const second: Array<ServerState> = [];
    const stopFirst = bridge.onServerState((state) => first.push(state));
    const stopSecond = bridge.onServerState((state) => second.push(state));
    expect(fake.listenerCount("poseidon:server-state")).toBe(2);

    stopFirst();
    fake.push("poseidon:server-state", READY);

    expect(first).toEqual([]);
    expect(second).toEqual([READY]);
    expect(fake.listenerCount("poseidon:server-state")).toBe(1);
    stopSecond();
    expect(fake.listenerCount("poseidon:server-state")).toBe(0);
  });

  it("routes the rest of the surface to its own channel", async () => {
    const fake = fakeIpc();
    const bridge = makePoseidonBridge(fake.ipc);
    await bridge.openExternal("https://example.test");
    await bridge.pickDirectory();
    expect(fake.invokes).toEqual([
      { channel: "poseidon:open-external", args: ["https://example.test"] },
      { channel: "poseidon:pick-directory", args: [] },
    ]);
    expect(bridge.browserPane).not.toHaveProperty("attach");
    expect(bridge.browserPane).not.toHaveProperty("detach");
  });

  it("hands browser-pane input through with its thread and tab", () => {
    const fake = fakeIpc();
    const seen: Array<{ threadId: string; wcId: number; input: unknown }> = [];
    const stop = makePoseidonBridge(fake.ipc).browserPane.onInput((payload) => seen.push(payload));
    fake.push("poseidon:browser-input", {
      threadId: "thread-1",
      wcId: 12,
      input: { kind: "click", x: 1, y: 2 },
    });
    stop();
    fake.push("poseidon:browser-input", {
      threadId: "thread-1",
      wcId: 12,
      input: { kind: "key", key: "a" },
    });
    expect(seen).toEqual([
      { threadId: "thread-1", wcId: 12, input: { kind: "click", x: 1, y: 2 } },
    ]);
  });

  it("answers tab requests with no tab host at once, then through the host", async () => {
    const fake = fakeIpc();
    const bridge = makePoseidonBridge(fake.ipc);

    fake.push(TAB_REQUEST_CHANNEL, { id: 1, op: "select", wcId: 4 });
    const requests: Array<unknown> = [];
    const stop = bridge.browserPane.serveTabs(async (request) => {
      requests.push(request);
      if (request.op === "close") throw new Error("no such tab");
      return request.op === "create" ? { wcId: 31 } : {};
    });
    fake.push(TAB_REQUEST_CHANNEL, {
      id: 2,
      op: "create",
      threadId: "t",
      url: "about:blank",
      background: true,
    });
    fake.push(TAB_REQUEST_CHANNEL, { id: 3, op: "close", wcId: 31 });
    await fake.invoked(3);
    stop();
    fake.push(TAB_REQUEST_CHANNEL, { id: 4, op: "select", wcId: 31 });
    await fake.invoked(4);

    expect(requests).toEqual([
      { op: "create", threadId: "t", url: "about:blank", background: true },
      { op: "close", wcId: 31 },
    ]);
    expect(fake.invokes).toEqual([
      { channel: TAB_ANSWER_CHANNEL, args: [{ id: 1, ok: false, error: NO_TAB_HOST }] },
      { channel: TAB_ANSWER_CHANNEL, args: [{ id: 2, ok: true, wcId: 31 }] },
      { channel: TAB_ANSWER_CHANNEL, args: [{ id: 3, ok: false, error: "no such tab" }] },
      { channel: TAB_ANSWER_CHANNEL, args: [{ id: 4, ok: false, error: NO_TAB_HOST }] },
    ]);
  });

  it("hands a popup's opener to the tab host and answers with the new tab", async () => {
    const fake = fakeIpc();
    const requests: Array<unknown> = [];
    const stop = makePoseidonBridge(fake.ipc).browserPane.serveTabs(async (request) => {
      requests.push(request);
      return { wcId: 40 };
    });
    fake.push(TAB_REQUEST_CHANNEL, {
      id: 9,
      op: "create",
      threadId: "t",
      url: "https://popup.test/",
      background: false,
      opener: 12,
    });
    await fake.invoked(1);
    stop();
    expect(requests).toEqual([
      { op: "create", threadId: "t", url: "https://popup.test/", background: false, opener: 12 },
    ]);
    expect(fake.invokes).toEqual([
      { channel: TAB_ANSWER_CHANNEL, args: [{ id: 9, ok: true, wcId: 40 }] },
    ]);
  });

  it("asks main to clear a deleted thread's browsing data on its own channel", async () => {
    const fake = fakeIpc();
    await makePoseidonBridge(fake.ipc).browserPane.clearThread("thread-1");
    expect(fake.invokes).toEqual([{ channel: CLEAR_THREAD_CHANNEL, args: ["thread-1"] }]);
  });

  it("hands main the pane's chords and delivers the commands it relays back", async () => {
    const fake = fakeIpc();
    const pane = makePoseidonBridge(fake.ipc).browserPane;
    const chords = [
      { command: "browser.reload", key: "r", meta: true, control: false, alt: false, shift: false },
    ];
    await pane.setChords(chords);
    expect(fake.invokes).toEqual([{ channel: CHORDS_CHANNEL, args: [chords] }]);

    const seen: Array<unknown> = [];
    const stop = pane.onCommand((payload) => seen.push(payload));
    fake.push(COMMAND_CHANNEL, { threadId: "thread-1", wcId: 12, command: "browser.reload" });
    stop();
    fake.push(COMMAND_CHANNEL, { threadId: "thread-1", wcId: 12, command: "browser.back" });
    expect(seen).toEqual([{ threadId: "thread-1", wcId: 12, command: "browser.reload" }]);
  });

  it("delivers the agent's pointer until unsubscribed", () => {
    const fake = fakeIpc();
    const pane = makePoseidonBridge(fake.ipc).browserPane;
    const seen: Array<unknown> = [];
    const stop = pane.onAgentPointer((payload) => seen.push(payload));
    const pointer = { threadId: "thread-1", wcId: 12, x: 5, y: 6, kind: "press" };
    fake.push(POINTER_CHANNEL, pointer);
    stop();
    fake.push(POINTER_CHANNEL, { ...pointer, kind: "move" });
    expect(seen).toEqual([pointer]);
    expect(fake.listenerCount(POINTER_CHANNEL)).toBe(0);
  });

  it("asks main for a pane tab's PNG by its guest id", async () => {
    const fake = fakeIpc();
    const png = new Uint8Array([0x89, 0x50]);
    fake.answer(CAPTURE_CHANNEL, png);
    const pane = makePoseidonBridge(fake.ipc).browserPane;
    await expect(pane.capture(12)).resolves.toBe(png);
    expect(fake.invokes).toEqual([{ channel: CAPTURE_CHANNEL, args: [12] }]);
  });

  it("asks main to clear every thread's browsing data", async () => {
    const fake = fakeIpc();
    fake.answer(CLEAR_ALL_CHANNEL, 3);
    const pane = makePoseidonBridge(fake.ipc).browserPane;
    await expect(pane.clearAll()).resolves.toBe(3);
    expect(fake.invokes).toEqual([{ channel: CLEAR_ALL_CHANNEL, args: [] }]);
  });

  it("routes each attention call to its own channel", async () => {
    const fake = fakeIpc();
    fake.answer(ATTENTION_KEEP_AWAKE_CHANNEL, true);
    const attention = makePoseidonBridge(fake.ipc).attention;
    const notice = { threadId: "thread-1", title: "Finished", body: "Fix the build" };
    await attention.notify(notice);
    await attention.setBadge(2);
    await attention.beep();
    await expect(attention.setKeepAwake(true)).resolves.toBe(true);
    await attention.setBusy(3);
    await attention.answerQuit(false);
    expect(fake.invokes).toEqual([
      { channel: ATTENTION_NOTIFY_CHANNEL, args: [notice] },
      { channel: ATTENTION_BADGE_CHANNEL, args: [2] },
      { channel: ATTENTION_BEEP_CHANNEL, args: [] },
      { channel: ATTENTION_KEEP_AWAKE_CHANNEL, args: [true] },
      { channel: ATTENTION_BUSY_CHANNEL, args: [3] },
      { channel: QUIT_ANSWER_CHANNEL, args: [false] },
    ]);
  });

  it("delivers notification clicks and quit requests until unsubscribed", () => {
    const fake = fakeIpc();
    const attention = makePoseidonBridge(fake.ipc).attention;
    const opened: Array<string> = [];
    let asked = 0;
    const stopOpen = attention.onOpenThread((threadId) => opened.push(threadId));
    const stopQuit = attention.onQuitRequest(() => (asked += 1));
    fake.push(OPEN_THREAD_CHANNEL, "thread-1");
    fake.push(QUIT_REQUEST_CHANNEL, undefined);
    stopOpen();
    stopQuit();
    fake.push(OPEN_THREAD_CHANNEL, "thread-2");
    fake.push(QUIT_REQUEST_CHANNEL, undefined);
    expect(opened).toEqual(["thread-1"]);
    expect(asked).toBe(1);
    expect(fake.listenerCount(OPEN_THREAD_CHANNEL)).toBe(0);
    expect(fake.listenerCount(QUIT_REQUEST_CHANNEL)).toBe(0);
  });
});
