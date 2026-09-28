/**
 * The probe against `fixtures/codex/probe/`: the real CLI's `--version`,
 * `login status` and zero-turn app-server handshake, replayed behind the
 * binary path. The capture was made signed in with ChatGPT.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  STDIO_JSONRPC_PROBE_MARKER,
  loadStdioJsonRpcRecording,
} from "@poseidon/testkit/stdioJsonRpcRecording";
import * as Effect from "effect/Effect";

import { isPidGone, replay } from "../test/replay";
import { childEnv } from "./env";
import { CODEX_KIND } from "./kind";
import {
  INSTALL_COMMAND,
  OLDEST_TESTED_VERSION,
  PROBE_SERVER_ARGS,
  describeAccount,
  isBelowOldestTested,
  missingHomeMessage,
  parseLoginStatus,
  parseVersion,
  probe,
  readHandshake,
} from "./probe";
import { PROTOCOL_CLI_VERSION } from "./protocol";

const recording = loadStdioJsonRpcRecording(CODEX_KIND, "probe");

/** What one recorded one-shot invocation printed, both streams. */
const outputOf = (argv: ReadonlyArray<string>): string =>
  recording.invocations
    .find((invocation) => invocation.argv.join(" ") === argv.join(" "))!
    .frames.map((frame) => String(frame.data))
    .join("\n");

describe("parsing what the CLI printed", () => {
  it("reads the version line", () => {
    expect(parseVersion(outputOf(["--version"]))).toBe(recording.manifest.cliVersion);
    expect(parseVersion("codex")).toBeUndefined();
  });

  it("reads a signed-in login status as present, and the signed-out one as absent", () => {
    expect(parseLoginStatus(outputOf(["login", "status"]))).toBe("present");
    expect(parseLoginStatus("Not logged in")).toBe("absent");
    expect(parseLoginStatus("Error loading configuration")).toBe("unknown");
  });

  it("warns only below the release the recordings were made at", () => {
    expect(OLDEST_TESTED_VERSION).toBe(recording.manifest.cliVersion);
    expect(PROTOCOL_CLI_VERSION).toBe(recording.manifest.cliVersion);
    expect(isBelowOldestTested("codex-cli 0.156.0")).toBe(true);
    expect(isBelowOldestTested("0.99.9")).toBe(true);
    expect(isBelowOldestTested(OLDEST_TESTED_VERSION)).toBe(false);
    expect(isBelowOldestTested("0.157.0")).toBe(false);
    expect(isBelowOldestTested("1.0.0")).toBe(false);
    expect(isBelowOldestTested("nightly")).toBe(false);
  });

  it("names an account by its email, or by how it signs in", () => {
    expect(describeAccount({ type: "chatgpt", email: "a@b.co" })).toBe("a@b.co");
    expect(describeAccount({ type: "chatgpt", email: null })).toBe("ChatGPT");
    expect(describeAccount({ type: "apiKey" })).toBe("API key");
    expect(describeAccount({ type: "amazonBedrock" })).toBe("Amazon Bedrock");
  });

  it("marks its handshake the way the recording format tells a probe from a session", () => {
    expect(PROBE_SERVER_ARGS).toContain(STDIO_JSONRPC_PROBE_MARKER);
  });
});

describe("readHandshake", () => {
  it.effect("reads the account and the models, then stops the app-server", () =>
    Effect.gen(function* () {
      const replayed = replay("probe");
      const handshake = yield* readHandshake({
        binary: { command: replayed.binaryPath, display: replayed.binaryPath },
        env: childEnv(process.env, {}),
        cwd: NodeOS.tmpdir(),
      });
      expect(handshake.auth).toBe("present");
      expect(handshake.account).toBe("user@example.com");
      expect(handshake.models.length).toBeGreaterThan(0);
      replayed.assertPlayedOut();
      expect(replayed.pids().every(isPidGone)).toBe(true);
    }),
  );
});

describe("probe", () => {
  it.effect("reports version, auth, account, the login command and the models", () =>
    Effect.gen(function* () {
      const replayed = replay("probe");
      const result = yield* probe({ binaryPath: replayed.binaryPath });

      expect(result).toMatchObject({
        status: "ready",
        installed: true,
        binaryPath: replayed.binaryPath,
        version: "0.156.1",
        auth: "present",
        account: "user@example.com",
        loginCommand: `${replayed.binaryPath} login`,
        warnings: [],
      });
      expect(result.message).toBeUndefined();
      expect(result.models.length).toBeGreaterThan(0);
      expect(new Set(result.models.map((model) => model.family))).toEqual(new Set(["Codex"]));
      for (const model of result.models) {
        expect(model.efforts.length, model.id).toBeGreaterThan(0);
      }

      // --version, login status, and the handshake — every one of them gone.
      replayed.assertPlayedOut();
      expect(replayed.pids().length).toBe(3);
      expect(replayed.pids().every(isPidGone)).toBe(true);
    }),
  );

  it.effect("names the instance's codex home in the login command", () =>
    Effect.gen(function* () {
      const replayed = replay("probe");
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-home-"));
      const result = yield* probe({ binaryPath: replayed.binaryPath, codexHome: home });
      expect(result.loginCommand).toBe(`CODEX_HOME=${home} ${replayed.binaryPath} login`);
    }),
  );

  it.effect("is an error naming the path when the instance's codex home does not exist", () =>
    Effect.gen(function* () {
      const replayed = replay("probe");
      const home = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-home-")),
        "not-made",
      );
      const result = yield* probe({ binaryPath: replayed.binaryPath, codexHome: home });
      expect(result).toMatchObject({
        status: "error",
        installed: true,
        version: "0.156.1",
        message: missingHomeMessage(home),
        auth: "unknown",
        models: [],
      });
      // Only --version ran: login status and the handshake would fail there too.
      expect(replayed.pids().length).toBe(1);
    }),
  );

  it.effect("says not installed when nothing resolves", () =>
    Effect.gen(function* () {
      const result = yield* probe({}, () => null);
      expect(result).toMatchObject({
        status: "not-installed",
        installed: false,
        installCommand: INSTALL_COMMAND,
        auth: "unknown",
        models: [],
      });
      expect(result.loginCommand).toBeUndefined();
    }),
  );

  it.effect("fails when the configured binary cannot be run at all", () =>
    Effect.gen(function* () {
      const missing = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-missing-")),
        "codex",
      );
      const error = yield* Effect.flip(probe({ binaryPath: missing }));
      expect(error._tag).toBe("ProbeFailed");
      expect(error.message).toContain(missing);
    }),
  );
});
