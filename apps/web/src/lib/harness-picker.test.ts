import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import type { ModelOption } from "@poseidon/contracts/connectors";
import { describe, expect, it } from "vitest";

import {
  effortSummary,
  harnessRail,
  initialPickerState,
  pickerKey,
  pickerReduce,
  searchModels,
  type PickerEvent,
  type PickerOptions,
  type PickerState,
  type PickerStep,
  type HarnessRailEntry,
} from "./harness-picker";
import { modelPickerGroups, type ModelPick } from "./model-picks";

const id = (value: string) => value as ConnectorInstanceId;

const model = (
  modelId: string,
  label: string,
  family: string,
  efforts: ModelOption["efforts"] = [],
): ModelOption => ({ id: modelId, label, family, efforts });

const group = (
  instanceId: string,
  displayName: string,
  models: ReadonlyArray<ModelOption>,
): ConnectorModels => ({
  connector: {
    connectorInstanceId: id(instanceId),
    kind: "harness",
    displayName,
    enabled: true,
    capabilities: null,
    extensions: { skills: false, plugins: false, mcpServers: false },
    probe: { status: "ready", probedAt: "2026-09-18T00:00:00.000Z" },
  },
  models,
});

// Two harnesses whose natural monograms collide, and a third.
const catalog = [
  group("a", "Comet Cloud", [
    model("swift-1", "Swift One", "swift", ["low", "medium", "high"]),
    model("deep-2", "Deep Two", "deep", ["high"]),
    model("plain", "Plain", "basic"),
  ]),
  group("b", "Cedar Cove", [
    model("cove-mini", "Cove Mini", "cove", ["minimal", "high"]),
    model("swiftness", "Mini Swift", "cove"),
  ]),
  group("c", "Corvid", [model("raven", "Raven", "birds")]),
];

const pick = (instanceId: string, modelId: string): ModelPick => ({
  connectorInstanceId: id(instanceId),
  model: modelId,
});

const railFor = (current: ModelPick | null, locked = false): ReadonlyArray<HarnessRailEntry> =>
  harnessRail(
    modelPickerGroups(catalog, { instanceId: current?.connectorInstanceId ?? null, locked }),
    current,
  );

const onA = pick("a", "deep-2");
const rail = railFor(onA);

const state = (patch: Partial<PickerState> = {}): PickerState => ({
  query: "",
  zone: "rail",
  harness: 0,
  model: 0,
  result: 0,
  ...patch,
});

const key = (type: string): PickerEvent => {
  const event = pickerKey(type);
  if (event === null) {
    throw new Error(`not a picker key: ${type}`);
  }
  return event;
};

/** Run keys from a state, answering the final step. */
const press = (
  from: PickerState,
  keys: ReadonlyArray<string | PickerEvent>,
  on: ReadonlyArray<HarnessRailEntry> = rail,
  options?: PickerOptions,
): PickerStep =>
  keys.reduce<PickerStep>(
    (step, next) =>
      pickerReduce(step.state, typeof next === "string" ? key(next) : next, on, options),
    { state: from, handled: false },
  );

describe("effortSummary", () => {
  it("names one rung, spans adjacent rungs and counts a ladder with gaps", () => {
    expect(effortSummary(undefined)).toBeUndefined();
    expect(effortSummary([])).toBeUndefined();
    expect(effortSummary(["high"])).toBe("high");
    expect(effortSummary(["high", "low", "medium"])).toBe("low–high");
    expect(effortSummary(["minimal", "high"])).toBe("2 levels");
  });
});

describe("harnessRail", () => {
  it("gives each harness a distinct monogram, its flags and its models", () => {
    expect(rail.map((entry) => [entry.label, entry.monogram, entry.current, entry.locked])).toEqual(
      [
        ["Comet Cloud", "Ct", true, false],
        ["Cedar Cove", "Ce", false, false],
        ["Corvid", "Cd", false, false],
      ],
    );
    expect(
      rail[0]?.items.map((item) => [item.label, item.description, item.efforts, item.current]),
    ).toEqual([
      ["Swift One", "swift", "low–high", false],
      ["Deep Two", "deep", "high", true],
      ["Plain", "basic", undefined, false],
    ]);
    expect(rail[1]?.items[0]?.pick).toEqual(pick("b", "cove-mini"));
  });

  it("marks the other harnesses locked on a thread that cannot switch", () => {
    const locked = railFor(onA, true);
    expect(locked.map((entry) => entry.locked)).toEqual([false, true, true]);
    expect(locked[1]?.items.every((item) => item.disabled)).toBe(true);
  });

  it("marks nothing current for a pick the rail does not list", () => {
    const stale = railFor(pick("gone", "old"));
    expect(stale.some((entry) => entry.current)).toBe(false);
    expect(stale.flatMap((entry) => entry.items).some((item) => item.current)).toBe(false);
  });
});

