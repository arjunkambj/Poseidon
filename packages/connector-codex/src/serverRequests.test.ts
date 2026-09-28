/**
 * The safe refusal each unhandled server request gets: nothing is granted,
 * the thread is told when the model was refused something, and every request
 * is answered.
 */

import { describe, expect, it } from "vitest";

import { METHOD_NOT_FOUND } from "./rpc";
import { refusalFor } from "./serverRequests";

const request = (method: string) => ({ id: 0, method, params: {} });

describe("refusalFor", () => {
  it("grants no extra sandbox permissions, for this turn only", () => {
    const refusal = refusalFor(request("item/permissions/requestApproval"));
    expect(refusal.outcome).toEqual({ result: { permissions: {}, scope: "turn" } });
    expect(refusal.warning).toBeDefined();
  });

  it("declines an MCP server's elicitation", () => {
    const refusal = refusalFor(request("mcpServer/elicitation/request"));
    expect(refusal.outcome).toEqual({ result: { action: "decline", content: null, _meta: null } });
    expect(refusal.warning).toBeDefined();
  });

  it.each(["execCommandApproval", "applyPatchApproval"])("denies the older %s", (method) => {
    const refusal = refusalFor(request(method));
    expect(refusal.outcome).toMatchObject({ result: { decision: { denied: {} } } });
    expect(refusal.warning).toContain(method);
  });

  it("answers anything else not handled, without a warning", () => {
    const refusal = refusalFor(request("item/tool/call"));
    expect(refusal.outcome).toMatchObject({ error: { code: METHOD_NOT_FOUND } });
    expect(refusal.warning).toBeUndefined();
  });
});
