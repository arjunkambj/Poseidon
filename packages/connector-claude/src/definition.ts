/**
 * The Claude Code connector definition: probe, instance creation, and session
 * start and resume. Everything else — the binary, the environment, the SDK
 * options, the translation — lives in the sibling modules this wires
 * together. Sessions come back raw; the engine's SessionManager adds the
 * turn-scoped wrapper.
 */

import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type {
  ConnectorDefinition,
  ConnectorError,
  StartSessionInput,
} from "@poseidon/connector-sdk/definition";
import { SpawnFailed } from "@poseidon/connector-sdk/definition";
import {
  ConnectorExtensionFailed,
  type CommandsExtension,
} from "@poseidon/connector-sdk/extensions";
import type { ModelOption } from "@poseidon/contracts/connectors";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { resolveBinary, terminalCommand, type ResolvedBinary } from "./binary";
import { CLAUDE_CAPABILITIES } from "./capabilities";
import { runClaude } from "./cli";
import { ClaudeConnectorConfig } from "./configSchema";
import { childEnv } from "./env";
import { makeClaudeGenerateText } from "./generateText";
import { handshakeKey, makeHandshakes, type HandshakeSource } from "./handshakes";
import { CLAUDE_KIND } from "./kind";
import { makeClaudeMcpServers } from "./mcpServers";
import { LOGIN_ARGS, probe as probeBinary, readInitialization, type Handshake } from "./probe";
import { makeClaudePlugins } from "./plugins";
import type { SessionLimits } from "./queryOptions";
import { makeClaudeSession } from "./session";
import { makeClaudeSessionFiles } from "./sessionFiles";
import { makeClaudeSkills } from "./skills";
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
  /** The shared agents skills folder; `~/.agents/skills` when omitted. */
  readonly agentsSkillsRoot?: string;
  /** How a zero-turn handshake runs; a test swaps in answers of its own. */
  readonly handshake?: Handshake;
}

/**
 * When an instance asks again after a provisional answer, counted from the
 * one before: a few tries over about a minute, each one CLI start that sends
 * nothing. The CLI waits only briefly for its account's catalog when nothing
 * is cached, and a busy boot can outlast that wait.
 */
export const ASK_AGAIN_AFTER: ReadonlyArray<Duration.Input> = [
  "2 seconds",
  "10 seconds",
  "30 seconds",
];

/**
 * How long an asking-again handshake that is still provisional keeps the CLI
 * idle before stopping it, so the catalog request it has in flight can land
 * and write the CLI's cache for the next try (`readInitialization`).
 */
export const LINGER = "6 seconds";

const sameModels = (a: ReadonlyArray<ModelOption>, b: ReadonlyArray<ModelOption>): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export const makeClaudeConnectorDefinition = (
  options: ClaudeConnectorOptions = {},
): ConnectorDefinition<ClaudeConnectorConfig> => {
  /**
   * The definition's, so instances that share a config never link into it, or
   * run two MCP server writes and their ledger writes on it, at once.
   */
  const writeMutex = Semaphore.makeUnsafe(1);
  /** The latest handshake per config, which the probe and the instances share. */
  const handshakes = makeHandshakes();
  const handshake = options.handshake ?? readInitialization;
  return {
    kind: CLAUDE_KIND,
    metadata: {
      displayName: "Claude Code",
      iconKey: "claude-code",
      accent: "#d97757",
      // `claude --help` names no documentation link, so none is given.
    },
    configSchema: ClaudeConnectorConfig,
    defaultConfig: () => ({}),
    probe: (config) =>
      probeBinary(config, undefined, (input) =>
        Effect.flatMap(handshake(input), (found) =>
          handshakes.record(handshakeKey(config), found, "probe"),
        ),
      ),
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

        /**
         * One handshake answer per config, shared by the model list and the
         * slash commands — it is a process start — and with the probe, whose
         * every run replaces it (`handshakes.ts`). Asks that arrive before any
         * answer wait for the one in flight. A failed one is not kept, so the
         * next ask tries again.
         */
        const key = handshakeKey(config);
        const shared = yield* handshakes.of(key);
        const ask = (source: HandshakeSource, linger?: Duration.Input) =>
          Effect.gen(function* () {
            const { binary, env } = yield* launch;
            if (binary === null) {
              return yield* failed("claude not found on PATH or in the usual install directories");
            }
            const found = yield* handshake({
              binary,
              env,
              cwd: NodeOS.tmpdir(),
              ...(linger === undefined ? {} : { linger }),
            }).pipe(Effect.mapError((error) => failed(error.message)));
            return yield* handshakes.record(key, found, source);
          });
        const oneAtATime = yield* Semaphore.make(1);
        const initialize = oneAtATime.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* SubscriptionRef.get(shared);
            return current !== null ? current.answer : yield* ask("instance");
          }),
        );

        /**
         * A provisional answer, from the probe or this instance, is asked about
         * again a bounded number of times, until a full one is heard. Answers
         * this asking produced do not start it over, so it cannot feed itself.
         */
        const askAgain = Effect.gen(function* () {
          for (const delay of ASK_AGAIN_AFTER) {
            yield* Effect.sleep(delay);
            const current = yield* SubscriptionRef.get(shared);
            if (current !== null && !current.answer.provisional) return;
            yield* Effect.ignore(ask("retry", LINGER));
          }
        });
        yield* SubscriptionRef.changes(shared).pipe(
          Stream.filter(
            (recorded) =>
              recorded !== null && recorded.answer.provisional && recorded.source !== "retry",
          ),
          Stream.runForEach(() => askAgain),
          Effect.forkScoped,
        );

        const listModels = () => Effect.map(initialize, (listed) => listed.models);
        // The handshake loads no settings (`commands.ts`), so the scope changes nothing.
        const commands: CommandsExtension = {
          list: () =>
            initialize.pipe(
              Effect.map((listed) => listed.commands),
              Effect.mapError(
                (error) =>
                  new ConnectorExtensionFailed({ code: "internal", message: error.message }),
              ),
            ),
        };

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
          modelUpdates: SubscriptionRef.changes(shared).pipe(
            Stream.filter((recorded) => recorded !== null),
            Stream.map((recorded) => recorded.answer.models),
            Stream.changesWith(sameModels),
          ),
          generateText: makeClaudeGenerateText({ instanceId, launch }),
          extensions: {
            commands,
            skills: makeClaudeSkills({
              env: childEnv(process.env, config),
              agentsSkillsRoot:
                options.agentsSkillsRoot ?? NodePath.join(NodeOS.homedir(), ".agents", "skills"),
              writeMutex,
            }),
            plugins: makeClaudePlugins({ env: childEnv(process.env, config) }),
            mcpServers: makeClaudeMcpServers({
              env: childEnv(process.env, config),
              // The same default-deny environment a session gets, resolved per
              // run, so the CLI edits the config the ledger sits beside.
              run: runClaude({
                binary: () => resolveBinary(config, process.env),
                env: () => childEnv(process.env, config),
              }),
              writeMutex,
            }),
            sessions: makeClaudeSessionFiles({ env: childEnv(process.env, config) }),
          },
        };
      }),
  };
};

/** The definition with every default — what production registers. */
export const claudeConnectorDefinition = makeClaudeConnectorDefinition();
