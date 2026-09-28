import { afterEach, describe, expect, it, vi } from "vitest";

import {
  answerQuit,
  beep,
  hasDesktopAttention,
  notify,
  onOpenThread,
  onQuitRequest,
  requestWebNotifications,
  setBadge,
  setBusy,
  setKeepAwake,
  webNotificationPermission,
} from "./desktop-attention";

const NOTICE = { threadId: "thread-1", title: "Finished", body: "Fix the build" };

/** A web `Notification` stand-in that records what was posted. */
const fakeWebNotifications = (permission: NotificationPermission) => {
  const posted: Array<{ title: string; options: unknown; onclick: (() => void) | null }> = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = async () => {
      FakeNotification.permission = "granted";
      return FakeNotification.permission;
    };
    onclick: (() => void) | null = null;
    constructor(title: string, options: unknown) {
      posted.push(this as unknown as (typeof posted)[number]);
      Object.assign(this, { title, options });
    }
    close() {}
  }
  vi.stubGlobal("Notification", FakeNotification);
  return posted;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("desktop attention", () => {
  it("hands every call to the shell bridge when there is one", async () => {
    const attention = {
      notify: vi.fn(async () => undefined),
      setBadge: vi.fn(async () => undefined),
      setKeepAwake: vi.fn(async () => true),
      setBusy: vi.fn(async () => undefined),
      answerQuit: vi.fn(async () => undefined),
    };
    vi.stubGlobal("window", { poseidon: { attention } });
    expect(hasDesktopAttention()).toBe(true);
    notify(NOTICE);
    setBadge(2);
    setBusy(1);
    answerQuit(true);
    await expect(setKeepAwake(true)).resolves.toBe(true);
    expect(attention.notify).toHaveBeenCalledWith(NOTICE);
    expect(attention.setBadge).toHaveBeenCalledWith(2);
    expect(attention.setBusy).toHaveBeenCalledWith(1);
    expect(attention.answerQuit).toHaveBeenCalledWith(true);
  });

  it("is quiet in a plain browser without notification permission", async () => {
    vi.stubGlobal("window", { focus: vi.fn() });
    const posted = fakeWebNotifications("default");
    expect(hasDesktopAttention()).toBe(false);
    notify(NOTICE);
    setBadge(3);
    setBusy(3);
    answerQuit(true);
    expect(posted).toEqual([]);
    await expect(setKeepAwake(true)).resolves.toBeNull();
    const stop = onQuitRequest(() => undefined);
    expect(typeof stop).toBe("function");
    stop();
  });

  it("posts a web notification with permission, and its click opens the thread", () => {
    const focus = vi.fn();
    vi.stubGlobal("window", { focus });
    const posted = fakeWebNotifications("granted");
    const opened: Array<string> = [];
    const stop = onOpenThread((threadId) => opened.push(threadId));
    notify(NOTICE);
    expect(posted).toHaveLength(1);
    posted[0]?.onclick?.();
    expect(focus).toHaveBeenCalledOnce();
    expect(opened).toEqual(["thread-1"]);
    stop();
    notify(NOTICE);
    posted[1]?.onclick?.();
    expect(opened).toEqual(["thread-1"]);
  });

  it("subscribes to the shell's clicks and quit requests and detaches both", () => {
    const stopOpen = vi.fn();
    const stopQuit = vi.fn();
    const attention = {
      onOpenThread: vi.fn(() => stopOpen),
      onQuitRequest: vi.fn(() => stopQuit),
    };
    vi.stubGlobal("window", { poseidon: { attention } });
    onOpenThread(() => undefined)();
    onQuitRequest(() => undefined)();
    expect(attention.onOpenThread).toHaveBeenCalledOnce();
    expect(stopOpen).toHaveBeenCalledOnce();
    expect(stopQuit).toHaveBeenCalledOnce();
  });

  it("beeps through the shell, and falls back to a blip that never throws", () => {
    const shellBeep = vi.fn(async () => undefined);
    vi.stubGlobal("window", { poseidon: { attention: { beep: shellBeep } } });
    beep();
    expect(shellBeep).toHaveBeenCalledOnce();

    vi.stubGlobal("window", {});
    vi.stubGlobal("AudioContext", undefined);
    expect(() => beep()).not.toThrow();
  });

  it("reports and requests the browser's notification permission", async () => {
    vi.stubGlobal("Notification", undefined);
    expect(webNotificationPermission()).toBeNull();
    await expect(requestWebNotifications()).resolves.toBeNull();

    fakeWebNotifications("default");
    expect(webNotificationPermission()).toBe("default");
    await expect(requestWebNotifications()).resolves.toBe("granted");
    expect(webNotificationPermission()).toBe("granted");
  });
});