describe("searchModels", () => {
  const labels = (query: string) =>
    searchModels(rail, query).map(({ harnessIndex, item }) => `${harnessIndex}:${item.label}`);

  it("matches nothing for an empty or blank query", () => {
    expect(searchModels(rail, "")).toEqual([]);
    expect(searchModels(rail, "   ")).toEqual([]);
  });

  it("puts prefix matches first, then word starts, then rail order", () => {
    // "Swift One" starts its label with it, "Mini Swift" its id.
    expect(labels("  SWIFT ")).toEqual(["0:Swift One", "1:Mini Swift"]);
    // "Mini Swift" starts with it; "Cove Mini" has it at a word, though first on the rail.
    expect(labels("mini")).toEqual(["1:Mini Swift", "1:Cove Mini"]);
  });

  it("matches the id, the family and the harness name", () => {
    expect(labels("deep-2")).toEqual(["0:Deep Two"]);
    expect(labels("birds")).toEqual(["2:Raven"]);
    // A label match beats a family or harness-name match.
    expect(labels("co")).toEqual([
      "1:Cove Mini",
      "0:Swift One",
      "0:Deep Two",
      "0:Plain",
      "1:Mini Swift",
      "2:Raven",
    ]);
    expect(labels("orvi")).toEqual(["2:Raven"]);
  });
});

describe("initialPickerState", () => {
  it("opens on the current harness with its flyout on the current model", () => {
    expect(initialPickerState(rail, onA)).toEqual(state({ zone: "models", harness: 0, model: 1 }));
  });

  it("opens on the top of the current harness when it does not list the model", () => {
    expect(initialPickerState(rail, pick("b", "gone"))).toEqual(
      state({ zone: "models", harness: 1, model: 0 }),
    );
  });

  it("opens on the rail's first pickable harness when the current pick is missing", () => {
    const stale = pick("gone", "old");
    expect(initialPickerState(railFor(stale), stale)).toEqual(state());
    expect(initialPickerState(railFor(null), null)).toEqual(state());
    const locked = harnessRail(
      modelPickerGroups(catalog, { instanceId: id("gone"), locked: true }).map((entry, index) => ({
        ...entry,
        locked: index < 2,
      })),
      null,
    );
    expect(initialPickerState(locked, null)).toEqual(state({ harness: 2 }));
  });

  it("opens on an empty rail without a highlight to point at", () => {
    expect(initialPickerState([], onA)).toEqual(state());
  });
});

describe("pickerReduce on the rail", () => {
  it("moves down and up without wrapping, and the flyout follows", () => {
    const down = press(state({ harness: 1 }), ["ArrowDown"]);
    expect(down.state).toEqual(state({ harness: 2 }));
    expect(press(state({ harness: 2 }), ["ArrowDown"]).state).toEqual(state({ harness: 2 }));
    expect(press(state(), ["ArrowUp"]).state).toEqual(state());
    // Back onto the current harness, the flyout highlights the current model.
    expect(press(state({ harness: 1 }), ["ArrowUp"]).state).toEqual(
      state({ harness: 0, model: 1 }),
    );
  });

  it("jumps to either end with Home and End", () => {
    expect(press(state(), ["End"]).state.harness).toBe(2);
    expect(press(state({ harness: 2 }), ["Home"]).state).toEqual(state({ model: 1 }));
  });

  it("enters the flyout with Right or Enter, at the current model or the top", () => {
    expect(press(state({ model: 1 }), ["ArrowRight"])).toEqual({
      state: state({ zone: "models", model: 1 }),
      handled: true,
    });
    expect(press(state({ harness: 1 }), ["Enter"]).state).toEqual(
      state({ zone: "models", harness: 1, model: 0 }),
    );
    expect(press(state(), ["ArrowRight"]).effect).toBeUndefined();
  });

  it("does not enter a locked harness, nor leave the rail to the left", () => {
    const locked = railFor(onA, true);
    const on = state({ harness: 1 });
    expect(press(on, ["ArrowRight"], locked)).toEqual({ state: on, handled: true });
    expect(press(on, ["Enter"], locked)).toEqual({ state: on, handled: true });
    expect(press(on, ["ArrowLeft"]).state).toEqual(on);
  });

  it("walks past a locked harness so its flyout still says what exists", () => {
    const locked = railFor(onA, true);
    expect(press(state(), ["ArrowDown"], locked).state).toEqual(state({ harness: 1 }));
  });

  it("closes on Escape", () => {
    expect(press(state(), ["Escape"]).effect).toEqual({ type: "close" });
  });
});

