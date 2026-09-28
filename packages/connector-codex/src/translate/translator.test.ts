/**
 * The translator against the notifications real app-server runs sent: a whole
 * answered turn, an interrupted one, the MCP servers a thread starts, and the
 * notifications it drops on purpose. `recordedFrames.test.ts` proves that no
 * recorded notification goes unmapped; this proves what the mapped ones say.
 */

import { makeTurnId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "vitest";

import { recordedNotifications } from "../../test/frames";
import type { PendingRuntimeEvent } from "./pending";
import { IGNORED, makeTranslator, type TurnContext } from "./translator";

const run = (
  scenario: string,
  turn: TurnContext | null = { turnId: makeTurnId(), interrupted: false },
): ReadonlyArray<PendingRuntimeEvent> => {
  const translator = makeTranslator({ loginCommand: "codex login" });
  return recordedNotifications(scenario).flatMap((notification) =>
    translator.translate(notification, turn),
  );
};

const types = (events: ReadonlyArray<PendingRuntimeEvent>) => events.map((event) => event.type);

describe("makeTranslator", () => {
  it("turns an answered turn into one streamed row, usage, the context and end_turn", () => {
    const turnId = makeTurnId();
    const events = run("plain-reply", { turnId, interrupted: false });
    const turnEvents = types(events).filter((type) => type !== "mcp.status.updated");
    expect(turnEvents).toEqual([
      "item.started",
      "content.delta",
      "item.completed",
      "usage.updated",
      "context.updated",
      "turn.completed",
    ]);
    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed?.type === "turn.completed" && completed.payload).toEqual({
      turnId,
      stopReason: "end_turn",
    });
  });

  it("fails the row a stopped turn left open, and reads the turn as interrupted", () => {
    const events = run("interrupt", { turnId: makeTurnId(), interrupted: true });
    const stops = events.flatMap((event) =>
      event.type === "turn.completed" ? [event.payload.stopReason] : [],
    );
    // One translator, one turn context: both recorded turns read as stopped.
    expect(stops).toEqual(["interrupted", "interrupted"]);
    const first = events.find((event) => event.type === "item.completed");
    expect(first?.type === "item.completed" && first.payload.item.status).toBe("failed");
  });

  it("reports every MCP server the thread started, Poseidon's among them, with its latest state", () => {
    const events = run("plain-reply", null);
    const last = events.filter((event) => event.type === "mcp.status.updated").at(-1);
    const servers = last?.type === "mcp.status.updated" ? last.payload.servers : [];
    expect(servers).toContainEqual({ name: "poseidon", status: "failed" });
    expect(servers.every((server) => server.status !== "connecting")).toBe(true);
  });

  it("drops what IGNORED lists, and keeps anything else it does not know whole", () => {
    const translator = makeTranslator({ loginCommand: "codex login" });
    for (const method of Object.keys(IGNORED)) {
      expect(translator.translate({ method, params: {} }, null), method).toEqual([]);
    }
    const [event] = translator.translate({ method: "brand/new", params: { a: 1 } }, null);
    expect(event).toEqual({
      type: "event.unmapped",
      payload: {},
      raw: { source: "codex.app-server", method: "brand/new", payload: { a: 1 } },
    });
  });

  it("names the login command when the error is the sign-in, and only warns on a retry", () => {
    const translator = makeTranslator({ loginCommand: "codex login" });
    const turn = { turnId: makeTurnId(), interrupted: false };
    const [fatal] = translator.translate(
      {
        method: "error",
        params: { error: { message: "401", codexErrorInfo: "unauthorized" }, willRetry: false },
      },
      turn,
    );
    expect(fatal?.type === "runtime.error" && fatal.payload.fatal).toBe(true);
    expect(fatal?.type === "runtime.error" && fatal.payload.message).toContain("codex login");
    const [retry] = translator.translate(
      { method: "error", params: { error: { message: "busy" }, willRetry: true } },
      turn,
    );
    expect(retry?.type).toBe("session.warning");
  });
});
