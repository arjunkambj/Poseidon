import { makeThreadId } from "@poseidon/contracts/ids";
import { describe, expect, it, vi } from "vitest";

import { GENERATION_OFFLINE, GENERATION_UNAVAILABLE } from "@/lib/generation-run";

import { regenerateTitleFor, regenerateTitleHint } from "./regenerate-title";

const toasts = () => ({ loading: vi.fn(), success: vi.fn(), error: vi.fn() });

describe("regenerateTitleFor", () => {
  it("shows one toast that turns into the new title, and says the notice", async () => {
    const threadId = makeThreadId();
    const shown = toasts();
    const notice = vi.fn();
    await regenerateTitleFor(threadId, {
      regenerate: async () => ({
        ok: true,
        value: { title: "Login redirect fix", notice: "Used the thread's model." },
      }),
      toasts: shown,
      notice,
    });
    const id = { id: `regenerate-title-${threadId}` };
    expect(shown.loading).toHaveBeenCalledWith("Writing a new title…", id);
    expect(shown.success).toHaveBeenCalledWith("Renamed to “Login redirect fix”", id);
    expect(notice).toHaveBeenCalledWith("Used the thread's model.");
  });

  it("turns the toast into the server's reason when it fails", async () => {
    const threadId = makeThreadId();
    const shown = toasts();
    await regenerateTitleFor(threadId, {
      regenerate: async () => ({ ok: false, message: GENERATION_UNAVAILABLE }),
      toasts: shown,
      notice: vi.fn(),
    });
    expect(shown.error).toHaveBeenCalledWith(
      `Couldn't regenerate the title: ${GENERATION_UNAVAILABLE}`,
      { id: `regenerate-title-${threadId}` },
    );
  });

  it("ignores a second request while the first one writes", async () => {
    const threadId = makeThreadId();
    const regenerate = vi.fn(async () => ({ ok: true, value: { title: "One title" } }) as const);
    const deps = { regenerate, toasts: toasts(), notice: vi.fn() };
    await Promise.all([regenerateTitleFor(threadId, deps), regenerateTitleFor(threadId, deps)]);
    expect(regenerate).toHaveBeenCalledOnce();
    // Once it has answered, the thread can ask again.
    await regenerateTitleFor(threadId, deps);
    expect(regenerate).toHaveBeenCalledTimes(2);
  });
});

describe("regenerateTitleHint", () => {
  it("is short, and absent when something can write", () => {
    expect(regenerateTitleHint(null)).toBeNull();
    expect(regenerateTitleHint(GENERATION_OFFLINE)).toBe("Offline");
    expect(regenerateTitleHint(GENERATION_UNAVAILABLE)).toBe("Unavailable");
  });
});
