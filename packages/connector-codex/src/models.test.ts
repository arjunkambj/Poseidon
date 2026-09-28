/**
 * The model list against `fixtures/codex/probe/`: the catalogue the real
 * app-server's `model/list` answered, decoded through the connector's own
 * schema.
 */

import { describe, expect, it } from "@effect/vitest";
import { loadStdioJsonRpcRecording } from "@poseidon/testkit/stdioJsonRpcRecording";
import * as Schema from "effect/Schema";

import { CODEX_KIND } from "./kind";
import { MODEL_FAMILY, toModelOptions } from "./models";
import { ModelListResponse, type CodexModel } from "./protocol";

/** The rows of the recorded `model/list` response. */
const recordedRows = (): ReadonlyArray<CodexModel> => {
  const handshake = loadStdioJsonRpcRecording(CODEX_KIND, "probe").invocations.find((invocation) =>
    invocation.argv.includes("app-server"),
  )!;
  const request = handshake.frames.find(
    (frame) => (frame.data as { method?: string }).method === "model/list",
  )!.data as { id: number };
  const response = handshake.frames.find(
    (frame) =>
      frame.dir === "from-harness" &&
      (frame.data as { id?: number; result?: unknown }).id === request.id,
  )!.data as { result: unknown };
  return Schema.decodeUnknownSync(ModelListResponse)(response.result).data;
};

const row = (overrides: Partial<CodexModel>): CodexModel => ({
  model: "m",
  displayName: "M",
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: "medium",
  inputModalities: ["text"],
  isDefault: false,
  ...overrides,
});

describe("toModelOptions", () => {
  it("keeps the catalogue's rows and names, the default first, all under one family", () => {
    const rows = recordedRows();
    const options = toModelOptions(rows);
    expect(options.length).toBeGreaterThan(0);
    const byDefault = rows.toSorted((a, b) => Number(b.isDefault) - Number(a.isDefault));
    expect(options.map((option) => [option.id, option.label])).toEqual(
      byDefault.filter((model) => !model.hidden).map((model) => [model.model, model.displayName]),
    );
    expect(options[0]?.id).toBe(rows.find((model) => model.isDefault)?.model);
    expect(new Set(options.map((option) => option.family))).toEqual(new Set([MODEL_FAMILY]));
  });

  it("offers each model the effort rungs Poseidon knows, lowest first", () => {
    const rows = recordedRows();
    for (const option of toModelOptions(rows)) {
      const offered = rows
        .find((model) => model.model === option.id)!
        .supportedReasoningEfforts.map((effort) => effort.reasoningEffort);
      expect(option.efforts.length).toBeGreaterThan(0);
      expect(option.efforts.every((effort) => offered.includes(effort))).toBe(true);
    }
    // `ultra`, the recorded catalogue's rung above `max`, is one Poseidon
    // names; a rung it has no name for is dropped, not guessed at.
    expect(
      toModelOptions([
        row({
          supportedReasoningEfforts: [
            { reasoningEffort: "ultra" },
            { reasoningEffort: "turbo" },
            { reasoningEffort: "high" },
            { reasoningEffort: "low" },
          ],
        }),
      ])[0]?.efforts,
    ).toEqual(["low", "high", "ultra"]);
  });

  it("carries each row's own description as secondary text", () => {
    const byId = new Map(toModelOptions(recordedRows()).map((option) => [option.id, option]));
    expect(byId.get("gpt-6-astra")?.label).toBe("GPT-6-Astra");
    expect(byId.get("gpt-6-astra")?.description).toBe(
      "Frontier intelligence for the most demanding work.",
    );
  });

  it("leaves an absent or blank description out", () => {
    const options = toModelOptions([
      row({ model: "a" }),
      row({ model: "b", description: "" }),
      row({ model: "c", description: "  " }),
    ]);
    expect(options).toHaveLength(3);
    expect(options.every((option) => !("description" in option))).toBe(true);
    // An app-server that sends no description still decodes.
    const { description: _omitted, ...bare } = recordedRows()[0]!;
    expect(
      Schema.decodeUnknownSync(ModelListResponse)({ data: [bare], nextCursor: null }).data[0],
    ).toEqual(bare);
  });

  it("offers ultra only on the models whose model/list row lists it", () => {
    const withUltra = toModelOptions(recordedRows())
      .filter((option) => option.efforts.includes("ultra"))
      .map((option) => option.id);
    // The recorded catalogue lists ultra ("Maximum reasoning with automatic
    // task delegation") on these four, and not on the luna models or gpt-5.5.
    expect(withUltra.toSorted()).toEqual(
      ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-sol"].toSorted(),
    );
    for (const option of toModelOptions(recordedRows())) {
      if (option.efforts.includes("ultra")) expect(option.efforts.at(-1)).toBe("ultra");
    }
  });

  it("reads vision off the input modalities", () => {
    expect(toModelOptions(recordedRows()).every((option) => option.vision === true)).toBe(true);
    expect(toModelOptions([row({ inputModalities: ["text"] })])[0]?.vision).toBe(false);
  });

  it("leaves hidden rows out and falls back to the id for a missing name", () => {
    expect(
      toModelOptions([
        row({ model: "shown", displayName: "" }),
        row({ model: "secret", hidden: true }),
      ]).map((option) => [option.id, option.label]),
    ).toEqual([["shown", "shown"]]);
  });
});
