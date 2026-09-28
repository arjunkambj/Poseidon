/**
 * The Codex connector definition: probe, instance creation, session start and
 * resume, and the skills and MCP server extensions. Everything else — the binary, the environment, the JSON-RPC
 * client, the handshake, the translation — lives in the sibling modules this
 * wires together. Sessions come back raw; the engine's SessionManager adds
 * the turn-scoped wrapper.
 */

import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { ConnectorDefinition, StartSessionInput } from "@poseidon/connector-sdk/definition";
import { SpawnFailed } from "@poseidon/connector-sdk/definition";
import type { ConnectorExtensions } from "@poseidon/connector-sdk/extensions";
import type { ModelOption } from "@poseidon/contracts/connectors";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { resolveBinary, terminalCommand } from "./binary";
import { CODEX_CAPABILITIES } from "./capabilities";
import { CodexConnectorConfig } from "./configSchema";
import { childEnv, expandHome } from "./env";
import { makeCodexMcpServers } from "./extensions/mcpServers";
import { makeCodexSkills } from "./extensions/skills";
import { CODEX_KIND } from "./kind";
import type { CodexModelFacts } from "./models";
import { LOGIN_ARGS, NOT_FOUND, probe as probeBinary, readHandshake } from "./probe";
import { makeCodexSession } from "./session";
import { parseSessionRef, type CodexSessionRef } from "./sessionRef";

/** What a thread is told when its stored reference is not one this connector made. */
export const UNREADABLE_REF_WARNING =
  "The previous Codex session could not be read back, so this thread starts a new one.";

export interface CodexConnectorOptions {
  /**
   * The `CODEX_HOME` the extensions read and write — the skills root, the
   * `codex mcp` commands and Poseidon's MCP ledger. Omitted, it is the
   * instance's own `codexHome`, else `~/.codex`. Sessions are unaffected.
   * Tests pass a temporary directory so no real config is touched.
   */
  readonly codexHome?: string;
  /** The shared agents skills folder; `~/.agents/skills` when omitted. */
  readonly agentsSkillsRoot?: string;
}

/**
 * The skills and MCP server extensions for one instance. `writeMutex` is the
 * definition's, so instances that share a `CODEX_HOME` never interleave two
 * `codex mcp add` runs and their ledger writes.
 */
const codexExtensions = (
  options: CodexConnectorOptions,
  config: CodexConnectorConfig,
  writeMutex: Semaphore.Semaphore,
): ConnectorExtensions => {
  const home = NodeOS.homedir();
  const codexHome =
    options.codexHome ??
    (config.codexHome === undefined
      ? NodePath.join(home, ".codex")
      : expandHome(config.codexHome, home));
  return {
    skills: makeCodexSkills({
      codexHome,
      agentsSkillsRoot: options.agentsSkillsRoot ?? NodePath.join(home, ".agents", "skills"),
    }),
    mcpServers: makeCodexMcpServers({
      binary: () => resolveBinary(config, process.env),
      // The same default-deny environment a session gets, with CODEX_HOME
      // named explicitly so the CLI edits the config the ledger sits beside.
      env: () => childEnv(process.env, { codexHome }),
      codexHome,
      writeMutex,
    }),
  };
};

export const makeCodexConnectorDefinition = (
  options: CodexConnectorOptions = {},
): ConnectorDefinition<CodexConnectorConfig> => {
  const writeMutex = Semaphore.makeUnsafe(1);
  return {
    kind: CODEX_KIND,
    metadata: {
      displayName: "Codex",
      iconKey: "terminal",
      accent: "#10a37f",
      // `codex --help` names no documentation link, so none is given.
    },
    configSchema: CodexConnectorConfig,
    defaultConfig: () => ({}),
    probe: (config) => probeBinary(config),
    createInstance: ({ instanceId, config, services }) =>
      Effect.gen(function* () {
        const failed = (message: string) =>
          new SpawnFailed({ kind: CODEX_KIND, instanceId, message });

        /**
         * Resolved per use, not per instance: an install that appears after the
         * instance opened is found, and the environment is read fresh.
         */
        const launch = Effect.sync(() => ({
          binary: resolveBinary(config, process.env),
          env: childEnv(process.env, config),
        }));

        /** One model list per instance: the handshake is a process start. */
        const models = yield* Ref.make<ReadonlyArray<ModelOption> | null>(null);
        /** Each listed model's efforts and default, read by a session choosing a turn's effort. */
        let facts: ReadonlyMap<string, CodexModelFacts> | null = null;
        const modelFacts = (model: string) => facts?.get(model);
        const listModels = () =>
          Effect.gen(function* () {
            const cached = yield* Ref.get(models);
            if (cached !== null) return cached;
            const { binary, env } = yield* launch;
            if (binary === null) return yield* failed(NOT_FOUND);
            const handshake = yield* readHandshake({ binary, env, cwd: NodeOS.tmpdir() }).pipe(
              Effect.mapError((error) => failed(error.message)),
            );
            yield* Ref.set(models, handshake.models);
            facts = handshake.modelFacts;
            return handshake.models;
          });

        const start = (input: StartSessionInput, sessionRef?: CodexSessionRef, warning?: string) =>
          Effect.gen(function* () {
            const { binary, env } = yield* launch;
            if (binary === null) return yield* failed(NOT_FOUND);
            return yield* makeCodexSession({
              instanceId,
              threadId: input.threadId,
              workspaceRoot: input.workspaceRoot,
              binary,
              env,
              loginCommand: terminalCommand(binary, LOGIN_ARGS, env.CODEX_HOME),
              services,
              settings: input.settings,
              modelFacts,
              ...(sessionRef === undefined ? {} : { sessionRef }),
              ...(warning === undefined ? {} : { warning }),
            });
          });

        return {
          instanceId,
          kind: CODEX_KIND,
          capabilities: CODEX_CAPABILITIES,
          startSession: (input) => start(input),
          // A thread the CLI no longer has is started afresh inside the session
          // (`threadOpen.ts`); a reference this connector cannot read is here.
          resumeSession: (input) => {
            const ref = parseSessionRef(input.sessionRef);
            return ref === undefined
              ? start(input, undefined, UNREADABLE_REF_WARNING)
              : start(input, ref);
          },
          listModels,
          extensions: codexExtensions(options, config, writeMutex),
        };
      }),
  };
};

/** The definition with every default — what production registers. */
export const codexConnectorDefinition = makeCodexConnectorDefinition();
