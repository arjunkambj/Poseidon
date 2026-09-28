/**
 * Every tool call a Claude Code session makes goes past Poseidon's permission
 * ladder first. This is where that is wired into the SDK.
 *
 * The SDK offers two ways in, and neither is enough alone:
 *
 * - `canUseTool` is only asked when the CLI itself would prompt. Calls its own
 *   rules already allow — reads, the user's `~/.claude` allow list, anything
 *   under `bypassPermissions` — never reach it, so a ladder that says "ask"
 *   for one of those would be skipped: the rule that "ask" outranks "allow"
 *   would not hold.
 * - A `PreToolUse` hook runs for every call, in every permission mode.
 *
 * So the hook asks the ladder for every call and answers with its verdict:
 * `allow`, `deny`, or — when the ladder says "prompt" — `ask`. The CLI hands a
 * hook's `ask` to `canUseTool` with the decision already made, in every
 * permission mode, `bypassPermissions` included: its own mode and allow rules
 * are not consulted again. `canUseTool` runs the shared approval gate, which
 * asks the ladder again (the same answer) and opens the card. The hook never
 * waits for the user, so no hook timeout can ever decide a call — and a hook
 * that times out is a call the CLI does not run.
 *
 * Two tools pass the hook with no verdict: AskUserQuestion and ExitPlanMode.
 * They are how the model talks to the user rather than acts on the machine,
 * and the ladder, which refuses every non-read in a plan turn, would refuse
 * the very call that hands the plan over. `canUseTool` answers both itself,
 * through the question and plan cards (`interactions.ts`). In a plan turn the
 * write of the CLI's own plan file passes too, and the CLI's plan mode
 * decides it (`plans.ts`).
 *
 * The CLI's no-permission tools pass the hook with no verdict as well
 * (`NO_PERMISSION_TOOLS` in `approvals.ts`): delegating to a subagent,
 * keeping the checklist, loading deferred tools. The ladder reads each as
 * `other`, which would open a card in the ask modes and refuse it in every
 * plan turn, for calls that neither act on the machine nor ask the CLI for
 * permission. A subagent's own calls still reach the hook and are gated one
 * by one. Should `canUseTool` ever be asked about one, it allows it.
 *
 * Both fail closed. A hook that cannot reach a verdict answers `ask`, and a
 * `canUseTool` that cannot answers `deny`; a missing verdict never reads as
 * allow.
 *
 * The card's answers read to the CLI as:
 *
 * - allow once, allow always → allow, with the input unchanged. "Always" is
 *   Poseidon's rule, which the server has already saved; nothing is written to
 *   the CLI's own settings files.
 * - allow for the session → allow, plus the CLI's own suggested rules for the
 *   call, every one of them kept to the `session` destination, so the CLI does
 *   not ask about the same call again this session. The hook still asks the
 *   ladder first, and the server keeps the session rule that makes it answer
 *   allow. Suggestions that would change the CLI's permission mode are left
 *   out: the thread's mode is Poseidon's to set.
 * - deny → deny, with a line for the model saying who refused.
 *
 * A call the CLI withdraws while its card is open — the turn was interrupted
 * — aborts `canUseTool`'s signal, and the gate answers the card `deny`.
 */

import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalGate } from "@poseidon/connector-sdk/approvalGate";
import type { ConnectorPermissions, PermissionDecision } from "@poseidon/connector-sdk/definition";
import type { ThreadId } from "@poseidon/contracts/ids";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import * as Effect from "effect/Effect";

import {
  approvalRequestFor,
  ASK_USER_QUESTION,
  EXIT_PLAN_MODE,
  NO_PERMISSION_TOOLS,
} from "./approvals";
import type { Interactions } from "./interactions";
import { isPlanFileWrite } from "./plans";

/** The PreToolUse output this sends back, in the SDK's shape. */
export interface PreToolUseOutput {
  readonly hookSpecificOutput?: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: "allow" | "deny" | "ask";
    readonly permissionDecisionReason?: string;
  };
}

/** `canUseTool`'s answer, in the SDK's shape. */
export type ToolPermission =
  | {
      readonly behavior: "allow";
      readonly updatedInput: Record<string, unknown>;
      readonly updatedPermissions?: Array<PermissionUpdate>;
    }
  | { readonly behavior: "deny"; readonly message: string };

/** The tools the hook lets past with no verdict — see the header. */
const UNGATED_BY_HOOK = new Set([ASK_USER_QUESTION, EXIT_PLAN_MODE]);

/** What the model is told when Poseidon's rules refuse a call. */
export const DENIED_BY_RULES = "Denied by the user's permission rules in Poseidon.";
/** What the model is told when the user refuses a call. */
export const DENIED_BY_USER = "The user denied this tool call.";

