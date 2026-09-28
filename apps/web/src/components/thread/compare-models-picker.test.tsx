import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ModelOption } from "@poseidon/contracts/connectors";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import { TooltipProvider } from "@poseidon/ui/components/tooltip";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { HarnessPicker } from "@/components/model-picker/harness-picker";
import { keyStep } from "@/components/model-picker/picker-keys";
import {
  compareMenuGroups,
  CompareModelsBody,
  CompareModelsPicker,
  compareRail,
  CompareModelsToggle,
  comparePicker,
} from "@/components/thread/compare-models-picker";
import { compareRefusal } from "@/components/thread/fan-out-plan";
import type { CompareModels } from "@/components/thread/use-compare-models";
import { initialPickerState } from "@/lib/harness-picker";
import { encodeModelPick, type ModelPick } from "@/lib/model-picks";

const id = (value: string) => value as ConnectorInstanceId;

const model = (modelId: string): ModelOption => ({
  id: modelId,
  label: modelId.toUpperCase(),
  family: "family",
  efforts: [],
});

const group = (instanceId: string, models: ReadonlyArray<string>): ConnectorModels => ({
  connector: {
    connectorInstanceId: id(instanceId),
    kind: "harness",
    displayName: `Instance ${instanceId}`,
    enabled: true,
    capabilities: null,
    extensions: { skills: false, plugins: false, mcpServers: false },
    probe: { status: "ready", probedAt: "2026-09-18T00:00:00.000Z" },
  },
  models: models.map(model),
});

// Five models over two instances; one id listed under both.
const catalog = [group("a", ["m1", "m2", "m3"]), group("b", ["m1", "m4"])];

const pick = (instance: string, modelId: string): ModelPick => ({
  connectorInstanceId: id(instance),
  model: modelId,
});

const fourPicks = [pick("a", "m1"), pick("a", "m2"), pick("a", "m3"), pick("b", "m1")];

const NOT_GIT = compareRefusal({ worktreeAllowed: false, pickCount: 0 });

const toggle = (compare: Pick<CompareModels, "enabled" | "setEnabled" | "unavailable">) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <CompareModelsToggle compare={compare} />
    </TooltipProvider>,
  );

const body = (picks: ReadonlyArray<ModelPick>) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <CompareModelsBody
        catalog={catalog}
        full={catalog}
        empty={{ title: "No models", description: "None." }}
        picks={picks}
        onToggle={() => {}}
        onClose={() => {}}
      />
    </TooltipProvider>,
  );

/** The rendered checkboxes' `aria-checked` and `data-disabled`, in order. */
const checkboxes = (markup: string) =>
  [...markup.matchAll(/<(?:span|button)[^>]*role="checkbox"[^>]*>/g)].map(([tag]) => ({
    checked: tag.includes('aria-checked="true"'),
    disabled: tag.includes("data-disabled"),
  }));

describe("CompareModelsToggle", () => {
  it("is disabled on a project that is not a git repository, and says why", () => {
    const markup = toggle({ enabled: false, setEnabled: () => {}, unavailable: NOT_GIT });
    expect(NOT_GIT).not.toBeNull();
    expect(markup).toContain('aria-label="Compare models"');
    expect(markup).toContain(`disabled=""`);
    expect(markup).toContain(`aria-description="${NOT_GIT}"`);
  });

  it("is a pressed switch in a repository", () => {
    const off = toggle({ enabled: false, setEnabled: () => {}, unavailable: null });
    expect(off).not.toContain(`disabled=""`);
    expect(off).toContain('aria-pressed="false"');
    const on = toggle({ enabled: true, setEnabled: () => {}, unavailable: null });
    expect(on).toContain('aria-pressed="true"');
  });
});

describe("compareMenuGroups", () => {
  it("groups the models by instance and ticks the picks, one instance apart from another", () => {
    const rows = compareMenuGroups(catalog, [pick("b", "m1")]);
    expect(rows.map((row) => row.connector.connectorInstanceId)).toEqual(["a", "b"]);
    expect(rows[0]?.items.map((item) => item.checked)).toEqual([false, false, false]);
    expect(rows[1]?.items.map((item) => item.checked)).toEqual([true, false]);
    expect(rows.flatMap((row) => row.items).every((item) => !item.disabled)).toBe(true);
  });

  it("disables only the unticked models once four are picked", () => {
    const items = compareMenuGroups(catalog, fourPicks).flatMap((row) => row.items);
    expect(items.filter((item) => item.disabled).map((item) => item.pick)).toEqual([
      pick("b", "m4"),
    ]);
  });
});

