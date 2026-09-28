/**
 * Every recorded Codex session, through the translator.
 *
 * `fixtures/codex/` holds what the real app-server said, line by line. This
 * walks every app-server launch of every recording — the probe's handshake
 * included — and feeds the translator each notification the server sent, with
 * the turn the session would have had open at that point. A notification the
 * translator does not map shows up here as `event.unmapped`, so a CLI release
 * that starts saying something new fails in the gate rather than going
 * quietly missing from the timeline.
 *
 * Anything left unmapped has to be listed below with the reason it is.
 */

import { makeTurnId } from "@poseidon/contracts/ids";
import { recordingNames } from "@poseidon/testkit/recording";
import { loadStdioJsonRpcRecording } from "@poseidon/testkit/stdioJsonRpcRecording";
import { describe, expect, it } from "vitest";

import { CODEX_KIND } from "./kind";
import { isBelowOldestTested, OLDEST_TESTED_VERSION } from "./probe";
import type { Json } from "./translate/pending";
import { makeTranslator, type TurnContext } from "./translate/translator";

/**
 * Notifications the translator leaves unmapped on purpose, by method, each
 * with its reason. Empty while every recorded notification has a mapping.
 */
const UNMAPPED_ON_PURPOSE: Readonly<Record<string, string>> = {};

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const scenarios = [...recordingNames(CODEX_KIND), "probe"];

const launches = scenarios.flatMap((scenario) =>
  loadStdioJsonRpcRecording(CODEX_KIND, scenario).invocations.flatMap((invocation) =>
    invocation.argv.includes("app-server")
      ? [{ scenario, file: invocation.file, frames: invocation.frames }]
      : [],
  ),
);

describe("the recorded Codex sessions", () => {
  it("were all recorded at or above the oldest tested CLI version", () => {
    for (const scenario of scenarios) {
      const { manifest } = loadStdioJsonRpcRecording(CODEX_KIND, scenario);
      expect(isBelowOldestTested(manifest.cliVersion), `${scenario}: ${manifest.cliVersion}`).toBe(
        false,
      );
    }
    expect(OLDEST_TESTED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("include every session scenario the connector is tested against", () => {
    expect(recordingNames(CODEX_KIND)).toEqual(
      expect.arrayContaining([
        "compaction",
        "image",
        "interrupt",
        "model-switch",
        "plain-reply",
        "plan-accept",
        "question",
        "resume",
        "resume-missing",
        "steering",
      ]),
    );
  });

  it.each(launches.map((launch) => [`${launch.scenario}/${launch.file}`, launch] as const))(
    "%s translates with nothing unmapped",
    (_, launch) => {
      const translator = makeTranslator({ loginCommand: "codex login" });
      let turn: TurnContext | null = null;
      const unmapped: Array<string> = [];
      for (const frame of launch.frames) {
        const data = frame.data;
        if (!isObject(data)) continue;
        if (frame.dir === "to-harness") {
          if (data.method === "turn/start" && turn === null) {
            turn = { turnId: makeTurnId(), interrupted: false };
          }
          if (data.method === "turn/interrupt" && turn !== null) {
            turn = { ...turn, interrupted: true };
          }
          continue;
        }
        // Responses and the server's own requests are the session's to read.
        if (frame.channel !== "stdout" || typeof data.method !== "string" || "id" in data) continue;
        for (const event of translator.translate(
          { method: data.method, params: data.params },
          turn,
        )) {
          if (event.type === "event.unmapped") unmapped.push(data.method);
          if (event.type === "turn.completed") turn = null;
        }
      }
      expect(unmapped.filter((method) => UNMAPPED_ON_PURPOSE[method] === undefined)).toEqual([]);
    },
  );
});
