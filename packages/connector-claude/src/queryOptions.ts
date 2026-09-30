/**
 * The SDK options one session's `query()` is started with.
 *
 * - The CLI is the user's own binary (`pathToClaudeCodeExecutable`), started
 *   through `spawn.ts` in a process group of its own, with the default-deny
 *   environment of `env.ts`.
 * - The session loads the user's harness as the CLI would —
 *   `settingSources` user, project and local, so their CLAUDE.md, skills, MCP
 *   servers and hooks all apply — under the CLI's own system prompt.
 * - Poseidon's MCP server is added as `poseidon`, over HTTP to the per-thread
 *   endpoint with its bearer. The SDK hands the CLI its MCP config on the
 *   command line, so the bearer is visible to `ps` on this machine for the
 *   session's life; it is minted per session and revoked with it.
 * - Poseidon's enabled plugins load as local plugins, their MCP servers
 *   beside `poseidon` (`pluginOptions.ts`). With none enabled the options are
 *   exactly what they were before plugins existed.
 * - Every tool call is gated (`toolGate.ts`).
 * - The thread's attachments directory is readable, so a file the user
 *   attached can be read by path.
 * - A thread with ultracode on starts the session with it on
 *   (`ultracodeLaunchOptions`).
 */

import * as NodePath from "node:path";
import type {
  CanUseTool,
  EffortLevel,
  HookCallback,
  Options,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import type { ConnectorEndpoint } from "@poseidon/connector-sdk/definition";
import type { Effort } from "@poseidon/contracts/enums";
import type { ThreadId } from "@poseidon/contracts/ids";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import type { SessionPlugin } from "@poseidon/connector-sdk/plugins";

import { sdkModelFor } from "./models";
import { pluginMcpServersFor, sdkPluginsFor } from "./pluginOptions";
import type { ClaudeSpawnOptions, ClaudeSpawnedProcess } from "./spawn";
import type { ToolGate } from "./toolGate";

/** The name Poseidon's MCP server is registered under in the session. */
const POSEIDON_MCP_SERVER = "poseidon";

/**
 * The CLI permission mode for a thread's modes. A plan turn runs in `plan`;
 * otherwise ask, auto-accept edits and full access are the CLI's `default`,
 * `acceptEdits` and `bypassPermissions`. Whichever it is, the PreToolUse hook
 * still puts every call past Poseidon's ladder first, and the ladder reads the
 * thread's own modes, not the CLI's.
 *
 * Full access can be the CLI's `bypassPermissions` because that mode does not
 * reach a hook's `ask`: the CLI hands a call the hook asked about to
 * `canUseTool` with that decision already made, and checks no mode on the way
 * (CLI 2.1.280, read from the permission code bundled in the binary). So a
 * sensitive path under full access — the ladder's "prompt" — still opens a
 * card, as the signed-in `fixtures/claude/sensitive-full-access/` (CLI
 * 2.1.286) records.
 */
export const permissionModeFor = (settings: ThreadSettings): PermissionMode => {
  if (settings.interactionMode === "plan") return "plan";
  switch (settings.runtimeMode) {
    case "approval-required":
      return "default";
    case "auto-accept-edits":
      return "acceptEdits";
    case "full-access":
      return "bypassPermissions";
  }
};

/**
 * The SDK's effort for ours. `minimal` and `ultra` have no rung in the CLI's
 * `EffortLevel` and are left out, so the CLI default applies: `ultra` is
 * Codex's multi-agent rung, and Claude Code's nearest mode (ultracode) is a
 * session setting of its own, not an effort.
 */
export const sdkEffortFor = (effort: Effort | undefined): EffortLevel | undefined =>
  effort === undefined || effort === "minimal" || effort === "ultra" ? undefined : effort;

/**
 * The effort ultracode runs at. The CLI leaves the effort where it was when
 * the flag goes on (live check, CLI 2.1.286), so a launch and a switch name it.
 */
export const ULTRACODE_EFFORT = "xhigh" satisfies EffortLevel;

/**
 * What a thread with ultracode on adds to the launch: the SDK's inline
 * `settings` — the `--settings` flag layer, where the SDK documents
 * `Settings.ultracode` is provided — and the effort ultracode runs at,
 * whatever the thread's own effort says. The CLI reads `ultracode` from its
 * merged settings at start but does not raise the effort for it — the flag
 * alone ran at the default, medium (live check, CLI 2.1.286) — so the
 * explicit effort is what puts the mode at xhigh. Off adds nothing, so the
 * launch is exactly what it was before ultracode existed.
 */
export const ultracodeLaunchOptions = (
  settings: ThreadSettings,
): Pick<Options, "settings" | "effort"> =>
  settings.ultracode === true ? { settings: { ultracode: true }, effort: ULTRACODE_EFFORT } : {};

/** The directory a thread's attachments are staged under. */
export const attachmentsDirFor = (attachmentsDir: string, threadId: ThreadId): string =>
  NodePath.join(NodePath.resolve(attachmentsDir), threadId);

/** Limits only a recording sets, so a live run cannot spend beyond them. */
export interface SessionLimits {
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
}

export interface QueryOptionsInput {
  readonly binaryPath: string;
  readonly env: Record<string, string>;
  readonly cwd: string;
  /** A fresh session's id, minted by us. */
  readonly sessionId?: string;
  /** The session to resume instead. */
  readonly resume?: string;
  readonly settings: ThreadSettings;
  readonly mcp: ConnectorEndpoint;
  readonly attachmentsDir: string;
  readonly abortController: AbortController;
  readonly spawn: (options: ClaudeSpawnOptions) => ClaudeSpawnedProcess;
  readonly gate: ToolGate;
  readonly limits?: SessionLimits;
  /** The Poseidon plugins the session loads; absent or empty adds nothing. */
  readonly plugins?: ReadonlyArray<SessionPlugin>;
}

export const buildQueryOptions = (input: QueryOptionsInput): Options => {
  const model = sdkModelFor(input.settings.model);
  const effort = sdkEffortFor(input.settings.effort);
  const preToolUse: HookCallback = (hookInput) => input.gate.preToolUse(hookInput);
  const canUseTool: CanUseTool = (toolName, toolInput, options) =>
    input.gate.canUseTool(toolName, toolInput, options);
  const plugins = input.plugins ?? [];
  return {
    pathToClaudeCodeExecutable: input.binaryPath,
    env: input.env,
    cwd: input.cwd,
    spawnClaudeCodeProcess: input.spawn,
    abortController: input.abortController,
    ...(input.resume === undefined ? {} : { resume: input.resume }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    includePartialMessages: true,
    // A subagent's text and thinking too, not only its tool calls, so its
    // task row holds the whole of what it did (`translate/subagents.ts`).
    forwardSubagentText: true,
    permissionMode: permissionModeFor(input.settings),
    // The SDK requires it before `bypassPermissions` — full access — can be
    // used, whether at start or by a switch mid-session. The hook still gates
    // every call in that mode, and its "ask" still reaches `canUseTool`.
    allowDangerouslySkipPermissions: true,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...ultracodeLaunchOptions(input.settings),
    ...(plugins.length === 0 ? {} : { plugins: sdkPluginsFor(plugins) }),
    mcpServers: {
      ...pluginMcpServersFor(plugins),
      [POSEIDON_MCP_SERVER]: {
        type: "http",
        url: input.mcp.url,
        headers: { Authorization: `Bearer ${input.mcp.bearer}` },
      },
    },
    additionalDirectories: [input.attachmentsDir],
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
    canUseTool,
    ...(input.limits?.maxTurns === undefined ? {} : { maxTurns: input.limits.maxTurns }),
    ...(input.limits?.maxBudgetUsd === undefined
      ? {}
      : { maxBudgetUsd: input.limits.maxBudgetUsd }),
  };
};
