/**
 * The CLI's notices, read field by field as the SDK 0.3.280 declares them.
 * No recording has one yet — each needs a signed-in CLI that retries, refuses
 * or nears a limit — so these are the pure readings; `recordedFrames.test.ts`
 * holds every recorded message to a mapping.
 */

import { describe, expect, it } from "vitest";

import { makeNotices } from "./notices";

const warnings = (events: ReturnType<ReturnType<typeof makeNotices>["read"]>) =>
  (events ?? []).flatMap((event) =>
    event.type === "session.warning" ? [event.payload.message] : [],
  );

describe("makeNotices", () => {
  it("says a retried request, why it failed and when it goes again", () => {
    const notices = makeNotices();
    expect(
      warnings(
        notices.read({
          type: "system",
          subtype: "api_retry",
          attempt: 2,
          max_retries: 10,
          retry_delay_ms: 4200,
          error_status: 529,
          error: "overloaded",
        }),
      ),
    ).toEqual([
      "Claude Code request failed (overloaded, HTTP 529); retrying in 4s, attempt 2 of 10.",
    ]);
    expect(
      warnings(
        notices.read({
          type: "system",
          subtype: "api_retry",
          error_status: null,
          error: "unknown",
        }),
      ),
    ).toEqual(["Claude Code request failed (unknown); retrying."]);
  });

  it("says a refusal with the CLI's own line, or what happened when it gave none", () => {
    const notices = makeNotices();
    expect(
      warnings(
        notices.read({
          type: "system",
          subtype: "model_refusal_fallback",
          fallback_model: "claude-fallback",
          content: "  Retried on another model.  ",
        }),
      ),
    ).toEqual(["Retried on another model."]);
    expect(
      warnings(
        notices.read({
          type: "system",
          subtype: "model_refusal_fallback",
          fallback_model: "claude-fallback",
          content: "",
        }),
      ),
    ).toEqual(["The model declined this request; claude-fallback answered it instead."]);
    expect(
      warnings(notices.read({ type: "system", subtype: "model_refusal_no_fallback" })),
    ).toEqual(["The model declined this request."]);
  });

  it("shows the CLI's banners above its transcript-only level", () => {
    const notices = makeNotices();
    for (const level of ["warning", "suggestion", "notice"]) {
      expect(
        warnings(notices.read({ type: "system", subtype: "informational", level, content: "Hi" })),
      ).toEqual(["Hi"]);
    }
    expect(
      notices.read({ type: "system", subtype: "informational", level: "info", content: "Hi" }),
    ).toEqual([]);
    expect(
      notices.read({ type: "system", subtype: "informational", level: "warning", content: " " }),
    ).toEqual([]);
  });

  it("shows only the CLI's high-priority notifications", () => {
    const notices = makeNotices();
    const notification = (priority: string) =>
      notices.read({ type: "system", subtype: "notification", key: "k", text: "Look", priority });
    expect(warnings(notification("high"))).toEqual(["Look"]);
    expect(warnings(notification("immediate"))).toEqual(["Look"]);
    expect(notification("medium")).toEqual([]);
    expect(notification("low")).toEqual([]);
  });

  it("says the usage limit once per change of status", () => {
    const notices = makeNotices();
    const status = (info: Record<string, unknown>) =>
      warnings(notices.read({ type: "rate_limit_event", rate_limit_info: info }));
    expect(status({ status: "allowed" })).toEqual([]);
    expect(
      status({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.912 }),
    ).toEqual(["Claude is close to its five hour usage limit (91% used)."]);
    expect(status({ status: "allowed_warning", rateLimitType: "five_hour" })).toEqual([]);
    expect(
      status({ status: "rejected", rateLimitType: "seven_day", resetsAt: 1_790_000_000 }),
    ).toEqual(["Claude reached its seven day usage limit; it resets at 2026-09-21T14:13:20.000Z."]);
    expect(status({ status: "allowed" })).toEqual([]);
    expect(status({ status: "rejected" })).toEqual(["Claude reached its usage limit."]);
  });

  it("answers a local command's output as a completed assistant row", () => {
    const [event] =
      makeNotices().read({
        type: "system",
        subtype: "local_command_output",
        content: "Total cost: $0.00\n",
      }) ?? [];
    expect(event).toMatchObject({
      type: "item.completed",
      payload: {
        item: { kind: "assistant_message", status: "completed", text: "Total cost: $0.00" },
      },
    });
    expect(
      makeNotices().read({ type: "system", subtype: "local_command_output", content: "" }),
    ).toEqual([]);
  });

  it.each([
    ["system", "permission_denied"],
    ["system", "session_state_changed"],
    ["system", "background_tasks_changed"],
    ["system", "commands_changed"],
    ["system", "thinking_tokens"],
    ["system", "hook_started"],
    ["system", "hook_progress"],
    ["system", "hook_response"],
    ["system", "files_persisted"],
    ["system", "memory_recall"],
    ["system", "elicitation_complete"],
    ["system", "mirror_error"],
    ["system", "worker_shutting_down"],
    ["system", "plugin_install"],
    ["system", "control_request_progress"],
    ["tool_progress", undefined],
    ["tool_use_summary", undefined],
    ["prompt_suggestion", undefined],
    ["auth_status", undefined],
    ["active_goal", undefined],
  ])("leaves %s %s out on purpose", (type, subtype) => {
    expect(makeNotices().read({ type, ...(subtype === undefined ? {} : { subtype }) })).toEqual([]);
  });

  it.each([
    ["an undeclared system subtype", { type: "system", subtype: "something_new" }],
    ["a system message named like an object key", { type: "system", subtype: "constructor" }],
    ["an undeclared message type", { type: "something_new" }],
    ["a message with no type", {}],
  ])("does not know %s, which stays unmapped", (_label, message) => {
    expect(makeNotices().read(message)).toBeUndefined();
  });
});
