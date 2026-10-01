import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { Effort } from "@poseidon/contracts/enums";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "vitest";

import {
  effortMenuEntries,
  effortMenuPatch,
  effortMenuValue,
  effortStepPatch,
  ULTRACODE_ENTRY,
  ULTRACODE_NOTE,
} from "./effort-menu";
import { EFFORT_NOTES } from "./efforts";
import { settleUltracode, ultracodeOfferedIn } from "./ultracode";

const id = (value: string) => value as ConnectorInstanceId;

// A harness that can switch ultracode, with an xhigh model and one without,
// beside one that cannot, whose model goes up to ultra.
const catalog = [
  {
    connector: { connectorInstanceId: id("ladder"), capabilities: {} },
    models: [{ id: "deep-ultra", efforts: ["high", "xhigh", "max", "ultra"] }],
  },
  {
    connector: { connectorInstanceId: id("workflows"), capabilities: { ultracode: true } },
    models: [
      { id: "deep", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "light", efforts: ["low", "medium", "high"] },
    ],
  },
] as unknown as ReadonlyArray<ConnectorModels>;

const ladderOf = (model: string): ReadonlyArray<Effort> =>
  catalog.flatMap((entry) => entry.models).find((option) => option.id === model)?.efforts ?? [];

/** The menu as the composer draws it for `model` under `instance`. */
const menu = (instance: string, model: string, on = false) =>
  effortMenuEntries(ladderOf(model), {
    offered: ultracodeOfferedIn(catalog, id(instance), model),
    on,
  });

const labels = (instance: string, model: string, on = false) =>
  menu(instance, model, on).map((entry) => entry.label);

describe("effortMenuEntries", () => {
  it("tops a model that can run ultracode with Ultracode and its cost note", () => {
    const entries = menu("workflows", "deep");
    expect(entries.map((entry) => entry.label)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "Ultracode",
    ]);
    expect(entries.at(-1)).toEqual({
      value: ULTRACODE_ENTRY,
      label: "Ultracode",
      description: ULTRACODE_NOTE,
    });
    expect(entries.slice(0, -1).every((entry) => entry.description === undefined)).toBe(true);
  });

  it("tops a model that lists ultra with Ultra, named and noted like Ultracode", () => {
    const entries = menu("ladder", "deep-ultra");
    expect(entries.map((entry) => entry.label)).toEqual(["high", "xhigh", "max", "Ultra"]);
    expect(entries.at(-1)).toEqual({
      value: "ultra",
      label: "Ultra",
      description: EFFORT_NOTES.ultra,
    });
    for (const note of [ULTRACODE_NOTE, EFFORT_NOTES.ultra]) {
      expect(note).toMatch(/^\w+ effort with .+ · uses many more tokens$/);
    }
  });

  it("offers neither on a model that has neither", () => {
    expect(labels("workflows", "light")).toEqual(["low", "medium", "high"]);
    expect(labels("ladder", "deep")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortMenuEntries(undefined, { offered: false, on: false })).not.toContainEqual(
      expect.objectContaining({ label: "Ultra" }),
    );
  });

  it("keeps Ultracode while it is on where it is not offered, so it can be turned off", () => {
    expect(labels("workflows", "light", true)).toEqual(["low", "medium", "high", "Ultracode"]);
  });
});

describe("effortMenuValue", () => {
  it("is the Ultracode entry while it is on, and the effort otherwise", () => {
    expect(effortMenuValue("xhigh", true)).toBe(ULTRACODE_ENTRY);
    expect(effortMenuValue("xhigh", false)).toBe("xhigh");
    expect(effortMenuValue("ultra", false)).toBe("ultra");
  });
});

describe("effortMenuPatch", () => {
  const settle = (patch: ReturnType<typeof effortMenuPatch>, on: boolean) =>
    settleUltracode(
      patch,
      on,
      (instance, model) => ultracodeOfferedIn(catalog, instance, model),
      id("workflows"),
    );

  it("switches ultracode on at xhigh", () => {
    expect(effortMenuPatch(ULTRACODE_ENTRY)).toEqual({ ultracode: true, effort: "xhigh" });
    expect(settle(effortMenuPatch(ULTRACODE_ENTRY), false)).toEqual({
      ultracode: true,
      effort: "xhigh",
    });
  });

  it("sends a rung's effort, and turns ultracode off once the row settles it", () => {
    expect(effortMenuPatch("ultra")).toEqual({ effort: "ultra" });
    expect(settle(effortMenuPatch("high"), false)).toEqual({ effort: "high" });
    expect(settle(effortMenuPatch("high"), true)).toEqual({ effort: "high", ultracode: false });
    expect(settle(effortMenuPatch("xhigh"), true)).toEqual({ effort: "xhigh", ultracode: false });
  });
});

describe("effortStepPatch", () => {
  const deep = ladderOf("deep");
  const ultra = ladderOf("deep-ultra");

  it("steps along the ladder and stops at either end", () => {
    expect(effortStepPatch("high", deep, false, 1)).toEqual({ effort: "xhigh" });
    expect(effortStepPatch("high", deep, false, -1)).toEqual({ effort: "medium" });
    expect(effortStepPatch("low", deep, false, -1)).toBeNull();
  });

  it("never steps onto Ultra or Ultracode", () => {
    expect(effortStepPatch("max", deep, false, 1)).toBeNull();
    expect(effortStepPatch("max", ultra, false, 1)).toBeNull();
    expect(effortStepPatch("ultra", ultra, false, -1)).toEqual({ effort: "max" });
  });

  it("stays at Ultracode on a step up, and turns it off with xhigh kept on a step down", () => {
    expect(effortStepPatch("xhigh", deep, true, 1)).toBeNull();
    expect(effortStepPatch("xhigh", deep, true, -1)).toEqual({ ultracode: false });
  });
});
