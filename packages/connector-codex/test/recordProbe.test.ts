/**
 * Records `fixtures/codex/probe/` from the real CLI.
 *
 *     POSEIDON_RECORD_CODEX=1 POSEIDON_HOME=/tmp/poseidon-codex \
 *       pnpm -F @poseidon/connector-codex vitest run test/recordProbe.test.ts
 *
 * It runs the connector's own probe with its binary path pointed at the
 * testkit's stdio tee, so every launch — `--version`, `login status`, and the
 * zero-turn app-server handshake that reads the account and lists the models
 * — is captured exactly as the CLI answered, then finalised and scrubbed. No
 * thread is started, so recording it costs nothing.
 *
 * Skipped unless asked for: it reads the operator's real CLI and account.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { probe } from "../src/probe";
import { RECORD, finalise, realCodex, teeInFront } from "./record";

describe("the probe recording", () => {
  it.effect.skipIf(!RECORD)("captures the real CLI's probe", () =>
    Effect.gen(function* () {
      const codex = realCodex();
      const { rawDir, launcher } = teeInFront(codex, "probe");

      const result = yield* probe({ binaryPath: launcher });
      expect(result.version).toBeDefined();
      expect(result.models.length).toBeGreaterThan(0);

      const dir = finalise({
        codex,
        scenario: "probe",
        rawDir,
        description: `The connector's probe: --version, login status, and the zero-turn app-server handshake (initialize, account/read, model/list). No thread is started. Recorded ${result.auth === "present" ? "signed in" : "signed out"}.`,
        cliVersion: result.version!,
        model: "default",
        prompts: [],
      });
      expect(NodeFS.existsSync(NodePath.join(dir, "manifest.json"))).toBe(true);
    }),
  );
});
