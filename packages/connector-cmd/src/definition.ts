/**
 * The Command Code connector definition: probe, instance creation, session
 * start/resume, and the skills and MCP server extensions. Everything else —
 * spawn, frames, transcript, translation — lives in the sibling modules this
 * wires together. Sessions come back raw; the engine's SessionManager adds the
 * turn-scoped wrapper.
 */
import { homedir } from "node:os";
import * as NodePath from "node:path";
import type { ConnectorDefinition, StartSessionInput } from "@poseidon/connector-sdk/definition";
import { SpawnFailed } from "@poseidon/connector-sdk/definition";
import type { ConnectorExtensions } from "@poseidon/connector-sdk/extensions";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import { resolveForSession } from "./binary";
import { CmdConnectorConfig } from "./configSchema";
import { makeCmdMcpServers } from "./mcpServers";
import { makeCmdSkills } from "./skills";
import { probe as probeBinary } from "./probe";
import { CMD_CAPABILITIES } from "./capabilities";
import { makeCmdGenerateText } from "./generateText";
import { makeCmdSession, type CmdSessionRef } from "./session";

export const CMD_KIND = "cmd";

const asSessionRef = (ref: unknown): CmdSessionRef | undefined => {
  if (typeof ref !== "object" || ref === null) return undefined;
  const record = ref as {
    sessionId?: unknown;
    transcriptPath?: unknown;
    cwd?: unknown;
    lastMessageId?: unknown;
  };
  if (
    typeof record.sessionId !== "string" ||
    typeof record.transcriptPath !== "string" ||
    typeof record.cwd !== "string"
  ) {
    return undefined;
  }
  // Older persisted refs predate the marker — missing is the same as null.
  const lastMessageId = typeof record.lastMessageId === "string" ? record.lastMessageId : null;
  return {
    sessionId: record.sessionId,
    transcriptPath: record.transcriptPath,
    cwd: record.cwd,
    lastMessageId,
  };
};

export interface CmdConnectorOptions {
  /**
   * Command Code's home directory, where its user `mcp.json` and `skills` live.
   * Omitted, it is `~/.commandcode` under the instance's `extraEnv.HOME` when
   * that is set — the home the CLI itself resolves — else under the user's.
   * Tests pass a temporary directory so no real config is touched.
   */
  readonly commandCodeHome?: string;
  /** The shared agents skills folder; `~/.agents/skills` by the same rule. */
  readonly agentsSkillsRoot?: string;
}

/**
 * The skills and MCP server extensions for one instance. `writeMutex` is the
 * definition's, so instances that share a home never interleave a
 * read-modify-write of the same file.
 */
const cmdExtensions = (
  options: CmdConnectorOptions,
  config: CmdConnectorConfig,
  writeMutex: Semaphore.Semaphore,
): ConnectorExtensions => {
  const userHome = config.extraEnv?.HOME ?? homedir();
  const home = options.commandCodeHome ?? NodePath.join(userHome, ".commandcode");
  const agentsSkillsRoot = options.agentsSkillsRoot ?? NodePath.join(userHome, ".agents", "skills");
  return {
    skills: makeCmdSkills({ home, agentsSkillsRoot, writeMutex }),
    mcpServers: makeCmdMcpServers({ home, writeMutex }),
  };
};

export const makeCmdConnectorDefinition = (
  options: CmdConnectorOptions,
): ConnectorDefinition<CmdConnectorConfig> => {
  const writeMutex = Semaphore.makeUnsafe(1);
  return {
    kind: CMD_KIND,
    metadata: {
      displayName: "Command Code",
      iconKey: "terminal",
      accent: "#6e56cf",
      // The docs root the CLI's own `--help` points at (fixtures/cmd/probe/help.stdout.txt).
      docsUrl: "https://commandcode.ai/docs",
    },
    configSchema: CmdConnectorConfig,
    defaultConfig: () => ({}),
    probe: (config) => probeBinary(config),
    createInstance: ({ instanceId, config, services }) => {
      const spawnSession = (input: StartSessionInput, sessionRef?: CmdSessionRef, fork = false) =>
        makeCmdSession({
          instanceId,
          threadId: input.threadId,
          workspaceRoot: input.workspaceRoot,
          ...(config.binaryPath === undefined ? {} : { binaryPath: config.binaryPath }),
          // The same resolution the probe reports, carried into the spawn instead
          // of discarded: the server's own PATH is not where `cmd` necessarily
          // is, and the npx fallback is not a binary at all (`binary.ts`).
          // Resolved per session start, so an install that appears later is found.
          binary: resolveForSession(config, process.env),
          ...(config.extraEnv === undefined ? {} : { extraEnv: config.extraEnv }),
          // The child resolves `~/.commandcode` against its own HOME,
          // and extraEnv is what sets that HOME. Without this the tailer watches
          // the server's home instead and the timeline loses every streaming
          // item until the run_end reconcile.
          ...(config.extraEnv?.HOME === undefined ? {} : { home: config.extraEnv.HOME }),
          services,
          settings: input.settings,
          ...(sessionRef === undefined ? {} : { sessionRef }),
          ...(fork ? { fork } : {}),
        });
      return Effect.succeed({
        instanceId,
        kind: CMD_KIND,
        capabilities: CMD_CAPABILITIES,
        startSession: (input) => spawnSession(input),
        resumeSession: (input) => {
          const ref = asSessionRef(input.sessionRef);
          // A ref too old to read can be resumed as a fresh start, but a fork
          // of it would quietly carry nothing over: refuse, so the server
          // sends the conversation as text instead.
          return input.fork === true && ref === undefined
            ? Effect.fail(
                new SpawnFailed({
                  kind: CMD_KIND,
                  instanceId,
                  message: "the session to fork is not a Command Code session reference",
                }),
              )
            : spawnSession(input, ref, input.fork === true);
        },
        listModels: () =>
          probeBinary(config).pipe(
            Effect.map((probe) => probe.models),
            Effect.mapError(
              (error) =>
                new SpawnFailed({
                  kind: CMD_KIND,
                  instanceId,
                  message: error.message,
                }),
            ),
          ),
        extensions: cmdExtensions(options, config, writeMutex),
        generateText: makeCmdGenerateText({
          instanceId,
          binary: () => resolveForSession(config, process.env),
          ...(config.extraEnv === undefined ? {} : { extraEnv: config.extraEnv }),
        }),
      });
    },
  };
};

/** The definition with every default — what production registers. */
export const cmdConnectorDefinition = makeCmdConnectorDefinition({});
