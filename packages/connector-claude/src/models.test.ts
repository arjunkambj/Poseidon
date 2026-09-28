/**
 * The model list against `fixtures/claude/probe/`: the CLI's own rows, read
 * off the real SDK handshake the recording replays.
 */

import * as NodeOS from "node:os";
import { describe, expect, it } from "@effect/vitest";
import { loadSdkStreamRecording } from "@poseidon/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";

import { replay } from "../test/replay";
import { childEnv } from "./env";
import { CLAUDE_KIND } from "./kind";
import {
  DEFAULT_MODEL,
  MODEL_FAMILY,
  sdkModelFor,
  toModelOptions,
  type ClaudeModelInfo,
} from "./models";
import { readInitialization } from "./probe";

/** The `models` of the recorded initialize response. */
const recordedModels = (): ReadonlyArray<ClaudeModelInfo> => {
  const handshake = loadSdkStreamRecording(CLAUDE_KIND, "probe").invocations.find((invocation) =>
    invocation.argv.includes("stream-json"),
  )!;
  const response = handshake.frames.find(
    (frame) => frame.dir === "from-harness" && typeof frame.data === "object",
  )!.data as { response: { response: { models: ReadonlyArray<ClaudeModelInfo> } } };
  return response.response.response.models;
};

describe("toModelOptions", () => {
  it("keeps the CLI's rows, names and order", () => {
    const options = toModelOptions(recordedModels());
    expect(options.map((option) => [option.id, option.label])).toEqual(
      recordedModels().map((info) => [info.value, info.displayName]),
    );
    expect(new Set(options.map((option) => option.family))).toEqual(new Set([MODEL_FAMILY]));
    expect(options[0]?.id).toBe(DEFAULT_MODEL);
  });

  it("carries each row's own description as secondary text", () => {
    const byId = new Map(toModelOptions(recordedModels()).map((option) => [option.id, option]));
    expect(byId.get("sonnet")?.label).toBe("Sonnet");
    expect(byId.get("sonnet")?.description).toBe(
      "Sonnet 5 · Efficient for routine tasks · $2/$10 per Mtok",
    );
    expect(byId.get(DEFAULT_MODEL)?.description).toBe(
      "Use the default model (currently Opus 5.5 (1M context)) · $4/$20 per Mtok",
    );
  });

  it("leaves an absent or blank description out", () => {
    const options = toModelOptions([
      { value: "a", displayName: "A" },
      { value: "b", displayName: "B", description: "" },
      { value: "c", displayName: "C", description: "  " },
    ]);
    expect(options.every((option) => !("description" in option))).toBe(true);
  });

  it("offers each model the effort rungs the CLI lists for it, lowest first", () => {
    const byId = new Map(toModelOptions(recordedModels()).map((option) => [option.id, option]));
    expect(byId.get("sonnet")?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // Haiku lists no effort levels: the picker offers none.
    expect(byId.get("haiku")?.efforts).toEqual([]);
  });
});

describe("sdkModelFor", () => {
  it("leaves the model out for the CLI's default and names any other", () => {
    expect(sdkModelFor(DEFAULT_MODEL)).toBeUndefined();
    expect(sdkModelFor("sonnet")).toBe("sonnet");
  });
});

describe("readInitialization", () => {
  it.effect("lists the models the handshake carried", () =>
    Effect.gen(function* () {
      const { binaryPath } = replay("probe");
      const listed = yield* readInitialization({
        binary: { command: binaryPath, display: binaryPath },
        env: childEnv(process.env, {}),
        cwd: NodeOS.tmpdir(),
      });
      expect(listed.models).toEqual(toModelOptions(recordedModels()));
      // The recorder scrubs the command list down to one entry.
      expect(listed.commands.map((command) => command.name)).toEqual(["scrubbed-entry"]);
      // Signed out, the handshake names no account.
      expect(listed.account).toBeUndefined();
    }),
  );
});
