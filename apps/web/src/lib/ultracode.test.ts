import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { Effort } from "@poseidon/contracts/enums";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import type { ConnectorCapabilities } from "@poseidon/contracts/runtime";
import { describe, expect, it } from "vitest";

import {
  settleUltracode,
  ULTRACODE_OFF_TOOLTIP,
  ULTRACODE_ON_TOOLTIP,
  ultracodeOffered,
  ultracodeOfferedIn,
  ultracodePatch,
} from "./ultracode";

const id = (value: string) => value as ConnectorInstanceId;

const model = (modelId: string, efforts: ReadonlyArray<Effort>) => ({
  id: modelId,
  label: modelId,
  family: "Models",
  efforts,
});

const entry = (
  instance: string,
  capabilities: Partial<ConnectorCapabilities> | null,
  models: ReadonlyArray<ReturnType<typeof model>>,
): ConnectorModels =>
  ({
    connector: {
      connectorInstanceId: id(instance),
      capabilities: capabilities as ConnectorCapabilities | null,
    },
    models,
  }) as unknown as ConnectorModels;

/** One instance per harness, with the ladders their probes report. */
const ULTRACODE_CATALOG: ReadonlyArray<ConnectorModels> = [
  entry("ladder", { subagents: false }, [
    model("deep-ultra", ["low", "medium", "high", "xhigh", "ultra"]),
  ]),
  entry("plain", {}, [model("plain-xhigh", ["low", "medium", "high", "xhigh"])]),
  entry("workflows", { ultracode: true }, [
    model("deep", ["low", "medium", "high", "xhigh", "max"]),
    model("light", ["low", "medium", "high"]),
  ]),
];

describe("ultracodeOffered", () => {
  it("needs the harness to say so and the model to have an xhigh rung", () => {
    const xhigh = model("m", ["high", "xhigh"]);
    expect(ultracodeOffered({ ultracode: true } as ConnectorCapabilities, xhigh)).toBe(true);
    expect(
      ultracodeOffered({ ultracode: true } as ConnectorCapabilities, model("m", ["high"])),
    ).toBe(false);
    expect(ultracodeOffered({ ultracode: false } as ConnectorCapabilities, xhigh)).toBe(false);
    expect(ultracodeOffered({} as ConnectorCapabilities, xhigh)).toBe(false);
    expect(ultracodeOffered(null, xhigh)).toBe(false);
    expect(ultracodeOffered({ ultracode: true } as ConnectorCapabilities, undefined)).toBe(false);
  });
});

describe("ultracodeOfferedIn", () => {
  it("is offered on a model with xhigh, under a harness that can switch it", () => {
    expect(ultracodeOfferedIn(ULTRACODE_CATALOG, id("workflows"), "deep")).toBe(true);
    expect(ultracodeOfferedIn(ULTRACODE_CATALOG, id("workflows"), "light")).toBe(false);
    expect(ultracodeOfferedIn(ULTRACODE_CATALOG, id("workflows"), undefined)).toBe(false);
  });

  it("is never offered under a harness that cannot, even on an xhigh or ultra model", () => {
    expect(ultracodeOfferedIn(ULTRACODE_CATALOG, id("ladder"), "deep-ultra")).toBe(false);
    expect(ultracodeOfferedIn(ULTRACODE_CATALOG, id("plain"), "plain-xhigh")).toBe(false);
    expect(ultracodeOfferedIn(ULTRACODE_CATALOG, null, "deep")).toBe(false);
  });
});

describe("ultracodePatch", () => {
  it("switches on at xhigh, and off with the effort kept", () => {
    expect(ultracodePatch(true)).toEqual({ ultracode: true, effort: "xhigh" });
    expect(ultracodePatch(false)).toEqual({ ultracode: false });
  });
});

describe("the tooltips", () => {
  it("name the cost while off, and the way out while on", () => {
    expect(ULTRACODE_OFF_TOOLTIP).toContain("xhigh effort with multi-agent workflows");
    expect(ULTRACODE_OFF_TOOLTIP).toContain("uses many more tokens");
    expect(ULTRACODE_ON_TOOLTIP).toBe("Turn off ultracode");
  });
});

describe("settleUltracode", () => {
  const offeredOn = (instance: ConnectorInstanceId | null, modelId: string) =>
    ultracodeOfferedIn(ULTRACODE_CATALOG, instance, modelId);
  const settle = (patch: Parameters<typeof settleUltracode>[0], on = true) =>
    settleUltracode(patch, on, offeredOn, id("workflows"));

  it("leaves every patch alone while ultracode is off", () => {
    expect(settle({ effort: "low" }, false)).toEqual({ effort: "low" });
    expect(settle({ model: "light" }, false)).toEqual({ model: "light" });
  });

  it("turns ultracode off with an effort pick, xhigh included", () => {
    expect(settle({ effort: "low" })).toEqual({ effort: "low", ultracode: false });
    expect(settle({ effort: "xhigh" })).toEqual({ effort: "xhigh", ultracode: false });
  });

  it("turns it off for a model that cannot run it, and keeps it for one that can", () => {
    expect(settle({ model: "light" })).toEqual({ model: "light", ultracode: false });
    expect(settle({ model: "deep" })).toEqual({ model: "deep" });
    expect(settle({ model: "deep-ultra", connectorInstanceId: id("ladder") })).toEqual({
      model: "deep-ultra",
      connectorInstanceId: "ladder",
      ultracode: false,
    });
  });

  it("keeps a patch that names ultracode itself, and one that touches neither", () => {
    expect(settle(ultracodePatch(false))).toEqual({ ultracode: false });
    expect(settle({ runtimeMode: "full-access" })).toEqual({ runtimeMode: "full-access" });
    expect(settle({ interactionMode: "plan" })).toEqual({ interactionMode: "plan" });
  });
});