describe("pickerReduce in a flyout", () => {
  const inA = state({ zone: "models" });

  it("moves through the models without wrapping, and to either end", () => {
    expect(press(inA, ["ArrowDown", "ArrowDown", "ArrowDown"]).state).toEqual(
      state({ zone: "models", model: 2 }),
    );
    expect(press(inA, ["ArrowUp"]).state).toEqual(inA);
    expect(press(inA, ["End"]).state.model).toBe(2);
    expect(press(state({ zone: "models", model: 2 }), ["Home"]).state.model).toBe(0);
    expect(press(inA, ["ArrowRight"]).state).toEqual(inA);
  });

  it("returns to the rail with Left or Escape", () => {
    expect(press(state({ zone: "models", model: 1 }), ["ArrowLeft"]).state).toEqual(
      state({ model: 1 }),
    );
    const escape = press(state({ zone: "models", model: 1 }), ["Escape"]);
    expect(escape.state).toEqual(state({ model: 1 }));
    expect(escape.effect).toBeUndefined();
  });

  it("picks the highlighted model with Enter", () => {
    expect(press(state({ zone: "models", harness: 1, model: 1 }), ["Enter"]).effect).toEqual({
      type: "pick",
      pick: pick("b", "swiftness"),
    });
  });

  it("ticks the model in compare mode and stays open", () => {
    const from = state({ zone: "models", harness: 2 });
    const step = press(from, ["Enter"], rail, { multi: true });
    expect(step).toEqual({
      state: from,
      handled: true,
      effect: { type: "toggle", pick: pick("c", "raven") },
    });
    // Ticking another carries on from where it was.
    const again = press(state({ zone: "models" }), ["Enter", "ArrowDown", "Enter"], rail, {
      multi: true,
    });
    expect(again.effect).toEqual({ type: "toggle", pick: pick("a", "deep-2") });
    expect(again.state).toEqual(state({ zone: "models", model: 1 }));
  });

  it("does nothing on Enter over a locked harness's model", () => {
    const locked = railFor(onA, true);
    const hovered = press(state({ harness: 1 }), [{ type: "hoverModel", index: 0 }], locked);
    expect(hovered.state).toEqual(state({ zone: "models", harness: 1 }));
    const enter = pickerReduce(hovered.state, key("Enter"), locked);
    expect(enter.effect).toBeUndefined();
    expect(enter.state).toEqual(hovered.state);
  });
});

describe("pickerReduce with hover", () => {
  it("opens a hovered harness's flyout on the rail", () => {
    expect(
      press(state({ zone: "models", model: 2 }), [{ type: "hoverHarness", index: 1 }]).state,
    ).toEqual(state({ harness: 1 }));
    // Back over the same harness keeps its highlighted row.
    expect(
      press(state({ zone: "models", model: 2 }), [{ type: "hoverHarness", index: 0 }]).state,
    ).toEqual(state({ model: 2 }));
    expect(press(state(), [{ type: "hoverHarness", index: 9 }])).toEqual({
      state: state(),
      handled: false,
    });
  });

  it("highlights a hovered row, or a hovered result while searching", () => {
    expect(press(state(), [{ type: "hoverModel", index: 2 }]).state).toEqual(
      state({ zone: "models", model: 2 }),
    );
    expect(press(state(), [{ type: "hoverModel", index: 5 }]).handled).toBe(false);
    const searching = state({ query: "mini" });
    expect(press(searching, [{ type: "hoverModel", index: 1 }]).state).toEqual(
      state({ query: "mini", result: 1 }),
    );
    expect(press(searching, [{ type: "hoverModel", index: 2 }]).handled).toBe(false);
  });
});

