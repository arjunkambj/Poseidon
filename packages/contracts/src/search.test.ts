import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { PoseidonRpcGroup, RPC_METHODS } from "./rpc";
import { MESSAGE_SEARCH_LIMIT, MessageSearchHit, ThreadsSearchMessagesRpc } from "./search";

const THREAD_ID = "018f2b6e-1c2d-7a3b-8c4d-5e6f7a8b9c0d";
const PROJECT_ID = "018f2b6e-1c2d-7a3b-8c4d-5e6f7a8b9c0e";
const ITEM_ID = "018f2b6e-1c2d-7a3b-8c4d-5e6f7a8b9c0f";

const wire = {
  threadId: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Fix the lantern",
  archived: true,
  itemId: ITEM_ID,
  role: "assistant",
  snippet: "…the lantern flickers because…",
};

describe("threads.searchMessages", () => {
  it("is one of the group's methods, under the name RPC_METHODS gives it", () => {
    expect(RPC_METHODS.threadsSearchMessages).toBe("threads.searchMessages");
    expect(PoseidonRpcGroup.requests.get("threads.searchMessages")).toBe(ThreadsSearchMessagesRpc);
  });

  it("round-trips a hit through the wire encoding", () => {
    const hit = Schema.decodeUnknownSync(MessageSearchHit)(wire);
    expect(Schema.encodeSync(MessageSearchHit)(hit)).toEqual(wire);
  });

  it("refuses a hit from a role that is never indexed", () => {
    expect(() => Schema.decodeUnknownSync(MessageSearchHit)({ ...wire, role: "tool" })).toThrow();
  });

  it("takes a query with an optional whole-number limit", () => {
    const payload = Schema.decodeUnknownSync(ThreadsSearchMessagesRpc.payloadSchema);
    expect(payload({ query: "lantern" })).toEqual({ query: "lantern" });
    expect(payload({ query: "lantern", limit: 10 })).toEqual({ query: "lantern", limit: 10 });
    expect(() => payload({ query: "lantern", limit: 1.5 })).toThrow();
  });

  it("caps an answer at a positive bound", () => {
    expect(Number.isInteger(MESSAGE_SEARCH_LIMIT)).toBe(true);
    expect(MESSAGE_SEARCH_LIMIT).toBeGreaterThan(0);
  });
});
