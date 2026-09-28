/**
 * The Codex connector definition: probe, instance creation, and — once the
 * app-server session lands — session start and resume. Everything else — the
 * binary, the environment, the JSON-RPC client, the handshake — lives in the
 * sibling modules this wires together.
 */

import * as NodeOS from "node:os";
import type { ConnectorDefinition } from "@poseidon/connector-sdk/definition";
import { SpawnFailed } from "@poseidon/connector-sdk/definition";
import type { ModelOption } from "@poseidon/contracts/connectors";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { resolveBinary } from "./binary";
import { CODEX_CAPABILITIES } from "./capabilities";
import { CodexConnectorConfig } from "./configSchema";
import { childEnv } from "./env";
import { CODEX_KIND } from "./kind";
import { NOT_FOUND, probe as probeBinary, readHandshake } from "./probe";

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
  createInstance: ({ instanceId, config }) =>
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
          return handshake.models;
        });

      const notYet = Effect.fail(failed("Codex sessions are not available yet"));

      return {
        instanceId,
        kind: CODEX_KIND,
        capabilities: CODEX_CAPABILITIES,
        startSession: () => notYet,
        resumeSession: () => notYet,
        listModels,
      };
    }),
});

/** The definition with every default — what production registers. */
export const codexConnectorDefinition = makeCodexConnectorDefinition();
