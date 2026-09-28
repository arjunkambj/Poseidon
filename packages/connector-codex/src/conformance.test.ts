/**
 * The connector conformance suite, against the real CLI's recorded answers.
 *
 * Each case of `runConnectorConformance` opens its own session, so the
 * recording `fixtures/codex/conformance/` is the suite itself run through the
 * testkit's stdio tee: one app-server launch per case, in the suite's order.
 * The replay hands each case's launch the next recorded one, and exits 97 on
 * any line the connector sends that the recorded run was not sent.
 *
 *     POSEIDON_RECORD_CODEX=1 POSEIDON_HOME=/tmp/poseidon-codex \
 *       pnpm -F @poseidon/connector-codex vitest run src/conformance.test.ts
 *
 * records it again: the operator's CLI behind the tee, on its default model,
 * in a throwaway git repo under `/tmp/poseidon-codex/scratch`.
 *
 * The approval case asks for a file write, which the test ladder (every call
 * "prompt") stops on a card; the suite allows it once.
 *
 * `isProcessGone` looks from outside, as the suite requires: in a replay, at
 * the pid every replayed process drops; in a recording, at the process groups
 * of the tee processes this file started.
 */

import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { runConnectorConformance } from "@poseidon/connector-sdk/conformance";
import { makeConnectorInstanceId, makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import * as Effect from "effect/Effect";
import { afterAll } from "vitest";

import { finalise, RECORD, realCodex, teeInFront, threadModelOf } from "../test/record";
import { isPidGone, replay } from "../test/replay";
import { testServices } from "../test/services";
import { makeCodexConnectorDefinition } from "./definition";
import { parseVersion } from "./probe";

const SCENARIO = "conformance";
const PROMPT = "Reply with exactly: ok";
const APPROVAL_PROMPT = "Create a file named conformance.txt containing exactly the text: ok";

/** The operator's CLI behind the tee, and what the manifest needs to say about it. */
const recorder = () => {
  const codex = realCodex();
  const cliVersion = parseVersion(execFileSync(codex, ["--version"], { encoding: "utf8" }));
  const { rawDir, launcher } = teeInFront(codex, SCENARIO);
  const workspace = "/tmp/poseidon-codex/scratch/conformance";
  NodeFS.rmSync(workspace, { recursive: true, force: true });
  NodeFS.mkdirSync(workspace, { recursive: true });
  execFileSync("git", ["init", "--quiet", workspace], { stdio: "ignore" });
  /** Every process group a tee of this recording has led. */
  const groups = new Set<number>();
  const rows = (): ReadonlyArray<{ pid: number; pgid: number; command: string }> =>
    execFileSync("ps", ["-A", "-o", "pid=,pgid=,command="], { encoding: "utf8" })
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match === null
          ? []
          : [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[3]! }];
      });
  return {
    binaryPath: launcher,
    workspace,
    isGone: (): boolean => {
      const all = rows();
      for (const row of all) if (row.command.includes(rawDir)) groups.add(row.pgid);
      return !all.some((row) => groups.has(row.pgid));
    },
    finish: () =>
      finalise({
        codex,
        scenario: SCENARIO,
        rawDir,
        description:
          "The connector conformance suite, one app-server launch per case in the suite's order: each case's one-line prompt, and the approval case's file write stopped on a card and allowed once.",
        cliVersion: cliVersion ?? "unknown",
        model: threadModelOf(rawDir) ?? "default",
        prompts: [PROMPT, APPROVAL_PROMPT],
      }),
  };
};

/** The recording behind the binary path. */
const replayer = () => {
  const replayed = replay(SCENARIO);
  const workspace = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-conformance-")),
    "conformance",
  );
  NodeFS.mkdirSync(workspace);
  return {
    binaryPath: replayed.binaryPath,
    workspace,
    isGone: (): boolean => replayed.pids().every(isPidGone),
    finish: () => replayed.assertPlayedOut(),
  };
};

const driver = RECORD ? recorder() : replayer();
afterAll(() => {
  driver.finish();
});

runConnectorConformance(makeCodexConnectorDefinition(), {
  instanceId: makeConnectorInstanceId(),
  services: Effect.runSync(testServices()),
  config: { binaryPath: driver.binaryPath },
  session: {
    threadId: makeThreadId(),
    projectId: makeProjectId(),
    workspaceRoot: driver.workspace,
    settings: { model: "default", runtimeMode: "approval-required", interactionMode: "default" },
  },
  turn: { text: PROMPT, attachments: [], mentions: [] },
  approvalTurn: { text: APPROVAL_PROMPT, attachments: [], mentions: [] },
  isProcessGone: () => Effect.sync(driver.isGone),
});
