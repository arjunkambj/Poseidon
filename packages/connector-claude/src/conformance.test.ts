/**
 * The connector conformance suite, against the real CLI's recorded answers.
 *
 * Each case of `runConnectorConformance` opens its own session, so the
 * recording `fixtures/claude/conformance/` is the suite itself run through the
 * testkit's stdio tee: one session launch per case, in the suite's order. The
 * replay hands each case's launch the next recorded one, and exits 97 on any
 * line the connector sends that the recorded run was not sent.
 *
 *     POSEIDON_RECORD_CLAUDE=1 pnpm -F @poseidon/connector-claude exec vitest run src/conformance.test.ts
 *
 * records it again: the operator's CLI behind the tee, in a scratch repo under
 * `/tmp/poseidon-h1`, capped at one turn and fifty cents a session. The cap
 * is above what a session's first request costs on the default model, whose
 * prompt cache it writes (ten to twenty cents at list price on 2.1.286): under
 * ten cents the CLI ended the approval case's turn for the budget before its
 * write was even asked about.
 *
 * The suite's approval case asks for a file write, which the test ladder
 * (every call "prompt") stops on a card. It runs whenever the recording has
 * it — a recording made signed in does, since the case's prompt is in its
 * manifest — and always when recording. The recording here was made signed
 * in, so it has the case; one made signed out, where the CLI refuses every
 * turn before any tool call, would not, and the case would be skipped under
 * a title that says so.
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
import {
  finalizeSdkStreamRecording,
  loadSdkStreamRecording,
  makeTeeLauncher,
} from "@poseidon/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";
import { afterAll, it } from "vitest";

import { initModelOf, isPidGone, replay, sdkVersion } from "../test/replay";
import { testServices } from "../test/services";
import { resolveBinary } from "./binary";
import { makeClaudeConnectorDefinition } from "./definition";
import { CLAUDE_KIND } from "./kind";
import { parseVersion } from "./probe";

const SCENARIO = "conformance";
const PROMPT = "Reply with exactly: ok";
const APPROVAL_PROMPT = "Create a file named conformance.txt containing exactly the text: ok";
const RECORD = process.env.POSEIDON_RECORD_CLAUDE === "1";
/** The approval case is in the recording being replayed, or is being recorded. */
const WITH_APPROVAL =
  RECORD ||
  loadSdkStreamRecording(CLAUDE_KIND, SCENARIO).manifest.prompts.includes(APPROVAL_PROMPT);

/** The operator's CLI behind the tee, and what the manifest needs to say about it. */
const recorder = () => {
  const real = resolveBinary({}, process.env);
  if (real === null) throw new Error("no claude binary to record");
  const cliVersion = parseVersion(execFileSync(real.command, ["--version"], { encoding: "utf8" }));
  const root = "/tmp/poseidon-h1";
  NodeFS.mkdirSync(NodePath.join(root, "raw"), { recursive: true });
  const rawDir = NodeFS.mkdtempSync(NodePath.join(root, "raw", `${SCENARIO}-`));
  const scratch = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(root, `${SCENARIO}-`)));
  const workspace = NodePath.join(scratch, "workspace");
  NodeFS.mkdirSync(workspace);
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
    binaryPath: makeTeeLauncher({ realBinary: real.command, rawDir }),
    workspace,
    isGone: (): boolean => {
      const all = rows();
      for (const row of all) if (row.command.includes(rawDir)) groups.add(row.pgid);
      return !all.some((row) => groups.has(row.pgid));
    },
    finish: () =>
      finalizeSdkStreamRecording({
        kind: CLAUDE_KIND,
        scenario: SCENARIO,
        rawDir,
        description:
          "The connector conformance suite, one session launch per case in the suite's order: each case's one-line prompt, and the approval case's file write stopped on a card and allowed once.",
        cliVersion: cliVersion ?? "unknown",
        sdkVersion: sdkVersion(),
        model: initModelOf(rawDir) ?? "default",
        prompts: [PROMPT, APPROVAL_PROMPT],
        scratch,
      }),
  };
};

/** The recording behind the binary path. */
const replayer = () => {
  const replayed = replay(SCENARIO);
  const workspace = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-conformance-")),
    "workspace",
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
afterAll(() => driver.finish());

runConnectorConformance(
  makeClaudeConnectorDefinition({ limits: { maxTurns: 1, maxBudgetUsd: 0.5 } }),
  {
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
    ...(WITH_APPROVAL
      ? { approvalTurn: { text: APPROVAL_PROMPT, attachments: [], mentions: [] } }
      : {}),
    isProcessGone: () => Effect.sync(driver.isGone),
  },
);

if (!WITH_APPROVAL) {
  it.skip(`resolves every approval request it opens — fixtures/claude/${SCENARIO}/ has no approval case yet: re-record it with a signed-in CLI`, () => {});
}
