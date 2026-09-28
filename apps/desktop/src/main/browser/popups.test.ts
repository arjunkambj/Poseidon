import { describe, expect, it } from "vitest";

import { makePopupGate } from "./popups";

const clock = () => {
  let at = 0;
  return { now: () => at, advance: (ms: number) => (at += ms) };
};

describe("makePopupGate", () => {
  it("opens a popup in front only when its opener has focus", () => {
    const gate = makePopupGate();
    expect(gate.decide({ threadId: "a", openTabs: 1, openerFocused: true })).toEqual({
      kind: "open",
      background: false,
    });
    expect(gate.decide({ threadId: "a", openTabs: 2, openerFocused: false })).toEqual({
      kind: "open",
      background: true,
    });
  });

  it("drops popups past the burst until the window moves on", () => {
    const time = clock();
    const gate = makePopupGate({ now: time.now, burst: 3, windowMs: 1000 });
    const ask = (threadId = "a") => gate.decide({ threadId, openTabs: 1, openerFocused: false });
    expect([ask(), ask(), ask()].map((decision) => decision.kind)).toEqual([
      "open",
      "open",
      "open",
    ]);
    expect(ask().kind).toBe("drop");
    // Another thread has its own budget.
    expect(ask("b").kind).toBe("open");
    time.advance(999);
    expect(ask().kind).toBe("drop");
    time.advance(1);
    expect(ask().kind).toBe("open");
  });

  it("drops every popup once the thread holds the tab cap", () => {
    const gate = makePopupGate({ maxTabs: 5 });
    expect(gate.decide({ threadId: "a", openTabs: 4, openerFocused: true }).kind).toBe("open");
    expect(gate.decide({ threadId: "a", openTabs: 5, openerFocused: true })).toMatchObject({
      kind: "drop",
    });
  });
});
