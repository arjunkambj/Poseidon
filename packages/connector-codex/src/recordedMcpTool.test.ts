/**
 * The Codex definition against `codex/mcp-tool-approval`, replayed behind the
 * binary path as in `recordedSession.test.ts`: the CLI asks to run a tool of
 * Poseidon's MCP server with an elicitation, and the connector raises it on
 * the approval card as an MCP tool call — not as input an MCP server wants —
 * and accepts it when the card allows it, so the call runs.
 *
 * The replay checks what the connector sent against what the recording says
 * it sent; the divergence log must stay empty.
 */

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  closed,
  ofType,
  prompts,
  replaying,
  rows,
  stopReasons,
  text,
  turnWithCard,
} from "../test/replaySession";

describe("a Codex session replaying codex/mcp-tool-approval", () => {
  it.live("raises the MCP tool call on the card, and runs it once allowed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, assertDone } = yield* replaying("mcp-tool-approval");
        const session = yield* open();
        const { request } = yield* turnWithCard(
          session,
          text(prompts("mcp-tool-approval")[0]!),
          "allow-once",
        );
        const events = yield* closed(session);
        assertDone();

        expect(request).toMatchObject({
          kind: "mcp_tool",
          toolName: "mcp__poseidon__browser_open",
          mcpTool: { server: "poseidon", tool: "browser_open" },
          input: { url: "https://example.com" },
          patternSuggestion: "Mcp(poseidon.browser_open)",
        });
        const calls = rows(events, "mcp_tool_call");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.status).toBe("completed");
        expect(stopReasons(events)).toEqual(["end_turn"]);
        // Nothing was refused behind the user's back.
        expect(ofType(events, "session.warning")).toEqual([]);
        expect(ofType(events, "runtime.error")).toEqual([]);
        expect(ofType(events, "event.unmapped")).toEqual([]);
      }),
    ),
  );
});
