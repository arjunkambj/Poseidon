/**
 * Records `fixtures/codex/generate-text/` from the real CLI.
 *
 *     POSEIDON_RECORD_CODEX=1 POSEIDON_HOME=/tmp/poseidon-codex \
 *       pnpm -F @poseidon/connector-codex exec vitest run test/recordGenerateText.test.ts
 *
 * It runs the instance's own `generateText` with its binary path pointed at
 * the testkit's stdio tee: one app-server in a temporary directory, one
 * ephemeral read-only thread, one turn on the CLI's default model at effort
 * low with a JSON schema for the answer. The request is `GENERATE_REQUEST`,
 * which the replay test sends again. What the tee captured is finalised and
 * scrubbed into the scenario's directory.
 *
 * Skipped unless asked for: it runs the operator's real CLI and account.
 */

import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { makeConnectorInstanceId } from "@poseidon/contracts/ids";
import * as Effect from "effect/Effect";

import { makeCodexConnectorDefinition } from "../src/definition";
import { parseVersion } from "../src/probe";
import { GENERATE_REQUEST } from "./generateRequest";
import { RECORD, finalise, realCodex, teeInFront, threadModelOf } from "./record";
import { testServices } from "./services";

describe("the generate-text recording", () => {
  it.live.skipIf(!RECORD)("captures one ephemeral read-only turn with a schema", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const codex = realCodex();
        const cliVersion = parseVersion(execFileSync(codex, ["--version"], { encoding: "utf8" }));
        const { rawDir, launcher } = teeInFront(codex, "generate-text");
        const instance = yield* makeCodexConnectorDefinition().createInstance({
          instanceId: makeConnectorInstanceId(),
          config: { binaryPath: launcher },
          services: yield* testServices(),
        });

        const answer = yield* instance.generateText!(GENERATE_REQUEST);
        expect(JSON.parse(answer)).toHaveProperty("title");

        const dir = finalise({
          codex,
          scenario: "generate-text",
          rawDir,
          description:
            "generateText: one app-server with no MCP override, an ephemeral thread (read-only sandbox, approval policy never, the system text as developer instructions) and one turn at effort low with an outputSchema; the answer is a JSON title.",
          cliVersion: cliVersion ?? "unknown",
          model: threadModelOf(rawDir) ?? "default",
          prompts: [GENERATE_REQUEST.prompt],
        });
        expect(NodeFS.existsSync(NodePath.join(dir, "manifest.json"))).toBe(true);
      }),
    ),
  );
});
