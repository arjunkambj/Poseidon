/**
 * What the Codex definition says about itself — the metadata and config form
 * `connectors.describe` serves — and what an instance of it offers.
 */

import { eraseConnectorDefinition } from "@poseidon/connector-sdk/definition";
import { makeConnectorInstanceId, makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { replay } from "../test/replay";
import { testServices } from "../test/services";
import { CODEX_CAPABILITIES } from "./capabilities";
import { CodexConnectorConfig } from "./configSchema";
import { codexConnectorDefinition } from "./definition";
import { CODEX_KIND } from "./kind";

describe("codexConnectorDefinition", () => {
  it("presents itself through its own metadata", () => {
    const { kind, metadata } = codexConnectorDefinition;
    expect(kind).toBe(CODEX_KIND);
    expect(metadata.displayName).toBe("Codex");
    expect(metadata.iconKey).toBe("terminal");
    expect(metadata.accent).toMatch(/^#[0-9a-f]{6}$/i);
    // The CLI's own --help names no documentation link, so none is claimed.
    expect(metadata.docsUrl).toBeUndefined();
  });

  it("describes its config form in declaration order", () => {
    const erased = eraseConnectorDefinition(codexConnectorDefinition);
    expect(erased.configFields.map((field) => [field.key, field.control, field.optional])).toEqual([
      ["binaryPath", "path", true],
      ["codexHome", "path", true],
      ["defaultModel", "select", true],
    ]);
    expect(erased.configFields[1]?.description).toContain("CODEX_HOME");
    expect(erased.configFields[1]?.description).toContain("HOME is never changed");
  });

  it.effect("starts from an empty config the schema accepts", () =>
    Effect.gen(function* () {
      const config = codexConnectorDefinition.defaultConfig();
      expect(yield* Schema.decodeUnknownEffect(CodexConnectorConfig)(config)).toEqual({});
    }),
  );

  it.effect("opens instances with the connector's capabilities and no extensions yet", () =>
    Effect.gen(function* () {
      const instance = yield* codexConnectorDefinition.createInstance({
        instanceId: makeConnectorInstanceId(),
        config: {},
        services: yield* testServices(),
      });
      expect(instance.kind).toBe(CODEX_KIND);
      expect(instance.capabilities).toEqual(CODEX_CAPABILITIES);
      expect(instance.extensions).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a session until the app-server session lands", () =>
    Effect.gen(function* () {
      const instance = yield* codexConnectorDefinition.createInstance({
        instanceId: makeConnectorInstanceId(),
        config: {},
        services: yield* testServices(),
      });
      const error = yield* Effect.flip(
        instance.startSession({
          threadId: makeThreadId(),
          projectId: makeProjectId(),
          workspaceRoot: "/nonexistent",
          settings: {
            model: "gpt-5.5",
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
        }),
      );
      expect(error._tag).toBe("SpawnFailed");
    }).pipe(Effect.scoped),
  );

  it.effect("lists models once per instance: the handshake is a process start", () =>
    Effect.gen(function* () {
      const replayed = replay("probe");
      const instance = yield* codexConnectorDefinition.createInstance({
        instanceId: makeConnectorInstanceId(),
        config: { binaryPath: replayed.binaryPath },
        services: yield* testServices(),
      });
      const first = yield* instance.listModels();
      const second = yield* instance.listModels();
      expect(second).toBe(first);
      expect(first.length).toBeGreaterThan(0);
      expect(first.every((model) => model.family === "Codex")).toBe(true);
      replayed.assertPlayedOut();
      // One replayed handshake, not two.
      expect(replayed.pids()).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("fails to list models when no binary resolves", () =>
    Effect.gen(function* () {
      const instance = yield* codexConnectorDefinition.createInstance({
        instanceId: makeConnectorInstanceId(),
        config: { binaryPath: "/nonexistent/codex" },
        services: yield* testServices(),
      });
      const error = yield* Effect.flip(instance.listModels());
      expect(error._tag).toBe("SpawnFailed");
      expect(error.message).toContain("could not start");
    }).pipe(Effect.scoped),
  );
});
