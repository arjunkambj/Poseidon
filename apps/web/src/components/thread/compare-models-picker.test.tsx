import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ModelOption } from "@poseidon/contracts/connectors";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import { DropdownMenu } from "@poseidon/ui/components/dropdown-menu";
import { TooltipProvider } from "@poseidon/ui/components/tooltip";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  compareMenuGroups,
  CompareModelsGroups,
  CompareModelsPicker,
  CompareModelsToggle,
  comparePicker,
} from "@/components/thread/compare-models-picker";
import { compareRefusal } from "@/components/thread/fan-out-plan";
import type { CompareModels } from "@/components/thread/use-compare-models";
import type { ModelPick } from "@/lib/model-picks";

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

const groups = (picks: ReadonlyArray<ModelPick>, onToggle: (pick: ModelPick) => void = () => {}) =>
  renderToStaticMarkup(
    <DropdownMenu open>
      <CompareModelsGroups catalog={catalog} descriptors={[]} picks={picks} onToggle={onToggle} />
    </DropdownMenu>,
  );

/** Every element in a rendered tree, props first, children after. */
const elements = (node: React.ReactNode): ReadonlyArray<React.ReactElement> => {
  if (Array.isArray(node)) {
    return node.flatMap(elements);
  }
  if (!React.isValidElement(node)) {
    return [];
  }
  const props = node.props as { readonly children?: React.ReactNode };
  return [node, ...elements(props.children)];
};

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

describe("CompareModelsGroups", () => {
  it("renders a checkbox per model under each instance's name, with the limit", () => {
    const markup = groups([pick("a", "m2")]);
    expect(markup.match(/role="menuitemcheckbox"/g)).toHaveLength(5);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(markup).toContain("Instance a");
    expect(markup).toContain("Instance b");
    expect(markup).toContain("Up to 4 models");
    expect(markup).not.toContain('aria-disabled="true"');
  });

  it("disables the fifth checkbox while four are picked", () => {
    const markup = groups(fourPicks);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(4);
    expect(markup.match(/aria-disabled="true"/g)).toHaveLength(1);
  });

  it("hands back the pick of the checkbox that was toggled", () => {
    const onToggle = vi.fn<(pick: ModelPick) => void>();
    const tree = CompareModelsGroups({ catalog, descriptors: [], picks: [], onToggle });
    const checkboxes = elements(tree).filter(
      (element) =>
        typeof (element.props as { onCheckedChange?: unknown }).onCheckedChange === "function",
    );
    expect(checkboxes).toHaveLength(5);
    const bM1 = checkboxes[3]?.props as { onCheckedChange: (checked: boolean) => void };
    bM1.onCheckedChange(true);
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(pick("b", "m1"));
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

  it("hands the model picker's open state to the checkbox menu, so Choose model opens it", () => {
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
