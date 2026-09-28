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
 * card. `fixtures/claude/sensitive-full-access/` is the recording that will
 * pin it once a signed-in CLI makes it; until then the code reading is all
 * that backs it.
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

/** The SDK's effort for ours; `minimal` has no rung in the CLI and is left out. */
export const sdkEffortFor = (effort: Effort | undefined): EffortLevel | undefined =>
  effort === undefined || effort === "minimal" ? undefined : effort;

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
