import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ModelOption } from "@poseidon/contracts/connectors";
import type { WritingModel } from "@poseidon/contracts/generation";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import type { ConnectorCapabilities } from "@poseidon/contracts/runtime";
import { DEFAULT_MODEL_PICKER_SETTINGS } from "@poseidon/contracts/settings";
import { describe, expect, it } from "vitest";

import { encodeModelPick } from "@/lib/model-picks";
import { setHarness, setModel } from "@/lib/model-visibility";

import {
  SAME_AS_THREAD,
  writingModelGroups,
  writingModelLabel,
  writingModelOf,
  writingModelValue,
} from "./writing-model-options";

const id = (value: string) => value as ConnectorInstanceId;

const capabilities = (textGeneration: boolean | undefined): ConnectorCapabilities => ({
  modelSwitch: "per-turn",
  effortSwitch: "per-turn",
  steering: false,
  planMode: false,
  subagents: false,
  images: false,
  resume: false,
  fork: false,
  interrupt: "turn",
  rollback: false,
  compaction: false,
  questions: false,
  runtimeModes: [],
  attachments: "images",
  ...(textGeneration === undefined ? {} : { textGeneration }),
});

const model = (modelId: string, hidden?: boolean): ModelOption => ({
  id: modelId,
  label: modelId.toUpperCase(),
  family: "family",
  efforts: [],
  ...(hidden === undefined ? {} : { hidden }),
});

const group = (
  instanceId: string,
  textGeneration: boolean | undefined,
  models: ReadonlyArray<ModelOption>,
): ConnectorModels => ({
  connector: {
    connectorInstanceId: id(instanceId),
    kind: "harness",
    displayName: `Harness ${instanceId}`,
    enabled: true,
    capabilities: capabilities(textGeneration),
    extensions: { skills: false, plugins: false, mcpServers: false },
    probe: { status: "ready", probedAt: "2026-09-28T00:00:00.000Z" },
  },
  models,
});

const catalog = [
  group("writer", true, [model("w1"), model("w2"), model("secret", true)]),
  group("mute", false, [model("m1")]),
  group("old", undefined, [model("o1")]),
  group("other", true, [model("x1")]),
];

const none = DEFAULT_MODEL_PICKER_SETTINGS;

const flat = (groups: ReturnType<typeof writingModelGroups>) =>
  groups.flatMap((entry) =>
    entry.items.map((item) => `${entry.connectorInstanceId}:${item.label}`),
  );

const pick = (instanceId: string, modelId: string): WritingModel => ({
  connectorInstanceId: id(instanceId),
  model: modelId,
});

describe("writingModelGroups", () => {
  it("offers only harnesses that can write, and their models that are on", () => {
    expect(flat(writingModelGroups(catalog, none, null))).toEqual([
      "writer:W1",
      "writer:W2",
      "other:X1",
    ]);
  });

  it("leaves out a switched-off harness and a switched-off model", () => {
    const prefs = setModel(setHarness(none, "other", false), "writer", "w2", false);
    expect(flat(writingModelGroups(catalog, prefs, null))).toEqual(["writer:W1"]);
  });

  it("keeps the saved pick even when it is switched off", () => {
    const prefs = setHarness(setModel(none, "writer", "w2", false), "other", false);
    expect(flat(writingModelGroups(catalog, prefs, pick("writer", "w2")))).toEqual([
      "writer:W1",
      "writer:W2",
    ]);
    expect(flat(writingModelGroups(catalog, prefs, pick("other", "x1")))).toEqual([
      "writer:W1",
      "other:X1",
    ]);
  });

  it("names each group by its harness and encodes each item as a pick", () => {
    const [first] = writingModelGroups(catalog, none, null);
    expect(first?.displayName).toBe("Harness writer");
    expect(first?.items[0]?.value).toBe(encodeModelPick(pick("writer", "w1")));
  });
});

describe("writing model values", () => {
  it("round-trips Same as the thread and a pick", () => {
    expect(writingModelValue(null)).toBe(SAME_AS_THREAD);
    expect(writingModelOf(SAME_AS_THREAD)).toBeNull();
    expect(writingModelOf(writingModelValue(pick("writer", "w1")))).toEqual(pick("writer", "w1"));
  });

  it("refuses a value that is not a pick under a harness", () => {
    expect(writingModelOf("nonsense")).toBeUndefined();
    expect(writingModelOf(encodeModelPick({ connectorInstanceId: null, model: "w1" }))).toBe(
      undefined,
    );
  });

  it("reads the model's label, its id while unlisted, and Same as the thread", () => {
    const groups = writingModelGroups(catalog, none, null);
    expect(writingModelLabel(groups, writingModelValue(pick("writer", "w2")))).toBe("W2");
    expect(writingModelLabel(groups, writingModelValue(pick("gone", "g1")))).toBe("g1");
    expect(writingModelLabel(groups, SAME_AS_THREAD)).toBe("Same as the thread");
  });
});
