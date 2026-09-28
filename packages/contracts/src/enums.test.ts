import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ApprovalDecision,
  ApprovalKind,
  DEFAULT_RUNTIME_MODE,
  EFFORT_ORDER,
  Effort,
  InteractionMode,
  ItemKind,
  RuntimeMode,
} from "./enums";

describe("closed vocabularies", () => {
  it.effect("carry exactly the members the contract lists", () =>
    Effect.gen(function* () {
      const literals = yield* Effect.succeed({
        runtimeMode: RuntimeMode.literals,
        interactionMode: InteractionMode.literals,
        effort: Effort.literals,
        approvalKind: ApprovalKind.literals,
        approvalDecision: ApprovalDecision.literals,
      });
      expect(literals.runtimeMode).toEqual([
        "approval-required",
        "auto-accept-edits",
        "full-access",
      ]);
      expect(literals.interactionMode).toEqual(["default", "plan"]);
      expect(literals.effort).toEqual([
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ]);
      expect(literals.approvalKind).toEqual([
        "command",
        "file_write",
        "file_read",
        "mcp_tool",
        "web",
        "other",
      ]);
      expect(literals.approvalDecision).toEqual([
        "allow-once",
        "allow-session",
        "allow-always",
        "deny",
      ]);
    }),
  );

  it.effect("give the timeline one ItemKind per row component", () =>
    Effect.gen(function* () {
      const kinds = yield* Effect.succeed(ItemKind.literals);
      expect(kinds).toEqual([
        "user_message",
        "assistant_message",
        "reasoning",
        "plan",
        "command_execution",
        "file_change",
        "tool_call",
        "mcp_tool_call",
        "web_search",
        "task",
        "todo",
        "skill",
        "context_compaction",
        "error",
        "unknown",
      ]);
    }),
  );

  it.effect("reject a member that is not in the union", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.sync(() => Schema.decodeUnknownExit(RuntimeMode)("yolo"));
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("Effort", () => {
  it.effect("keeps decoding every effort a thread may already have stored", () =>
    Effect.gen(function* () {
      const stored = ["minimal", "low", "medium", "high", "xhigh", "max"];
      const decoded = yield* Effect.succeed(
        stored.map((effort) => Schema.decodeUnknownSync(Effort)(effort)),
      );
      expect(decoded).toEqual(stored);
    }),
  );

  it.effect("is ordered by EFFORT_ORDER, lowest rung first", () =>
    Effect.gen(function* () {
      const order = yield* Effect.succeed(EFFORT_ORDER);
      expect(Effort.literals).toEqual(order);
      expect(order[0]).toBe("minimal");
      expect(order.at(-1)).toBe("ultra");
      expect(order.indexOf("ultra")).toBe(order.indexOf("max") + 1);
    }),
  );

  it.effect("decodes ultra and still refuses a rung nobody named", () =>
    Effect.gen(function* () {
      expect(Schema.decodeUnknownSync(Effort)("ultra")).toBe("ultra");
      const exit = yield* Effect.sync(() => Schema.decodeUnknownExit(Effort)("turbo"));
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("DEFAULT_RUNTIME_MODE", () => {
  it.effect("asks before acting", () =>
    Effect.gen(function* () {
      const mode = yield* Effect.succeed(DEFAULT_RUNTIME_MODE);
      expect(mode).toBe("approval-required");
      expect(Schema.decodeUnknownSync(RuntimeMode)(mode)).toBe("approval-required");
    }),
  );
});
