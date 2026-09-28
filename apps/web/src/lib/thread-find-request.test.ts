import { describe, expect, it } from "vitest";

import { onThreadFindRequest, requestThreadFind, takeThreadFind } from "./thread-find-request";

describe("thread find requests", () => {
  it("is taken once, by the thread it names", () => {
    requestThreadFind({ threadId: "t1", query: "lantern", itemId: "i1" });
    expect(takeThreadFind("t2")).toBeNull();
    expect(takeThreadFind("t1")).toEqual({ threadId: "t1", query: "lantern", itemId: "i1" });
    expect(takeThreadFind("t1")).toBeNull();
  });

  it("is replaced by a newer request", () => {
    requestThreadFind({ threadId: "t1", query: "old" });
    requestThreadFind({ threadId: "t2", query: "new" });
    expect(takeThreadFind("t1")).toBeNull();
    expect(takeThreadFind("t2")).toEqual({ threadId: "t2", query: "new" });
  });

  it("reaches a timeline that is already mounted", () => {
    const taken: Array<string> = [];
    const stop = onThreadFindRequest(() => {
      const request = takeThreadFind("t3");
      if (request !== null) {
        taken.push(request.query);
      }
    });
    requestThreadFind({ threadId: "t4", query: "elsewhere" });
    requestThreadFind({ threadId: "t3", query: "here" });
    stop();
    requestThreadFind({ threadId: "t3", query: "later" });
    expect(taken).toEqual(["here"]);
    expect(takeThreadFind("t3")?.query).toBe("later");
  });
});