describe("compareRail", () => {
  it("puts every model on the harness rail, ticked by the picks, with nothing locked", () => {
    const { rail, checked } = compareRail(catalog, [pick("b", "m1")]);
    expect(rail.map((entry) => entry.instanceId)).toEqual(["a", "b"]);
    expect(rail.some((entry) => entry.locked || entry.current)).toBe(false);
    expect([...checked]).toEqual([encodeModelPick(pick("b", "m1"))]);
    expect(rail.flatMap((entry) => entry.items).every((item) => !item.disabled)).toBe(true);
  });

  it("carries each harness's iconKey for its avatar", () => {
    const keyed = compareRail(catalog, [], catalog, new Map([["harness", "logo-key"]])).rail;
    expect(keyed.map((entry) => entry.iconKey)).toEqual(["logo-key", "logo-key"]);
    expect(compareRail(catalog, []).rail.some((entry) => "iconKey" in entry)).toBe(false);
  });

  it("disables only the unticked models once four are picked", () => {
    const { rail, checked } = compareRail(catalog, fourPicks);
    expect(checked.size).toBe(4);
    const disabled = rail.flatMap((entry) => entry.items).filter((item) => item.disabled);
    expect(disabled.map((item) => item.pick)).toEqual([pick("b", "m4")]);
  });
});

describe("CompareModelsBody", () => {
  it("draws the harness avatars and a checkbox on every model in their flyouts, with the limit", () => {
    const markup = body([pick("a", "m2")]);
    expect(markup).toContain('aria-label="Harnesses"');
    expect(markup).toContain('aria-label="Instance a models"');
    expect(markup).toContain('aria-label="Instance b models"');
    const boxes = checkboxes(markup);
    expect(boxes).toHaveLength(5);
    expect(boxes.map((box) => box.checked)).toEqual([false, true, false, false, false]);
    expect(boxes.some((box) => box.disabled)).toBe(false);
    expect(markup.match(/role="option"[^>]*aria-checked="true"/g)).toHaveLength(1);
    expect(markup).toContain("Up to 4 models");
  });

  it("disables the fifth checkbox while four are picked", () => {
    const boxes = checkboxes(body(fourPicks));
    expect(boxes.filter((box) => box.checked)).toHaveLength(4);
    expect(boxes.map((box) => box.disabled)).toEqual([false, false, false, false, true]);
  });

  it("hands a tick to the toggle and keeps the picker open", () => {
    const onToggle = vi.fn<(pick: ModelPick) => void>();
    const drawn = CompareModelsBody({
      catalog,
      full: catalog,
      empty: { title: "No models", description: "None." },
      picks: [],
      onToggle,
      onClose: () => {},
    });
    const picker = (drawn.props as { children: ReadonlyArray<React.ReactElement> }).children[0];
    expect(picker?.type).toBe(HarnessPicker);
    const props = picker?.props as React.ComponentProps<typeof HarnessPicker>;
    expect(props.checked).toBeDefined();
    props.onPick(pick("b", "m1"));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(pick("b", "m1"));

    // Enter on a flyout row ticks it: the step toggles and never closes.
    const { rail } = compareRail(catalog, []);
    const start = initialPickerState(rail, pick("b", "m1"));
    const step = keyStep("Enter", start, rail, { multi: true });
    expect(step?.effect).toEqual({ type: "toggle", pick: pick("b", "m1") });
  });

  it("will not tick a model past the cap from the keyboard", () => {
    const { rail } = compareRail(catalog, fourPicks);
    const onM4 = initialPickerState(rail, pick("b", "m4"));
    const step = keyStep("Enter", onM4, rail, { multi: true });
    expect(step?.effect).toBeUndefined();
    expect(step?.handled).toBe(true);
  });
});

describe("comparePicker", () => {
  it("leaves the model picker in place while the mode is off", () => {
    const off: CompareModels = {
      enabled: false,
      setEnabled: () => {},
      picks: [],
      toggle: () => {},
      refusal: null,
      unavailable: null,
      plan: () => [],
    };
    expect(comparePicker(off, catalog)).toBeUndefined();
    expect(comparePicker({ ...off, enabled: true }, catalog)).toBeDefined();
  });

  it("hands the model picker's open state to the compare picker, so Choose model opens it", () => {
    const on: CompareModels = {
      enabled: true,
      setEnabled: () => {},
      picks: [],
      toggle: () => {},
      refusal: null,
      unavailable: null,
      plan: () => [],
    };
    const onOpenChange = vi.fn();
    const drawn = comparePicker(on, catalog)?.({ open: true, onOpenChange });
    expect(React.isValidElement(drawn)).toBe(true);
    const element = drawn as React.ReactElement<Record<string, unknown>>;
    expect(element.type).toBe(CompareModelsPicker);
    expect(element.props).toMatchObject({ open: true, onOpenChange });
  });
});
