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
  it("reads only under approval required, writes the workspace under auto-accept, and lifts it for full access", () => {
    // A write the CLI fails to ask about must meet the sandbox, not the disk.
    expect(sandboxModeFor("approval-required")).toBe("read-only");
    expect(sandboxModeFor("auto-accept-edits")).toBe("workspace-write");
    expect(sandboxModeFor("full-access")).toBe("danger-full-access");
    expect(sandboxPolicyFor("approval-required")).toEqual({
      type: "readOnly",
      networkAccess: false,
    });
    expect(sandboxPolicyFor("auto-accept-edits").type).toBe("workspaceWrite");
    expect(sandboxPolicyFor("full-access")).toEqual({ type: "dangerFullAccess" });
  });
});
