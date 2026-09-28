import { describe, expect, it } from "vitest";

import { sandboxModeFor, sandboxPolicyFor } from "./modes";
import { parseSessionRef } from "./sessionRef";

describe("parseSessionRef", () => {
  it("reads a thread id and working directory back", () => {
    const ref = { threadId: "01a0e608-2e3b-7d60-be44-b15f9be4c9ae", cwd: "/w" };
    expect(parseSessionRef(ref)).toEqual(ref);
  });

  it.each([
    ["nothing", undefined],
    ["a string", "01a0e608-2e3b-7d60-be44-b15f9be4c9ae"],
    ["another connector's ref", { sessionId: "01a0e608-2e3b-7d60-be44-b15f9be4c9ae", cwd: "/w" }],
    ["an id that is not a UUID", { threadId: "thread-1", cwd: "/w" }],
    ["no working directory", { threadId: "01a0e608-2e3b-7d60-be44-b15f9be4c9ae", cwd: "" }],
  ])("refuses %s", (_, raw) => {
    expect(parseSessionRef(raw)).toBeUndefined();
  });
});

describe("the sandbox a runtime mode runs in", () => {
  it("writes the workspace in the asking modes, and lifts the sandbox for full access", () => {
    expect(sandboxModeFor("approval-required")).toBe("workspace-write");
    expect(sandboxModeFor("auto-accept-edits")).toBe("workspace-write");
    expect(sandboxModeFor("full-access")).toBe("danger-full-access");
    expect(sandboxPolicyFor("approval-required").type).toBe("workspaceWrite");
    expect(sandboxPolicyFor("full-access")).toEqual({ type: "dangerFullAccess" });
  });
});
