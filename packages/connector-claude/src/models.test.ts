/**
 * The model list against `fixtures/claude/probe/` (signed out) and
 * `fixtures/claude/probe-signed-in/`: the CLI's own rows, read off the real
 * SDK handshakes the recordings replay. The compiled-in list a signed-in CLI
 * answers with before its catalog has loaded is spelled out below as the
 * 2.1.286 handshake printed it with `CLAUDE_CODE_MODEL_CATALOG=0`.
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
  isCompiledList,
  MODEL_FAMILY,
  nameOfModelId,
  sdkModelFor,
  toModelOptions,
  type ClaudeModelInfo,
} from "./models";
import { readInitialization } from "./probe";

/** The `models` of a recorded initialize response. */
const recordedModels = (scenario = "probe"): ReadonlyArray<ClaudeModelInfo> => {
  const handshake = loadSdkStreamRecording(CLAUDE_KIND, scenario).invocations.find((invocation) =>
    invocation.argv.includes("stream-json"),
  )!;
  const response = handshake.frames.find(
    (frame) =>
      frame.dir === "from-harness" &&
      (frame.data as { type?: unknown } | null)?.type === "control_response",
  )!.data as { response: { response: { models: ReadonlyArray<ClaudeModelInfo> } } };
  return response.response.response.models;
};

/** The signed-in CLI's compiled-in list: five rows, no versions in the names. */
const COMPILED_SIGNED_IN: ReadonlyArray<ClaudeModelInfo> = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5 · Best for everyday, complex tasks",
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus",
    description: "Opus 5.5 · Best for everyday, complex tasks",
  },
  {
    value: "claude-fable-5-1[1m]",
    resolvedModel: "claude-fable-5-1",
    displayName: "Fable",
    description: "Fable 5.1 · Most capable for your hardest and longest-running tasks",
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet",
    description: "Sonnet 5.5 · Efficient for routine tasks",
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
];

const labels = (models: ReadonlyArray<ClaudeModelInfo>) =>
  toModelOptions(models).map((option) => [option.id, option.label]);

describe("toModelOptions", () => {
  it("keeps the CLI's rows, ids and order", () => {
    for (const scenario of ["probe", "probe-signed-in"]) {
      const options = toModelOptions(recordedModels(scenario));
      expect(options.map((option) => option.id)).toEqual(
        recordedModels(scenario).map((info) => info.value),
      );
      expect(new Set(options.map((option) => option.family))).toEqual(new Set([MODEL_FAMILY]));
      expect(options[0]?.id).toBe(DEFAULT_MODEL);
    }
  });

  it("keeps the catalog's versioned names and names what the default runs as", () => {
    expect(labels(recordedModels("probe-signed-in"))).toEqual([
      ["default", "Default (Opus 5.5)"],
      ["opus", "Opus 5.5"],
      ["claude-fable-5-1", "Fable 5.1"],
      ["sonnet", "Sonnet 5.5"],
      ["haiku", "Haiku 4.5"],
      ["claude-sonnet-5", "Sonnet 5"],
      ["claude-opus-5", "Opus 5"],
      ["claude-fable-5", "Fable 5"],
      ["claude-opus-4-8", "Opus 4.8"],
      ["claude-opus-4-7", "Opus 4.7"],
      ["claude-opus-4-6", "Opus 4.6"],
      ["claude-sonnet-4-6", "Sonnet 4.6"],
    ]);
  });

  it("gives the compiled-in list's names the version each row runs as", () => {
    expect(labels(COMPILED_SIGNED_IN)).toEqual([
      ["default", "Default (Opus 5.5)"],
      ["opus", "Opus 5.5"],
      ["claude-fable-5-1[1m]", "Fable 5.1 (1M context)"],
      ["sonnet", "Sonnet 5.5"],
      ["haiku", "Haiku 4.5"],
    ]);
    // Signed out: the version goes after the family, ahead of the context note,
    // and the default says it runs with a 1M context window, as its id does.
    expect(labels(recordedModels("probe"))).toEqual([
      ["default", "Default (Opus 5.5, 1M context)"],
      ["opus[1m]", "Opus 5.5 (1M context)"],
      ["claude-fable-5-1[1m]", "Fable 5.1 (1M context)"],
      ["sonnet", "Sonnet 5"],
      ["haiku", "Haiku 4.5"],
    ]);
  });

  it("reads the version off the description when a row has no resolvedModel", () => {
    // The shape of 2.1.150's list, which carries no `resolvedModel`.
    expect(
      labels([
        {
          value: "default",
          displayName: "Default (recommended)",
          description: "Use the default model (currently Opus 4.7 (1M context)) · $5/$25 per Mtok",
        },
        {
          value: "sonnet[1m]",
          displayName: "Sonnet (1M context)",
          description: "Sonnet 4.6 for long sessions · $3/$15 per Mtok",
        },
        { value: "custom", displayName: "Custom", description: "Something else" },
      ]),
    ).toEqual([
      ["default", "Default (Opus 4.7, 1M context)"],
      ["sonnet[1m]", "Sonnet 4.6 (1M context)"],
      ["custom", "Custom"],
    ]);
  });

  it("carries each row's own description, and the default's recommendation", () => {
    const byId = new Map(toModelOptions(recordedModels()).map((option) => [option.id, option]));
    expect(byId.get("sonnet")?.description).toBe(
      "Sonnet 5 · Efficient for routine tasks · $2/$10 per Mtok",
    );
    expect(byId.get(DEFAULT_MODEL)?.description).toBe(
      "Recommended · Use the default model (currently Opus 5.5 (1M context)) · $4/$20 per Mtok",
    );
    // A default the CLI does not call recommended keeps its description as is.
    const plain = toModelOptions([
      { value: "default", displayName: "Default", resolvedModel: "claude-opus-5-5" },
    ]);
    expect(plain[0]).toMatchObject({ label: "Default (Opus 5.5)" });
    expect(plain[0]).not.toHaveProperty("description");
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

describe("nameOfModelId", () => {
  it("spells a model id as its family and version", () => {
    expect(nameOfModelId("claude-opus-5-5")).toBe("Opus 5.5");
    expect(nameOfModelId("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(nameOfModelId("claude-fable-5-1")).toBe("Fable 5.1");
    expect(nameOfModelId("claude-opus-5-5[1m]")).toBe("Opus 5.5");
    expect(nameOfModelId("claude-sonnet-5")).toBe("Sonnet 5");
    expect(nameOfModelId("sonnet")).toBeUndefined();
  });
});

describe("isCompiledList", () => {
  it("tells the compiled-in list from the account's catalog", () => {
    expect(isCompiledList(COMPILED_SIGNED_IN)).toBe(true);
    expect(isCompiledList(recordedModels("probe"))).toBe(true);
    expect(isCompiledList(recordedModels("probe-signed-in"))).toBe(false);
    expect(isCompiledList([])).toBe(false);
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
