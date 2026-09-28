/**
 * The closed vocabularies of the product.
 *
 * Everything here is a literal union because the renderer switches on it: a new
 * member is a deliberate, reviewed change to the UI, not something a connector
 * may invent. Open vocabularies (connector kinds, model ids, tool names) live
 * elsewhere as plain strings.
 */

import * as Schema from "effect/Schema";

/**
 * How much a turn may do without asking.
 *
 * - `approval-required` prompts for everything that mutates or reaches out.
 * - `auto-accept-edits` allows edits and writes inside the project, still
 *   prompting for shell and web.
 * - `full-access` allows everything except sensitive paths and deny rules.
 */
export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;

/**
 * New threads start here, and so does every connector session whose mode the
 * user has not chosen. Asking first is the safe default and the one the
 * settings document is seeded with.
 */
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "approval-required";

/** Whether a turn executes or only proposes a plan. */
export const InteractionMode = Schema.Literals(["default", "plan"]);
export type InteractionMode = typeof InteractionMode.Type;

/**
 * The canonical reasoning-effort ladder, lowest rung first. Every harness's
 * effort names map onto these, and the effort picker orders by this list
 * whatever order a connector reports its rungs in.
 *
 * `ultra` sits past `max`: it is Codex's rung for maximum reasoning with
 * automatic task delegation (proactive multi-agent work), offered only on the
 * models whose `model/list` row advertises it. It spends many more tokens, and
 * a harness without it never receives it — its connector leaves the effort to
 * the CLI default instead.
 */
export const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/**
 * Reasoning effort. The ladder is per model: `ModelOption.efforts` lists the
 * rungs a given model accepts, so this union is the superset, not a promise.
 * It only ever grows — a stored thread's effort must keep decoding.
 */
export const Effort = Schema.Literals(EFFORT_ORDER);
export type Effort = typeof Effort.Type;

/**
 * What one timeline row is. These names are Command Code's tool vocabulary
 * normalised: every connector maps its own tool names onto them, and
 * the renderer has one row component per member.
 */
export const ItemKind = Schema.Literals([
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
export type ItemKind = typeof ItemKind.Type;

/** What an approval request is asking permission to do. */
export const ApprovalKind = Schema.Literals([
  "command",
  "file_write",
  "file_read",
  "mcp_tool",
  "web",
  "other",
]);
export type ApprovalKind = typeof ApprovalKind.Type;

/**
 * The four answers an approval card offers. `allow-always` is the only one that
 * writes a persistent permission rule.
 */
export const ApprovalDecision = Schema.Literals([
  "allow-once",
  "allow-session",
  "allow-always",
  "deny",
]);
export type ApprovalDecision = typeof ApprovalDecision.Type;
