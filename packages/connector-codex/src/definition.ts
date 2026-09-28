/**
 * The Codex connector definition: probe, instance creation, and session start
 * and resume. Everything else — the binary, the environment, the JSON-RPC
 * client, the handshake, the translation — lives in the sibling modules this
 * wires together. Sessions come back raw; the engine's SessionManager adds
 * the turn-scoped wrapper.
 */

import * as NodeOS from "node:os";
import type { ConnectorDefinition, StartSessionInput } from "@poseidon/connector-sdk/definition";
import { SpawnFailed } from "@poseidon/connector-sdk/definition";
import type { ModelOption } from "@poseidon/contracts/connectors";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { resolveBinary, terminalCommand } from "./binary";
import { CODEX_CAPABILITIES } from "./capabilities";
import { CodexConnectorConfig } from "./configSchema";
import { childEnv } from "./env";
import { CODEX_KIND } from "./kind";
import { LOGIN_ARGS, NOT_FOUND, probe as probeBinary, readHandshake } from "./probe";
import { makeCodexSession } from "./session";
import { parseSessionRef, type CodexSessionRef } from "./sessionRef";

/** What a thread is told when its stored reference is not one this connector made. */
export const UNREADABLE_REF_WARNING =
  "The previous Codex session could not be read back, so this thread starts a new one.";

export const makeCodexConnectorDefinition = (): ConnectorDefinition<CodexConnectorConfig> => ({
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
      /** The same list, read synchronously by a session choosing a turn's effort. */
      let listed: ReadonlyArray<ModelOption> | null = null;
      const effortsFor = (model: string) => listed?.find((option) => option.id === model)?.efforts;
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
          listed = handshake.models;
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
            effortsFor,
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
      };
    }),
});

/** The definition with every default — what production registers. */
export const codexConnectorDefinition = makeCodexConnectorDefinition();
