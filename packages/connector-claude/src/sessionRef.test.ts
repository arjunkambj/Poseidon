import { describe, expect, it } from "vitest";

import { parseSessionRef, reportedSessionId } from "./sessionRef";

const SESSION = "194d63a1-7180-4e20-95d4-396321ca399c";

describe("parseSessionRef", () => {
  it("reads a full ref", () => {
    expect(
      parseSessionRef({
        sessionId: SESSION,
        cwd: "/work/repo",
        lastAssistantUuid: "3a3e5f56-8c4a-4e9c-a79f-f6c9c6d87f6c",
        totalCostUsd: 0.25,
      }),
    ).toEqual({
      sessionId: SESSION,
      cwd: "/work/repo",
      lastAssistantUuid: "3a3e5f56-8c4a-4e9c-a79f-f6c9c6d87f6c",
      totalCostUsd: 0.25,
    });
  });

  it("reads the minimal ref and ignores fields it does not know", () => {
    expect(parseSessionRef({ sessionId: SESSION, cwd: "/work/repo", other: 1 })).toEqual({
      sessionId: SESSION,
      cwd: "/work/repo",
    });
  });

  it("drops optional fields that are not what they say", () => {
    expect(
      parseSessionRef({ sessionId: SESSION, cwd: "/w", lastAssistantUuid: 7, totalCostUsd: -1 }),
    ).toEqual({ sessionId: SESSION, cwd: "/w" });
  });

  it.each([
    ["nothing", undefined],
    ["a string", SESSION],
    ["another connector's ref", { sessionId: SESSION, transcriptPath: "/t" }],
    ["an id the CLI would refuse", { sessionId: "not-a-uuid", cwd: "/w" }],
    ["an empty cwd", { sessionId: SESSION, cwd: "" }],
  ])("is undefined for %s", (_label, raw) => {
    expect(parseSessionRef(raw)).toBeUndefined();
  });
});

describe("reportedSessionId", () => {
  it("reads the id a system/init names", () => {
    expect(reportedSessionId({ type: "system", subtype: "init", session_id: SESSION })).toBe(
      SESSION,
    );
  });

  it.each([
    ["another system message", { type: "system", subtype: "status", session_id: SESSION }],
    ["a result", { type: "result", subtype: "success", session_id: SESSION }],
    ["an init with no id", { type: "system", subtype: "init" }],
    ["an init whose id is not a uuid", { type: "system", subtype: "init", session_id: "x" }],
    ["nothing", undefined],
  ])("is undefined for %s", (_label, message) => {
    expect(reportedSessionId(message)).toBeUndefined();
  });
});
