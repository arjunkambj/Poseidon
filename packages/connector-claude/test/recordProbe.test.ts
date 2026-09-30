/**
 * Records `fixtures/claude/probe/` from the real CLI when it is signed out,
 * and `fixtures/claude/probe-signed-in/` when it is signed in.
 *
 *     POSEIDON_RECORD_CLAUDE=1 pnpm -F @poseidon/connector-claude vitest run test/recordProbe.test.ts
 *
 * It runs the connector's own probe with its binary path pointed at the
 * testkit's stdio tee, so every launch — `--version`, `auth status --json`,
 * and the zero-turn SDK handshake that lists the models — is captured exactly
 * as the CLI answered, then finalised and scrubbed. The probe sends no
 * message to the API, so recording it costs nothing. The two are kept apart
 * because each is the only record of what the CLI says in that state: a CLI
 * signed in cannot record the signed-out answers again, nor the other way
 * round.
 *
 * Skipped unless asked for: it reads the operator's real CLI and account.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { finalizeSdkStreamRecording, makeTeeLauncher } from "@poseidon/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";

import { resolveBinary } from "../src/binary";
import { CLAUDE_KIND } from "../src/kind";
import { probe } from "../src/probe";
import { sdkVersion } from "./replay";

const RECORD = process.env.POSEIDON_RECORD_CLAUDE === "1";

describe("the probe recording", () => {
  it.effect.skipIf(!RECORD)("captures the real CLI's probe", () =>
    Effect.gen(function* () {
      const real = resolveBinary({}, process.env);
      if (real === null) throw new Error("no claude binary to record");
      const rawDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-probe-raw-"));
      const launcher = makeTeeLauncher({ realBinary: real.command, rawDir });

      const result = yield* probe({ binaryPath: launcher });
      expect(result.version).toBeDefined();

      const signedIn = result.auth === "present";
      const dir = finalizeSdkStreamRecording({
        kind: CLAUDE_KIND,
        scenario: signedIn ? "probe-signed-in" : "probe",
        rawDir,
        description: `The connector's probe: --version, auth status --json, and the zero-turn SDK handshake that lists the models. No message is sent. Recorded ${signedIn ? "signed in" : "signed out"}.`,
        cliVersion: result.version!,
        sdkVersion: sdkVersion(),
        model: "default",
        prompts: [],
      });
      expect(NodeFS.existsSync(NodePath.join(dir, "manifest.json"))).toBe(true);
    }),
  );
});
