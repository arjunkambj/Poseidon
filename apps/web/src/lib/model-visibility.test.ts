import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import type { ModelOption } from "@poseidon/contracts/connectors";
import {
  DEFAULT_MODEL_PICKER_SETTINGS,
  type ModelPickerSettings,
} from "@poseidon/contracts/settings";
import { describe, expect, it } from "vitest";

import {
  enableAll,
  harnessOn,
  isLastVisible,
  isLastVisibleHarness,
  modelOn,
  resetVisibility,
  setHarness,
  setModel,
  visibleCatalog,
} from "./model-visibility";

const id = (value: string) => value as ConnectorInstanceId;

const model = (modelId: string, hidden?: boolean): ModelOption => ({
  id: modelId,
  label: modelId.toUpperCase(),
  family: "family",
  efforts: [],
  ...(hidden === undefined ? {} : { hidden }),
});

const group = (instanceId: string, models: ReadonlyArray<ModelOption>): ConnectorModels => ({
  connector: {
    connectorInstanceId: id(instanceId),
    kind: "harness",
    displayName: `Instance ${instanceId}`,
    enabled: true,
    capabilities: null,
    extensions: { skills: false, plugins: false, mcpServers: false },
    probe: { status: "ready", probedAt: "2026-09-18T00:00:00.000Z" },
  },
  models,
});

const catalog = [
  group("a", [model("m1"), model("m2"), model("secret", true)]),
  group("b", [model("m1"), model("m3")]),
];

const none = DEFAULT_MODEL_PICKER_SETTINGS;

/** The catalog as `instance:model` strings, for short assertions. */
const flat = (groups: ReadonlyArray<ConnectorModels>) =>
  groups.flatMap(({ connector, models }) =>
    models.map((entry) => `${connector.connectorInstanceId}:${entry.id}`),
  );

describe("harnessOn / modelOn", () => {
  it("has every harness on and every model on unless its connector hides it", () => {
    expect(harnessOn(none, "a")).toBe(true);
    expect(modelOn(none, "a", model("m1"))).toBe(true);
    expect(modelOn(none, "a", model("m1", false))).toBe(true);
    expect(modelOn(none, "a", model("secret", true))).toBe(false);
  });

  it("follows a stored switch over the default", () => {
    const prefs = setModel(
      setModel(setHarness(none, "a", false), "a", "secret", true),
      "b",
      "m1",
      false,
    );
    expect(harnessOn(prefs, "a")).toBe(false);
    expect(modelOn(prefs, "a", model("secret", true))).toBe(true);
    expect(modelOn(prefs, "b", model("m1"))).toBe(false);
    // The switch is per instance: the same id under another instance is untouched.
    expect(modelOn(prefs, "a", model("m1"))).toBe(true);
  });

  it("does not read an inherited key as a switch", () => {
    expect(harnessOn(none, "constructor")).toBe(true);
    expect(modelOn(none, "constructor", model("toString"))).toBe(true);
  });
});

