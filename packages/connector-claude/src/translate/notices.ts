/**
 * The CLI's notices: the messages that are neither the conversation nor its
 * bookkeeping the translator already reads, as the SDK 0.3.280 declares them.
 *
 * Each one is either said to the thread or left out on purpose, so none is
 * kept as `event.unmapped`, which nothing shows:
 *
 * - said, as a `session.warning`: a request the CLI retries (`api_retry`), the
 *   model refusing and a fallback model answering or nobody answering
 *   (`model_refusal_fallback`, `model_refusal_no_fallback`), the CLI's own
 *   banners at warning, suggestion or notice level (`informational`), its
 *   high-priority notifications (`notification`), and the account's usage
 *   limit becoming close or reached (`rate_limit_event`, said once per
 *   change, since the CLI reports the same status with every request);
 * - said, as an answered row: the output of one of the CLI's own commands
 *   (`local_command_output`). CLI 2.1.280 answers its commands as synthetic
 *   assistant snapshots instead (`fixtures/claude/local-command/`), which the
 *   translator reads as any answer; the SDK declares this message too;
 * - left out, with the reason beside each: progress, timing, the CLI's own
 *   lists and states, and the messages only an option Poseidon does not set
 *   turns on.
 *
 * A fallback model's answer replaces the refused one in the CLI's
 * transcript; the refused rows already on the timeline stay, since the
 * contract has no event that takes a row back.
 */

import { makeItemId } from "@poseidon/contracts/ids";

import { asNumber, asRecord, asString, type Json, type PendingRuntimeEvent } from "./pending";

/** `system` subtypes left out, each with the reason it is. */
const IGNORED_SYSTEM: Readonly<Record<string, string>> = {
  permission_denied: "a rule refused a call, and the call's error result fails its row",
  session_state_changed: "the result says when a turn ends",
  background_tasks_changed: "the task_* messages carry each task",
  commands_changed: "the command list is read from the CLI's handshake",
  thinking_tokens: "a progress estimate while the model thinks",
  hook_started: "sent only with includeHookEvents, which the session does not set",
  hook_progress: "sent only with includeHookEvents, which the session does not set",
  hook_response: "sent only with includeHookEvents, which the session does not set",
  files_persisted: "files uploaded for a hosted session",
  memory_recall: "memories surfaced into the turn, which the answer uses",
  elicitation_complete: "an MCP server's URL elicitation ended, and nothing waits on it",
  mirror_error: "a transcript mirror failed, and the session sets none",
  worker_shutting_down: "a hosted worker going away; a local CLI's exit is a crash",
  plugin_install: "a plugin installing at startup, which the handshake waited for",
  control_request_progress: "progress of the SDK's own request, which its answer settles",
};

/** Top-level message types left out, each with the reason it is. */
const IGNORED_TYPES: Readonly<Record<string, string>> = {
  tool_progress: "a running call's elapsed time; its row shows it running",
  tool_use_summary: "a summary of calls whose rows are already there",
  prompt_suggestion: "sent only with promptSuggestions, which the session does not set",
  auth_status: "a sign-in flow's progress, and the session starts none",
  active_goal: "the CLI's /goal indicator",
};

/** The banner levels that are shown; `info` is for the CLI's transcript mode only. */
const SHOWN_LEVELS = new Set(["warning", "suggestion", "notice"]);

/** The notification priorities that are shown. */
const SHOWN_PRIORITIES = new Set(["high", "immediate"]);

const warning = (message: string): ReadonlyArray<PendingRuntimeEvent> => {
  const text = message.trim();
  return text === "" ? [] : [{ type: "session.warning", payload: { message: text } }];
};

/** What an `api_retry` says: why the request failed, and when it goes again. */
const retryText = (message: Json): string => {
  const error = asString(message.error) ?? "unknown";
  const status = asNumber(message.error_status);
  const delay = asNumber(message.retry_delay_ms);
  const attempt = asNumber(message.attempt);
  const max = asNumber(message.max_retries);
  const why = status === undefined ? error : `${error}, HTTP ${status}`;
  const when = delay === undefined ? "" : ` in ${Math.max(0, Math.round(delay / 1000))}s`;
  const which = attempt === undefined || max === undefined ? "" : `, attempt ${attempt} of ${max}`;
  return `Claude Code request failed (${why}); retrying${when}${which}.`;
};

/** What a refusal says: the CLI's own line, or what happened when it gave none. */
const refusalText = (message: Json): string => {
  const said = asString(message.content)?.trim() ?? "";
  if (said !== "") return said;
  const fallback = asString(message.fallback_model);
  return fallback === undefined
    ? "The model declined this request."
    : `The model declined this request; ${fallback} answered it instead.`;
};

/** What a usage-limit status says, or undefined for one within the limit. */
const rateLimitText = (info: Json): string | undefined => {
  const status = asString(info.status);
  const kind = asString(info.rateLimitType)?.replaceAll("_", " ");
  const limit = kind === undefined ? "usage limit" : `${kind} usage limit`;
  const resetsAt = asNumber(info.resetsAt);
  const resets =
    resetsAt === undefined ? "" : `; it resets at ${new Date(resetsAt * 1000).toISOString()}`;
  if (status === "rejected") return `Claude reached its ${limit}${resets}.`;
  if (status === "allowed_warning") {
    const used = asNumber(info.utilization);
    const share = used === undefined ? "" : ` (${Math.floor(used * 100)}% used)`;
    return `Claude is close to its ${limit}${share}${resets}.`;
  }
  return undefined;
};

export interface Notices {
  /**
   * A message this reads: its events, often none. Undefined for one it does
   * not know, which the translator keeps unmapped.
   */
  readonly read: (message: Json) => ReadonlyArray<PendingRuntimeEvent> | undefined;
}

export const makeNotices = (): Notices => {
  /** The usage-limit status last said, so a repeat says nothing. */
  let rateLimit: string | undefined;

  const system = (message: Json): ReadonlyArray<PendingRuntimeEvent> | undefined => {
    const subtype = asString(message.subtype) ?? "";
    switch (subtype) {
      case "api_retry":
        return warning(retryText(message));
      case "model_refusal_fallback":
      case "model_refusal_no_fallback":
        return warning(refusalText(message));
      case "informational":
        return SHOWN_LEVELS.has(asString(message.level) ?? "")
          ? warning(asString(message.content) ?? "")
          : [];
      case "notification":
        return SHOWN_PRIORITIES.has(asString(message.priority) ?? "")
          ? warning(asString(message.text) ?? "")
          : [];
      case "local_command_output": {
        const text = asString(message.content)?.trim() ?? "";
        if (text === "") return [];
        const itemId = makeItemId();
        return [
          {
            itemId,
            type: "item.completed",
            payload: { item: { itemId, kind: "assistant_message", status: "completed", text } },
          },
        ];
      }
      default:
        return Object.hasOwn(IGNORED_SYSTEM, subtype) ? [] : undefined;
    }
  };

  const rateLimitEvent = (message: Json): ReadonlyArray<PendingRuntimeEvent> => {
    const info = asRecord(message.rate_limit_info);
    const status = asString(info.status);
    if (status === rateLimit) return [];
    rateLimit = status;
    const text = rateLimitText(info);
    return text === undefined ? [] : warning(text);
  };

  return {
    read: (message) => {
      const type = asString(message.type) ?? "";
      if (type === "system") return system(message);
      if (type === "rate_limit_event") return rateLimitEvent(message);
      return Object.hasOwn(IGNORED_TYPES, type) ? [] : undefined;
    },
  };
};
