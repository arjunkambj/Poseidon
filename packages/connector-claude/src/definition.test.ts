/**
 * What the Claude Code definition says about itself — the metadata and config
 * form `connectors.describe` serves — and what an instance of it offers.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { eraseConnectorDefinition, SpawnFailed } from "@poseidon/connector-sdk/definition";
import { makeConnectorInstanceId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { replay } from "../test/replay";
import { testServices } from "../test/services";
import { CLAUDE_CAPABILITIES } from "./capabilities";
import { ClaudeConnectorConfig } from "./configSchema";
import {
  claudeConnectorDefinition,
  isMissingConversation,
  NO_CONVERSATION_WARNING,
  resumeOrStartFresh,
} from "./definition";
import { CLAUDE_KIND } from "./kind";
import { handshakeFailureMessage } from "./session";

describe("claudeConnectorDefinition", () => {
  it.effect("presents itself through its own metadata", () =>
    Effect.gen(function* () {
      const { kind, metadata } = yield* Effect.succeed(claudeConnectorDefinition);
      expect(kind).toBe(CLAUDE_KIND);
      expect(metadata.displayName).toBe("Claude Code");
      expect(metadata.iconKey).toBe("claude-code");
      expect(metadata.accent).toMatch(/^#[0-9a-f]{6}$/i);
      // The CLI's own --help names no documentation link, so none is claimed.
      expect(metadata.docsUrl).toBeUndefined();
    }),
  );

  it.effect("describes its config form in declaration order", () =>
    Effect.gen(function* () {
      const erased = yield* Effect.sync(() => eraseConnectorDefinition(claudeConnectorDefinition));
      expect(
        erased.configFields.map((field) => [field.key, field.control, field.optional]),
      ).toEqual([
        ["binaryPath", "path", true],
        ["configDir", "path", true],
        ["defaultModel", "select", true],
      ]);
      expect(erased.configFields[1]?.description).toContain("CLAUDE_CONFIG_DIR");
      expect(erased.configFields[1]?.description).toContain("HOME is never changed");
    }),
  );

  it.effect("starts from an empty config the schema accepts", () =>
    Effect.gen(function* () {
      const config = claudeConnectorDefinition.defaultConfig();
      expect(yield* Schema.decodeUnknownEffect(ClaudeConnectorConfig)(config)).toEqual({});
    }),
  );

  it.effect("opens instances with the connector's capabilities", () =>
    Effect.gen(function* () {
      const instance = yield* claudeConnectorDefinition.createInstance({
        instanceId: makeConnectorInstanceId(),
        config: {},
        services: yield* testServices(),
      });
      expect(instance.kind).toBe(CLAUDE_KIND);
      expect(instance.capabilities).toEqual(CLAUDE_CAPABILITIES);
      // The harness's own slash commands, skills, installed plugins, MCP
      // servers and session files.
      expect(Object.keys(instance.extensions ?? {})).toEqual([
        "commands",
        "skills",
        "plugins",
        "mcpServers",
        "sessions",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("lists the plugins of the account the instance's config names", () =>
    Effect.gen(function* () {
      const configDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-config-"));
      NodeFS.mkdirSync(NodePath.join(configDir, "plugins"));
      NodeFS.writeFileSync(
        NodePath.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: { "formatter@team": [{ scope: "user", installPath: "/nowhere" }] },
        }),
      );
      const instance = yield* claudeConnectorDefinition.createInstance({
        instanceId: makeConnectorInstanceId(),
        config: { configDir },
        services: yield* testServices(),
      });
      const plugins = yield* instance.extensions!.plugins!.list({ workspaceRoot: null });
      expect(plugins).toEqual([
        { name: "formatter", source: "team", scope: "user", enabled: true },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("lists models once per instance: the handshake is a process start", () =>
    Effect.gen(function* () {
      const replayed = replay("probe");
      const instance = yield* claudeConnectorDefinition.createInstance({
        instanceId: makeConnectorInstanceId(),
        config: { binaryPath: replayed.binaryPath },
        services: yield* testServices(),
      });
      const first = yield* instance.listModels();
      const second = yield* instance.listModels();
      expect(second).toBe(first);
      expect(first[0]?.id).toBe("default");
      // One replayed handshake; a second launch would have found none left to play.
      expect(replayed.pids()).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("lists its slash commands from the same handshake as its models", () =>
    Effect.gen(function* () {
      const replayed = replay("probe");
      const instance = yield* claudeConnectorDefinition.createInstance({
        instanceId: makeConnectorInstanceId(),
        config: { binaryPath: replayed.binaryPath },
        services: yield* testServices(),
      });
      const commands = instance.extensions?.commands;
      expect(commands).toBeDefined();
      // Asked together, as the model picker and the '/' menu do on first open.
      const [models, listed] = yield* Effect.all(
        [instance.listModels(), commands!.list({ workspaceRoot: null })],
        { concurrency: "unbounded" },
      );
      // The scope changes nothing: the handshake loads no project settings.
      const inProject = yield* commands!.list({ workspaceRoot: "/work/project" });
      expect(models[0]?.id).toBe("default");
      // The recorder scrubs the command list down to one entry; its empty
      // argument hint is left out.
      expect(listed).toEqual([
        { name: "scrubbed-entry", description: "scrubbed-entry (recording)" },
      ]);
      expect(inProject).toBe(listed);
      expect(replayed.pids()).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("answers a failed handshake as an internal extension failure", () =>
    Effect.gen(function* () {
      const instance = yield* claudeConnectorDefinition.createInstance({
        instanceId: makeConnectorInstanceId(),
        config: { binaryPath: "/nonexistent/claude" },
        services: yield* testServices(),
      });
      const error = yield* Effect.flip(
        instance.extensions!.commands!.list({ workspaceRoot: null }),
      );
      expect(error._tag).toBe("ConnectorExtensionFailed");
      expect(error.code).toBe("internal");
    }).pipe(Effect.scoped),
  );
});

describe("a resume the CLI no longer has the conversation for", () => {
  const instanceId = makeConnectorInstanceId();
  /** The SDK's own words for a CLI that exited during the handshake. */
  const EXITED = "Claude Code process exited with code 1";
  /** The CLI's stderr line for `--resume` of a conversation it does not have (2.1.280). */
  const NO_CONVERSATION =
    "No conversation found with session ID: 0b7d1f0e-4c1a-4f55-9d8e-2f1c3a9b7e21";
  const failed = (message: string) => new SpawnFailed({ kind: CLAUDE_KIND, instanceId, message });

  it("carries the CLI's stderr tail into the handshake's message", () => {
    expect(handshakeFailureMessage(EXITED, `\n${NO_CONVERSATION}\n`)).toBe(
      `${EXITED}: ${NO_CONVERSATION}`,
    );
    expect(handshakeFailureMessage(EXITED, "  \n")).toBe(EXITED);
    const clipped = handshakeFailureMessage(EXITED, `${"x".repeat(2000)}${NO_CONVERSATION}`);
    expect(clipped.length).toBeLessThan(EXITED.length + 510);
    expect(clipped.endsWith(NO_CONVERSATION)).toBe(true);
  });

  it("is only recognised from the stderr the message carries", () => {
    expect(isMissingConversation(failed(EXITED))).toBe(false);
    expect(isMissingConversation(failed(handshakeFailureMessage(EXITED, NO_CONVERSATION)))).toBe(
      true,
    );
  });

  it.effect("starts fresh, and says why", () =>
    Effect.gen(function* () {
      const warnings: Array<string> = [];
      const started = yield* resumeOrStartFresh(
        Effect.fail(failed(handshakeFailureMessage(EXITED, NO_CONVERSATION))),
        (warning) =>
          Effect.sync(() => {
            warnings.push(warning);
            return "fresh";
          }),
      );
      expect(started).toBe("fresh");
      expect(warnings).toEqual([NO_CONVERSATION_WARNING]);
      expect(NO_CONVERSATION_WARNING).toBe(
        "Claude Code no longer has this thread's conversation, so it starts a new one.",
      );
    }),
  );

  it.effect("lets every other failed start through", () =>
    Effect.gen(function* () {
      let freshStarts = 0;
      const error = yield* Effect.flip(
        resumeOrStartFresh(
          Effect.fail(failed(handshakeFailureMessage(EXITED, "Error: something else broke"))),
          () =>
            Effect.sync(() => {
              freshStarts += 1;
              return "fresh";
            }),
        ),
      );
      expect(error._tag).toBe("SpawnFailed");
      expect(error.message).toContain("something else broke");
      expect(freshStarts).toBe(0);
    }),
  );
});
