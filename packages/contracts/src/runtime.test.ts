import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeConnectorInstanceId, makeEventId, makeRequestId, makeThreadId } from "./ids";
import {
  ApprovalRequest,
  ConnectorCapabilities,
  RuntimeEvent,
  RuntimeEventType,
  runtimeEventTypes,
} from "./runtime";

const envelope = () => ({
  eventId: makeEventId(),
  connectorInstanceId: makeConnectorInstanceId(),
  threadId: makeThreadId(),
  createdAt: "2026-09-15T12:00:00.000Z",
});

describe("RuntimeEvent", () => {
  it.effect("declares one union member per RuntimeEventType, in the same order", () =>
    Effect.gen(function* () {
      const fromUnion = yield* Effect.succeed(runtimeEventTypes);
      expect(fromUnion).toEqual(RuntimeEventType.literals);
    }),
  );

  it.effect("has no duplicate type tags", () =>
    Effect.gen(function* () {
      const tags = yield* Effect.succeed(runtimeEventTypes);
      expect(new Set(tags).size).toBe(tags.length);
    }),
  );
});

describe("event.unmapped", () => {
  const decode = Schema.decodeUnknownExit(RuntimeEvent);

  it.effect("keeps the frame it could not translate", () =>
    Effect.gen(function* () {
      const decoded = yield* Effect.sync(() =>
        Schema.decodeUnknownSync(RuntimeEvent)({
          ...envelope(),
          type: "event.unmapped",
          payload: {},
          raw: { source: "cmd.ndjson", payload: { type: "something_new" } },
        }),
      );
      expect(decoded.type).toBe("event.unmapped");
      expect(decoded.raw?.source).toBe("cmd.ndjson");
    }),
  );

  it.effect("is rejected without raw, because the frame is the whole point", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.sync(() =>
        decode({ ...envelope(), type: "event.unmapped", payload: {} }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("leaves raw optional on a translated event", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.sync(() =>
        decode({ ...envelope(), type: "session.warning", payload: { message: "slow start" } }),
      );
      expect(exit._tag).toBe("Success");
    }),
  );
});

describe("ApprovalRequest", () => {
  const request = {
    requestId: makeRequestId(),
    kind: "mcp_tool",
    toolName: "mcp__github__create_issue",
    input: { title: "x" },
    patternSuggestion: "Mcp(github.create_issue)",
    description: "Call an MCP tool",
  };

  it.effect("decodes a request stored before mcpTool existed", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.sync(() => Schema.decodeUnknownExit(ApprovalRequest)(request));
      expect(exit._tag).toBe("Success");
    }),
  );

  it.effect("carries the MCP server and tool a call goes to", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(ApprovalRequest)({
        ...request,
        mcpTool: { server: "github", tool: "create_issue" },
      });
      expect(decoded.mcpTool).toEqual({ server: "github", tool: "create_issue" });
      const exit = yield* Effect.sync(() =>
        Schema.decodeUnknownExit(ApprovalRequest)({ ...request, mcpTool: { server: "" } }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("ConnectorCapabilities", () => {
  const stored = {
    modelSwitch: "per-turn",
    effortSwitch: "per-turn",
    steering: false,
    planMode: true,
    subagents: true,
    images: true,
    resume: true,
    fork: false,
    interrupt: "turn",
    rollback: false,
    compaction: false,
    questions: true,
    runtimeModes: ["approval-required"],
    attachments: "images",
  };

  it.effect("decodes capabilities stored before textGeneration existed, as absent", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(ConnectorCapabilities)(stored);
      expect(decoded.textGeneration).toBeUndefined();
      expect("textGeneration" in decoded).toBe(false);
    }),
  );

  it.effect("carries textGeneration when a connector declares it", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(ConnectorCapabilities)({
        ...stored,
        textGeneration: true,
      });
      expect(decoded.textGeneration).toBe(true);
    }),
  );

  it.effect("reads ultracode as absent on capabilities stored before it, and carries it", () =>
    Effect.gen(function* () {
      const old = yield* Schema.decodeUnknownEffect(ConnectorCapabilities)(stored);
      expect("ultracode" in old).toBe(false);
      const declared = yield* Schema.decodeUnknownEffect(ConnectorCapabilities)({
        ...stored,
        ultracode: true,
      });
      expect(declared.ultracode).toBe(true);
    }),
  );
});

describe("model.changed", () => {
  const modelChanged = (payload: Record<string, unknown>) => ({
    ...envelope(),
    type: "model.changed",
    payload: { model: "claude-opus-4-7", ...payload },
  });

  it.effect("still decodes a payload stored before ultracode existed", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(RuntimeEvent)(
        modelChanged({ effort: "high" }),
      );
      if (decoded.type !== "model.changed") throw new Error(decoded.type);
      expect(decoded.payload.effort).toBe("high");
      expect("ultracode" in decoded.payload).toBe(false);
    }),
  );

  it.effect("round-trips ultracode and the ultra effort rung", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(RuntimeEvent)(
        modelChanged({ effort: "xhigh", ultracode: true }),
      );
      if (decoded.type !== "model.changed") throw new Error(decoded.type);
      expect(decoded.payload.ultracode).toBe(true);
      const again = yield* Schema.decodeUnknownEffect(RuntimeEvent)(
        yield* Schema.encodeEffect(RuntimeEvent)(decoded),
      );
      expect(again).toEqual(decoded);
      const ultra = yield* Schema.decodeUnknownEffect(RuntimeEvent)(
        modelChanged({ effort: "ultra" }),
      );
      if (ultra.type !== "model.changed") throw new Error(ultra.type);
      expect(ultra.payload.effort).toBe("ultra");
    }),
  );
});
