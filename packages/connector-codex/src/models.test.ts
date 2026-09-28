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
    // The recorded catalogue offers a rung above `max` that Poseidon has no
    // name for; it is dropped, not guessed at.
    expect(
      toModelOptions([
        row({
          supportedReasoningEfforts: [
            { reasoningEffort: "ultra" },
            { reasoningEffort: "high" },
            { reasoningEffort: "low" },
          ],
        }),
      ])[0]?.efforts,
    ).toEqual(["low", "high"]);
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
