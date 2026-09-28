import { describe, expect, it } from "vitest";

import {
  onTimelineRevealRequest,
  requestTimelineReveal,
  takeTimelineReveal,
} from "./timeline-reveal-request";

describe("timeline reveal requests", () => {
  it("is taken once, by the thread it names", () => {
    requestTimelineReveal({ threadId: "t1", itemId: "i1" });
    expect(takeTimelineReveal("t2")).toBeNull();
    expect(takeTimelineReveal("t1")).toEqual({ threadId: "t1", itemId: "i1" });
    expect(takeTimelineReveal("t1")).toBeNull();
  });

  it("is replaced by a newer request", () => {
    requestTimelineReveal({ threadId: "t1", itemId: "old" });
    requestTimelineReveal({ threadId: "t2", itemId: "new" });
    expect(takeTimelineReveal("t1")).toBeNull();
    expect(takeTimelineReveal("t2")).toEqual({ threadId: "t2", itemId: "new" });
  });

  it("reaches a timeline that is already mounted", () => {
    const taken: Array<string> = [];
    const stop = onTimelineRevealRequest(() => {
      const request = takeTimelineReveal("t3");
      if (request !== null) {
        taken.push(request.itemId);
      }
    });
    requestTimelineReveal({ threadId: "t4", itemId: "elsewhere" });
    requestTimelineReveal({ threadId: "t3", itemId: "here" });
    stop();
    requestTimelineReveal({ threadId: "t3", itemId: "later" });
    expect(taken).toEqual(["here"]);
    expect(takeTimelineReveal("t3")?.itemId).toBe("later");
  });
});
