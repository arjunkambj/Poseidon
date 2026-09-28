/**
 * One piece of text written by Claude Code outside any session: a commit
 * message, a pull request's title and body, a thread title.
 *
 * One SDK `query()` with a string prompt, and options that make it a single
 * answer and nothing else:
 *
 * - `maxTurns: 1` and `persistSession: false` — one answer, no transcript;
 * - `settingSources: []` — none of the user's settings, hooks, CLAUDE.md or
 *   plugins is loaded;
 * - `tools: []`, `allowedTools: []`, no MCP servers under `strictMcpConfig`,
 *   and a `canUseTool` that denies whatever still asks — nothing can be read,
 *   written or run;
 * - the given model (`default` leaves it to the CLI) and effort, and `system`
 *   as the whole system prompt when there is one.
 *
 * It runs in a directory of its own under the system temp directory, removed
 * afterwards, through a process group of its own (`spawn.ts`) with the
 * default-deny environment (`env.ts`). The answer is the `result` message's
 * text. A result that is an error — including a `success` with `is_error`,
 * which is how the CLI says "Not logged in · Please run /login"
 * (`fixtures/claude/generate-text-signed-out/`) — fails with
 * `GenerationFailed` carrying the CLI's own words.
 *
 * `jsonSchema` is not sent. The SDK's `outputFormat` exists, but the CLI
 * delivers it as a `StructuredOutput` tool call that ends the turn, which is
 * exactly what `tools: []` and a deny-all `canUseTool` refuse; no signed-in
 * recording yet shows which wins. The caller parses the text either way.
 */

import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  query,
  type CanUseTool,
  type Options,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  GenerationFailed,
  SpawnFailed,
  type ConnectorError,
  type GenerateTextInput,
} from "@poseidon/connector-sdk/definition";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import * as Effect from "effect/Effect";

import type { ResolvedBinary } from "./binary";
import { CLAUDE_KIND } from "./kind";
import { sdkModelFor } from "./models";
import { sdkEffortFor } from "./queryOptions";
import { makeProcessGroup, type ProcessGroup } from "./spawn";

/** How much of the CLI's stderr a failure carries, from the end. */
const STDERR_TAIL_CHARS = 600;

/** Whatever still asks to use a tool is refused: the call is read-only. */
const denyAll: CanUseTool = async () => ({
  behavior: "deny",
  message: "This call only writes text; no tool may run.",
});

export interface GenerateTextOptionsInput {
  readonly binaryPath: string;
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly abortController: AbortController;
  readonly spawn: ProcessGroup["spawn"];
  readonly request: GenerateTextInput;
}

/** The SDK options of one one-shot call. */
export const generateTextOptions = (input: GenerateTextOptionsInput): Options => {
  const model = sdkModelFor(input.request.model);
  const effort = sdkEffortFor(input.request.effort);
  const system = input.request.system;
  return {
    pathToClaudeCodeExecutable: input.binaryPath,
    env: input.env,
    cwd: input.cwd,
    spawnClaudeCodeProcess: input.spawn,
    abortController: input.abortController,
    maxTurns: 1,
    persistSession: false,
    settingSources: [],
    tools: [],
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    canUseTool: denyAll,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(system === undefined || system.trim() === "" ? {} : { systemPrompt: system }),
  };
};

/** The result's text, or why there is none. */
export const answerOf = (
  result: SDKResultMessage | null,
): { readonly text: string } | { readonly failure: string } => {
  if (result === null) return { failure: "claude ended without a result" };
  if (result.subtype !== "success") {
    const said = result.errors.join("; ").trim();
    return { failure: `claude stopped with ${result.subtype}${said === "" ? "" : `: ${said}`}` };
  }
  const text = result.result.trim();
  if (result.is_error) return { failure: text === "" ? "claude answered with an error" : text };
  return text === "" ? { failure: "claude answered with no text" } : { text: result.result };
};

const tailOf = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= STDERR_TAIL_CHARS ? trimmed : `…${trimmed.slice(-STDERR_TAIL_CHARS)}`;
};

export interface ClaudeGenerateTextOptions {
  readonly instanceId: ConnectorInstanceId;
  /** The binary and environment, read fresh per call as a session start does. */
  readonly launch: Effect.Effect<{
    readonly binary: ResolvedBinary | null;
    readonly env: Record<string, string>;
  }>;
}

/** The instance's `generateText`. */
export const makeClaudeGenerateText =
  (options: ClaudeGenerateTextOptions) =>
  (request: GenerateTextInput): Effect.Effect<string, ConnectorError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const fail = (message: string) =>
          new GenerationFailed({ kind: CLAUDE_KIND, instanceId: options.instanceId, message });
        const spawnFailed = (message: string) =>
          new SpawnFailed({ kind: CLAUDE_KIND, instanceId: options.instanceId, message });
        const { binary, env } = yield* options.launch;
        if (binary === null) {
          return yield* spawnFailed("claude not found on PATH or in the usual install directories");
        }
        const cwd = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "poseidon-generate-")),
            catch: (cause) => spawnFailed(String(cause)),
          }),
          (dir) => Effect.promise(() => NodeFS.rm(dir, { recursive: true, force: true })),
        );
        const group = makeProcessGroup();
        const abortController = new AbortController();
        // Registered after the directory, so it runs first: the process group
        // is gone before its working directory is removed.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            abortController.abort();
            yield* group.stop;
          }),
        );
        const result = yield* Effect.tryPromise({
          try: async () => {
            const session = query({
              prompt: request.prompt,
              options: generateTextOptions({
                binaryPath: binary.command,
                env,
                cwd,
                abortController,
                spawn: group.spawn,
                request,
              }),
            });
            for await (const message of session) {
              if (message.type === "result") return message;
            }
            return null;
          },
          catch: (cause) => {
            const stderr = tailOf(group.latest()?.stderrTail() ?? "");
            const said = cause instanceof Error ? cause.message : String(cause);
            return fail(stderr === "" ? said : `${said}: ${stderr}`);
          },
        });
        const answer = answerOf(result);
        return "text" in answer ? answer.text : yield* fail(answer.failure);
      }),
    );
