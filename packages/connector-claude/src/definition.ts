/**
 * The Claude Code connector definition: probe, instance creation, and session
 * start and resume. Everything else — the binary, the environment, the SDK
 * options, the translation — lives in the sibling modules this wires
 * together. Sessions come back raw; the engine's SessionManager adds the
 * turn-scoped wrapper.
 */

import * as NodeOS from "node:os";
import type {
  ConnectorDefinition,
  ConnectorError,
  StartSessionInput,
} from "@poseidon/connector-sdk/definition";
import { SpawnFailed } from "@poseidon/connector-sdk/definition";
import type { ModelOption } from "@poseidon/contracts/connectors";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { resolveBinary, terminalCommand, type ResolvedBinary } from "./binary";
import { CLAUDE_CAPABILITIES } from "./capabilities";
import { ClaudeConnectorConfig } from "./configSchema";
import { childEnv } from "./env";
import { CLAUDE_KIND } from "./kind";
import { LOGIN_ARGS, probe as probeBinary, readInitialization } from "./probe";
import type { SessionLimits } from "./queryOptions";
import { makeClaudeSession } from "./session";
import { parseSessionRef, type ClaudeSessionRef } from "./sessionRef";

/**
 * What the CLI says on stderr when `--resume` names a conversation it does not
 * have — "No conversation found with session ID: <id>" in 2.1.280 — which the
 * session carries into its failed handshake's message.
 */
const NO_CONVERSATION = /No conversation found/i;

/** What the thread is told when its conversation is gone and a new one starts. */
export const NO_CONVERSATION_WARNING =
  "Claude Code no longer has this thread's conversation, so it starts a new one.";

/** A resume the CLI refused because it no longer has the conversation. */
export const isMissingConversation = (error: ConnectorError): boolean =>
  error._tag === "SpawnFailed" && NO_CONVERSATION.test(error.message);

/**
 * The resumed session, or — when the CLI no longer has the conversation — a
 * fresh one that says why: the thread goes on in a new session rather than
 * not at all. Every other failure is the resume's own.
 */
export const resumeOrStartFresh = <A, R>(
  resumed: Effect.Effect<A, ConnectorError, R>,
  fresh: (warning: string) => Effect.Effect<A, ConnectorError, R>,
): Effect.Effect<A, ConnectorError, R> =>
  resumed.pipe(Effect.catchIf(isMissingConversation, () => fresh(NO_CONVERSATION_WARNING)));

export interface ClaudeConnectorOptions {
  /**
   * Caps a recording puts on every session, so a live run cannot spend beyond
   * them. Production passes none.
   */
  readonly limits?: SessionLimits;
}

export const makeClaudeConnectorDefinition = (
  options: ClaudeConnectorOptions = {},
): ConnectorDefinition<ClaudeConnectorConfig> => ({
  kind: CLAUDE_KIND,
  metadata: {
    displayName: "Claude Code",
    iconKey: "terminal",
    accent: "#d97757",
    // `claude --help` names no documentation link, so none is given.
  },
  configSchema: ClaudeConnectorConfig,
  defaultConfig: () => ({}),
  probe: (config) => probeBinary(config),
  createInstance: ({ instanceId, config, services }) =>
    Effect.gen(function* () {
      const failed = (message: string) =>
        new SpawnFailed({ kind: CLAUDE_KIND, instanceId, message });

      /**
       * Resolved per session start, not per instance: an install that appears
       * after the instance opened is found, and the environment is read fresh.
       */
      const launch = Effect.sync(() => {
        const binary: ResolvedBinary | null = resolveBinary(config, process.env);
        const env = childEnv(process.env, config);
        return { binary, env };
      });

      const start = (input: StartSessionInput, sessionRef?: ClaudeSessionRef, warning?: string) =>
        Effect.gen(function* () {
          const { binary, env } = yield* launch;
          if (binary === null) {
            return yield* failed("claude not found on PATH or in the usual install directories");
          }
          return yield* makeClaudeSession({
            instanceId,
            threadId: input.threadId,
            workspaceRoot: input.workspaceRoot,
            binary,
            env,
            loginCommand: terminalCommand(binary, LOGIN_ARGS, env.CLAUDE_CONFIG_DIR),
            services,
            settings: input.settings,
            ...(sessionRef === undefined ? {} : { sessionRef }),
            ...(warning === undefined ? {} : { warning }),
            ...(options.limits === undefined ? {} : { limits: options.limits }),
          });
        });

      /** One model list per instance: the handshake is a process start. */
      const models = yield* Ref.make<ReadonlyArray<ModelOption> | null>(null);
      const listModels = () =>
        Effect.gen(function* () {
          const cached = yield* Ref.get(models);
          if (cached !== null) return cached;
          const { binary, env } = yield* launch;
          if (binary === null) {
            return yield* failed("claude not found on PATH or in the usual install directories");
          }
          const listed = yield* readInitialization({
            binary,
            env,
            cwd: NodeOS.tmpdir(),
          }).pipe(Effect.mapError((error) => failed(error.message)));
          yield* Ref.set(models, listed.models);
          return listed.models;
        });

      return {
        instanceId,
        kind: CLAUDE_KIND,
        capabilities: CLAUDE_CAPABILITIES,
        startSession: (input) => start(input),
        resumeSession: (input) => {
          const ref = parseSessionRef(input.sessionRef);
          if (ref === undefined) {
            return start(
              input,
              undefined,
              "The previous Claude Code session could not be read back, so this thread starts a new one.",
            );
          }
          return resumeOrStartFresh(start(input, ref), (warning) =>
            start(input, undefined, warning),
          );
        },
        listModels,
      };
    }),
});

/** The definition with every default — what production registers. */
export const claudeConnectorDefinition = makeClaudeConnectorDefinition();