describe("pickerReduce with a query", () => {
  const typed = (text: string, from = state()) =>
    pickerReduce(from, { type: "setQuery", text }, rail).state;

  it("sets the query and highlights the first result", () => {
    expect(typed("co", state({ result: 3 }))).toEqual(state({ query: "co" }));
  });

  it("moves over the results across harnesses and picks the highlighted one", () => {
    const from = typed("co");
    const step = press(from, ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "Enter"]);
    expect(step.state.result).toBe(2);
    expect(step.effect).toEqual({ type: "pick", pick: pick("a", "deep-2") });
    expect(press(from, ["ArrowUp"]).state.result).toBe(0);
    expect(press(from, ["End", "End"]).handled).toBe(false);
    const last = press(
      from,
      Array.from({ length: 9 }, () => "ArrowDown"),
    );
    expect(last.state.result).toBe(5);
    // The rail's own position is left alone while searching.
    expect(last.state.zone).toBe("rail");
  });

  it("leaves Left, Right, Home and End to the text input", () => {
    for (const name of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      expect(press(typed("co"), [name])).toEqual({ state: typed("co"), handled: false });
    }
  });

  it("toggles a result in compare mode", () => {
    expect(press(typed("raven"), ["Enter"], rail, { multi: true }).effect).toEqual({
      type: "toggle",
      pick: pick("c", "raven"),
    });
  });

  it("does nothing on Enter over a locked result or with no results", () => {
    const locked = railFor(onA, true);
    const from = pickerReduce(state(), { type: "setQuery", text: "raven" }, locked).state;
    expect(pickerReduce(from, key("Enter"), locked).effect).toBeUndefined();
    const none = typed("zzz");
    expect(press(none, ["ArrowDown", "Enter"])).toEqual({ state: none, handled: true });
  });

  it("peels Escape one layer at a time: the query, the flyout, the picker", () => {
    const searching = typed("co", state({ zone: "models", model: 1 }));
    const first = press(searching, ["Escape"]);
    expect(first.effect).toEqual({ type: "clearQuery" });
    expect(first.state).toEqual(state({ zone: "models", model: 1 }));
    const second = pickerReduce(first.state, key("Escape"), rail);
    expect(second.effect).toBeUndefined();
    expect(second.state.zone).toBe("rail");
    expect(pickerReduce(second.state, key("Escape"), rail).effect).toEqual({ type: "close" });
  });

  it("clears a query of spaces before anything else, while keys still drive the rail", () => {
    const blank = typed("  ");
    expect(press(blank, ["ArrowDown"]).state.harness).toBe(1);
    expect(press(blank, ["Escape"]).effect).toEqual({ type: "clearQuery" });
  });
});

describe("pickerReduce on an empty rail", () => {
  it("moves nowhere, picks nothing and still closes", () => {
    const empty = initialPickerState([], null);
    for (const name of [
      "ArrowUp",
      "ArrowDown",
      "ArrowRight",
      "ArrowLeft",
      "Home",
      "End",
      "Enter",
    ]) {
      const step = press(empty, [name], []);
      expect(step.state).toEqual(empty);
      expect(step.effect).toBeUndefined();
    }
    expect(press(empty, [{ type: "hoverHarness", index: 0 }], []).handled).toBe(false);
    expect(press(empty, ["Escape"], []).effect).toEqual({ type: "close" });
    const searching = pickerReduce(empty, { type: "setQuery", text: "a" }, []).state;
    expect(press(searching, ["ArrowDown", "Enter"], []).effect).toBeUndefined();
  });
});

describe("pickerKey", () => {
  it("maps the picker's keys and leaves the rest alone", () => {
    expect(pickerKey("ArrowDown")).toEqual({ type: "ArrowDown" });
    expect(pickerKey("Escape")).toEqual({ type: "Escape" });
    expect(pickerKey("a")).toBeNull();
    expect(pickerKey("Tab")).toBeNull();
  });
});