/**
 * The CLI's suggestions, kept to this session: rules and directories only,
 * never a mode change, and never a settings file.
 */
export const sessionPermissions = (
  suggestions: ReadonlyArray<PermissionUpdate> | undefined,
): Array<PermissionUpdate> =>
  (suggestions ?? []).flatMap((update): Array<PermissionUpdate> => {
    switch (update.type) {
      case "addRules":
        return update.behavior === "allow" ? [{ ...update, destination: "session" }] : [];
      case "addDirectories":
        return [{ ...update, destination: "session" }];
      default:
        return [];
    }
  });

export interface ToolGate {
  readonly preToolUse: (input: unknown) => Promise<PreToolUseOutput>;
  readonly canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      readonly signal: AbortSignal;
      readonly suggestions?: ReadonlyArray<PermissionUpdate>;
      readonly toolUseID?: string;
    },
  ) => Promise<ToolPermission>;
  /**
   * How many tool calls have reached the gate so far, by either door — for
   * the session's check that no call ran without it.
   */
  readonly sightings: () => number;
}

export const makeToolGate = (options: {
  readonly threadId: ThreadId;
  readonly permissions: ConnectorPermissions;
  readonly gate: ApprovalGate;
  /** The thread's settings as they are now — read per call, never captured. */
  readonly settings: () => ThreadSettings;
  /** Runs an effect from the SDK's promise callbacks, in the session's context. */
  readonly run: <A>(effect: Effect.Effect<A>) => Promise<A>;
  /** The question and plan cards AskUserQuestion and ExitPlanMode open. */
  readonly interactions: Interactions;
  /** The CLI's plans directory, whose plan file a plan turn may write. */
  readonly plansDir: string;
}): ToolGate => {
  const modes = () => {
    const settings = options.settings();
    return { runtimeMode: settings.runtimeMode, interactionMode: settings.interactionMode };
  };

  let sightings = 0;

  const preToolUse = async (input: unknown): Promise<PreToolUseOutput> => {
    const record = (typeof input === "object" && input !== null ? input : {}) as {
      readonly hook_event_name?: unknown;
      readonly tool_name?: unknown;
      readonly tool_input?: unknown;
      readonly permission_mode?: unknown;
    };
    if (record.hook_event_name !== "PreToolUse") return {};
    sightings += 1;
    const toolName = typeof record.tool_name === "string" ? record.tool_name : "";
    if (UNGATED_BY_HOOK.has(toolName) || NO_PERMISSION_TOOLS.has(toolName)) return {};
    const planning =
      options.settings().interactionMode === "plan" || record.permission_mode === "plan";
    if (planning && isPlanFileWrite(toolName, record.tool_input, options.plansDir)) return {};
    const verdict = await options
      .run(
        options.permissions
          .decide({
            request: approvalRequestFor(toolName, record.tool_input),
            threadId: options.threadId,
            ...modes(),
          })
          .pipe(Effect.catchDefect(() => Effect.succeed<PermissionDecision>("prompt"))),
      )
      .catch((): PermissionDecision => "prompt");
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: verdict === "allow" ? "allow" : verdict === "deny" ? "deny" : "ask",
        ...(verdict === "deny" ? { permissionDecisionReason: DENIED_BY_RULES } : {}),
      },
    };
  };

  const canUseTool: ToolGate["canUseTool"] = async (
    toolName,
    input,
    { signal, suggestions, toolUseID },
  ) => {
    sightings += 1;
    if (signal.aborted) return { behavior: "deny", message: DENIED_BY_USER };
    try {
      if (toolName === ASK_USER_QUESTION) {
        return await options.run(options.interactions.ask(input, signal));
      }
      if (toolName === EXIT_PLAN_MODE) {
        return await options.run(options.interactions.proposePlan(input, toolUseID));
      }
      if (NO_PERMISSION_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input };
      const verdict = await options.run(
        options.gate.decide({
          request: approvalRequestFor(toolName, input),
          threadId: options.threadId,
          ...modes(),
          signal,
        }),
      );
      if (verdict.allowed) {
        const updatedPermissions =
          verdict.decision === "allow-session" ? sessionPermissions(suggestions) : [];
        return updatedPermissions.length === 0
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "allow", updatedInput: input, updatedPermissions };
      }
      return {
        behavior: "deny",
        message: verdict.via === "user" ? DENIED_BY_USER : DENIED_BY_RULES,
      };
    } catch {
      return { behavior: "deny", message: DENIED_BY_RULES };
    }
  };

  return { preToolUse, canUseTool, sightings: () => sightings };
};
