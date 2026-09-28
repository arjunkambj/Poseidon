import { describe, expect, it, vi } from "vitest";

import { makeQuitGuard } from "./quitGuard";

const quitEvent = () => ({ preventDefault: vi.fn() });

const setup = (options: { busy?: number; window?: boolean } = {}) => {
  let busy = options.busy ?? 0;
  const ask = vi.fn(() => options.window ?? true);
  const quit = vi.fn();
  const guard = makeQuitGuard({ busyCount: () => busy, ask, quit });
  return { guard, ask, quit, setBusy: (count: number) => (busy = count) };
};

describe("makeQuitGuard", () => {
  it("passes a quit through when nothing is running", () => {
    const { guard, ask } = setup({ busy: 0 });
    const event = quitEvent();
    expect(guard.onBeforeQuit(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("holds the first quit while threads are busy and asks once", () => {
    const { guard, ask, quit } = setup({ busy: 2 });
    const event = quitEvent();
    expect(guard.onBeforeQuit(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
  });

  it("lets a second quit through while the question is open", () => {
    const { guard, ask } = setup({ busy: 1 });
    guard.onBeforeQuit(quitEvent());
    const second = quitEvent();
    expect(guard.onBeforeQuit(second)).toBe(false);
    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalledOnce();
  });

  it("clears the hold on cancel, so the next quit asks again", () => {
    const { guard, ask, quit } = setup({ busy: 1 });
    guard.onBeforeQuit(quitEvent());
    guard.answer(false);
    expect(quit).not.toHaveBeenCalled();
    expect(guard.onBeforeQuit(quitEvent())).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("quits on confirm, and that quit passes through", () => {
    const { guard, quit } = setup({ busy: 1 });
    guard.onBeforeQuit(quitEvent());
    guard.answer(true);
    expect(quit).toHaveBeenCalledOnce();
    const event = quitEvent();
    expect(guard.onBeforeQuit(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("ignores an answer nobody asked for", () => {
    const { guard, quit } = setup({ busy: 1 });
    guard.answer(true);
    expect(quit).not.toHaveBeenCalled();
    expect(guard.onBeforeQuit(quitEvent())).toBe(true);
  });

  it("passes a quit through when there is no window to ask", () => {
    const { guard, ask } = setup({ busy: 3, window: false });
    const event = quitEvent();
    expect(guard.onBeforeQuit(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalledOnce();
  });

  it("reads the busy count at quit time", () => {
    const { guard, setBusy } = setup({ busy: 0 });
    setBusy(1);
    expect(guard.onBeforeQuit(quitEvent())).toBe(true);
  });
});