describe("visibleCatalog", () => {
  it("leaves out only what the connector hides by default", () => {
    expect(flat(visibleCatalog(catalog, none, null))).toEqual(["a:m1", "a:m2", "b:m1", "b:m3"]);
  });

  it("offers a hidden model once it is switched on", () => {
    const prefs = setModel(none, "a", "secret", true);
    expect(flat(visibleCatalog(catalog, prefs, null))).toContain("a:secret");
  });

  it("drops a harness that is off", () => {
    const visible = visibleCatalog(catalog, setHarness(none, "a", false), null);
    expect(visible.map(({ connector }) => connector.connectorInstanceId)).toEqual(["b"]);
  });

  it("drops a model that is off and an instance left with none", () => {
    const prefs = setModel(setModel(none, "b", "m1", false), "b", "m3", false);
    expect(flat(visibleCatalog(catalog, setModel(none, "a", "m2", false), null))).toEqual([
      "a:m1",
      "b:m1",
      "b:m3",
    ]);
    expect(
      visibleCatalog(catalog, prefs, null).map((g) => g.connector.connectorInstanceId),
    ).toEqual(["a"]);
  });

  it("returns an unfiltered instance as it came", () => {
    const [, b] = visibleCatalog(catalog, none, null);
    expect(b).toBe(catalog[1]);
  });

  it("keeps the current pick's harness when that harness is off", () => {
    const prefs = setHarness(none, "b", false);
    const keep = { connectorInstanceId: id("b"), model: "m3" };
    expect(flat(visibleCatalog(catalog, prefs, keep))).toEqual(["a:m1", "a:m2", "b:m1", "b:m3"]);
  });

  it("keeps the current pick's model when that model is off", () => {
    const prefs = setModel(setModel(none, "b", "m1", false), "b", "m3", false);
    const keep = { connectorInstanceId: id("b"), model: "m3" };
    expect(flat(visibleCatalog(catalog, prefs, keep))).toEqual(["a:m1", "a:m2", "b:m3"]);
    // A hidden model a thread is on is kept too.
    const onSecret = { connectorInstanceId: id("a"), model: "secret" };
    expect(flat(visibleCatalog(catalog, none, onSecret))).toContain("a:secret");
  });

  it("keeps the current pick's instance even with nothing left to list", () => {
    const prefs = setHarness(
      setModel(setModel(none, "b", "m1", false), "b", "m3", false),
      "b",
      false,
    );
    const keep = { connectorInstanceId: id("b"), model: "gone" };
    const visible = visibleCatalog(catalog, prefs, keep);
    expect(visible.map(({ connector }) => connector.connectorInstanceId)).toEqual(["a", "b"]);
    expect(visible[1]?.models).toEqual([]);
  });

  it("keeps nothing extra for a pick with no instance", () => {
    const keep = { connectorInstanceId: null, model: "secret" };
    expect(flat(visibleCatalog(catalog, none, keep))).not.toContain("a:secret");
  });
});

describe("enableAll / resetVisibility", () => {
  it("switches every harness and model on, hidden ones included", () => {
    const all = enableAll(catalog);
    expect(all).toEqual({
      harnesses: { a: true, b: true },
      models: { a: { m1: true, m2: true, secret: true }, b: { m1: true, m3: true } },
    });
    expect(flat(visibleCatalog(catalog, all, null))).toEqual([
      "a:m1",
      "a:m2",
      "a:secret",
      "b:m1",
      "b:m3",
    ]);
  });

  it("resets to no switches, so the connector's hidden flag applies again", () => {
    const reset = resetVisibility();
    expect(reset).toEqual({ harnesses: {}, models: {} });
    expect(reset).not.toBe(DEFAULT_MODEL_PICKER_SETTINGS);
    expect(flat(visibleCatalog(catalog, reset, null))).not.toContain("a:secret");
  });
});

describe("setHarness / setModel", () => {
  it("returns new switches and leaves the old ones untouched", () => {
    const before: ModelPickerSettings = { harnesses: { a: true }, models: { a: { m1: false } } };
    const after = setModel(setHarness(before, "b", false), "a", "m2", false);
    expect(after).toEqual({
      harnesses: { a: true, b: false },
      models: { a: { m1: false, m2: false } },
    });
    expect(before).toEqual({ harnesses: { a: true }, models: { a: { m1: false } } });
  });
});

describe("isLastVisible / isLastVisibleHarness", () => {
  const single = setModel(
    setModel(setHarness(none, "b", false), "a", "m2", false),
    "a",
    "secret",
    false,
  );

  it("names the only model any picker still offers", () => {
    expect(isLastVisible(catalog, single, "a", "m1")).toBe(true);
    expect(isLastVisible(catalog, single, "b", "m1")).toBe(false);
    expect(isLastVisible(catalog, none, "a", "m1")).toBe(false);
  });

  it("names the only harness with a model left", () => {
    expect(isLastVisibleHarness(catalog, setHarness(none, "b", false), "a")).toBe(true);
    expect(isLastVisibleHarness(catalog, none, "a")).toBe(false);
    expect(isLastVisibleHarness([], none, "a")).toBe(false);
  });
});
