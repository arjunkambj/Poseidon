/**
 * The probe against `fixtures/claude/probe/` and `probe-signed-in/`: the real
 * CLI's `--version`, `auth status --json` and SDK handshake, replayed behind
 * the binary path. The first was captured while the CLI was signed out, the
 * second once it was signed in.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { loadSdkStreamRecording } from "@poseidon/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";

import { isPidGone, replay } from "../test/replay";
import { CLAUDE_KIND } from "./kind";
import {
  INSTALL_COMMAND,
  OLDEST_TESTED_VERSION,
  isBelowOldestTested,
  parseAuthStatus,
  parseVersion,
  probe,
} from "./probe";

const recording = loadSdkStreamRecording(CLAUDE_KIND, "probe");
const signedIn = loadSdkStreamRecording(CLAUDE_KIND, "probe-signed-in");

/** What one recorded simple invocation printed on stdout. */
const stdoutOf = (argv: ReadonlyArray<string>, from = recording): string =>
  from.invocations
    .find((invocation) => invocation.argv.join(" ") === argv.join(" "))!
    .frames.filter((frame) => frame.channel === "stdout")
    .map((frame) => String(frame.data))
    .join("\n");

describe("parsing what the CLI printed", () => {
  it("reads the version line", () => {
    expect(parseVersion(stdoutOf(["--version"]))).toBe(recording.manifest.cliVersion);
    expect(parseVersion("claude")).toBeUndefined();
  });

  it("reads a signed-out auth status as absent", () => {
    expect(parseAuthStatus(stdoutOf(["auth", "status", "--json"]))).toEqual({ auth: "absent" });
  });

  it("reads a signed-in auth status as present, with the account's email", () => {
    expect(parseAuthStatus(stdoutOf(["auth", "status", "--json"], signedIn))).toEqual({
      auth: "present",
      account: "user@example.com",
    });
  });

  it("reads anything that is not the status document as unknown", () => {
    expect(parseAuthStatus("")).toEqual({ auth: "unknown" });
    expect(parseAuthStatus("[]")).toEqual({ auth: "unknown" });
    expect(parseAuthStatus("{}")).toEqual({ auth: "unknown" });
  });

  it("warns only below the release the recordings were made at", () => {
    // The signed-out recordings, this probe among them, are the oldest kept.
    expect(OLDEST_TESTED_VERSION).toBe(recording.manifest.cliVersion);
    expect(isBelowOldestTested("2.1.279 (Claude Code)")).toBe(true);
    expect(isBelowOldestTested("2.0.999")).toBe(true);
    expect(isBelowOldestTested(OLDEST_TESTED_VERSION)).toBe(false);
    expect(isBelowOldestTested("2.1.281")).toBe(false);
    expect(isBelowOldestTested("3.0.0")).toBe(false);
    expect(isBelowOldestTested("nightly")).toBe(false);
  });
});

describe("probe", () => {
  it.effect("reports version, auth, the login command and the models of the recorded CLI", () =>
    Effect.gen(function* () {
      const replayed = replay("probe");
      const result = yield* probe({ binaryPath: replayed.binaryPath });

      expect(result).toMatchObject({
        status: "not-authenticated",
        installed: true,
        binaryPath: replayed.binaryPath,
        version: "2.1.280",
        auth: "absent",
        loginCommand: `${replayed.binaryPath} auth login`,
        message: `not signed in — run \`${replayed.binaryPath} auth login\``,
        warnings: [],
      });
      expect(result.account).toBeUndefined();
      expect(result.models.map((model) => model.id)).toEqual([
        "default",
        "opus[1m]",
        "claude-fable-5-1[1m]",
        "sonnet",
        "haiku",
      ]);
      expect(result.models[0]?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);

      // The handshake's CLI was stopped, not left behind.
      expect(replayed.pids().length).toBe(3);
      expect(replayed.pids().every(isPidGone)).toBe(true);
    }),
  );

  it.effect("reports a signed-in CLI ready, with its account and the account's models", () =>
    Effect.gen(function* () {
      const replayed = replay("probe-signed-in");
      const result = yield* probe({ binaryPath: replayed.binaryPath });

      expect(result).toMatchObject({
        status: "ready",
        installed: true,
        version: "2.1.286",
        auth: "present",
        account: "user@example.com",
        warnings: [],
      });
      expect(result.message).toBeUndefined();
      // The signed-in account lists more than the signed-out CLI did, and
      // names its default and Opus without the 1M context suffix.
      expect(result.models.map((model) => model.id)).toEqual([
        "default",
        "opus",
        "claude-fable-5-1",
        "sonnet",
        "haiku",
        "claude-sonnet-5",
        "claude-opus-5",
        "claude-fable-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
      ]);
      expect(result.models.find((model) => model.id === "haiku")?.efforts).toEqual([]);
      expect(result.models.find((model) => model.id === "claude-opus-4-6")?.efforts).toEqual([
        "low",
        "medium",
        "high",
        "max",
      ]);
      expect(replayed.pids().every(isPidGone)).toBe(true);
    }),
  );

  it.effect("names the account directory in the login command", () =>
    Effect.gen(function* () {
      const replayed = replay("probe");
      const result = yield* probe({ binaryPath: replayed.binaryPath, configDir: "/tmp/work" });
      expect(result.loginCommand).toBe(
        `CLAUDE_CONFIG_DIR=/tmp/work ${replayed.binaryPath} auth login`,
      );
    }),
  );

  it.effect("says not installed when nothing resolves", () =>
    Effect.gen(function* () {
      const result = yield* probe({}, () => null);
      expect(result).toMatchObject({
        status: "not-installed",
        installed: false,
        installCommand: INSTALL_COMMAND,
        models: [],
      });
      expect(result.loginCommand).toBeUndefined();
    }),
  );

  it.effect("fails when the configured binary cannot be run at all", () =>
    Effect.gen(function* () {
      const missing = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-missing-")),
        "claude",
      );
      const error = yield* Effect.flip(probe({ binaryPath: missing }));
      expect(error._tag).toBe("ProbeFailed");
      expect(error.message).toContain(missing);
    }),
  );
});
