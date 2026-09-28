import { Deepseek, Openai } from "@honeyicons/react";
import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ModelOption } from "@poseidon/contracts/connectors";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import { TooltipProvider } from "@poseidon/ui/components/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HarnessPickerView } from "@/components/model-picker/harness-picker";
import { activeOptionId, keyStep } from "@/components/model-picker/picker-keys";
import { LOGO_ICON, LOGO_ICON_KEY } from "@/components/ui/icons/test-logo";
import { harnessRail, initialPickerState, type PickerState } from "@/lib/harness-picker";
import { encodeModelPick, modelPickerGroups, type ModelPick } from "@/lib/model-picks";

const id = (value: string) => value as ConnectorInstanceId;

const model = (
  modelId: string,
  label: string,
  efforts: ModelOption["efforts"] = [],
): ModelOption => ({ id: modelId, label, family: "family", efforts });

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

const catalog = [
  group("a", "Comet Cloud", [
    model("swift-1", "Swift One", ["low", "medium", "high"]),
    model("deep-2", "Deep Two"),
  ]),
  group("b", "Cedar Cove", [model("swift-mini", "Swift Mini", ["high"])]),
];

const current: ModelPick = { connectorInstanceId: id("a"), model: "deep-2" };

const railFor = (locked = false, iconKeys?: ReadonlyMap<string, string>) =>
  harnessRail(
    modelPickerGroups(catalog, { instanceId: id("a"), locked }),
    current,
    catalog,
    iconKeys,
  );

/** The first path the logo draws, which its gradient ids do not touch. */
const logoPath = / d="([^"]*)"/.exec(renderToStaticMarkup(<LOGO_ICON />))?.[1] ?? "";

const render = (
  rail: ReturnType<typeof railFor>,
  state: PickerState,
  unlisted?: string,
  checked?: ReadonlySet<string>,
) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <HarnessPickerView
        base="p"
        rail={rail}
        state={state}
        empty={{ title: "Empty rail", description: "Why it is empty." }}
        {...(unlisted === undefined ? {} : { unlisted })}
        {...(checked === undefined ? {} : { checked })}
        dispatch={() => {}}
        onKeyDown={() => {}}
        onChoose={() => {}}
      />
    </TooltipProvider>,
  );

/** Every element carrying `attribute`, as its opening tag. */
const tagsWith = (html: string, attribute: string) =>
  [...html.matchAll(/<[a-z]+ [^>]*>/g)]
    .map(([tag]) => tag)
    .filter((tag) => tag.includes(attribute));

describe("HarnessPickerView", () => {
  it("draws one avatar per harness, each a tooltip trigger naming it", () => {
    const html = render(railFor(), initialPickerState(railFor(), current));
    const avatars = tagsWith(html, 'id="p-harness-');
    expect(avatars).toHaveLength(2);
    expect(avatars[0]).toContain('aria-label="Comet Cloud"');
    expect(avatars[1]).toContain('aria-label="Cedar Cove"');
    for (const avatar of avatars) {
      expect(avatar).toContain('role="option"');
      expect(avatar).toContain('data-slot="tooltip-trigger"');
    }
    // Monograms, distinct although both names start "C… C…".
    expect(html).toContain(">Co<");
    expect(html).toContain(">Ce<");
  });

  it("draws a harness's logo in place of its monogram when its iconKey names one", () => {
    const rail = railFor(false, new Map([["harness", LOGO_ICON_KEY]]));
    expect(rail.map((entry) => entry.iconKey)).toEqual([LOGO_ICON_KEY, LOGO_ICON_KEY]);
    const html = render(rail, initialPickerState(rail, current));
    expect(logoPath).not.toBe("");
    expect(html.split(` d="${logoPath}"`)).toHaveLength(3);
    expect(html).not.toContain(">Co<");
    // The tooltip and label still name the harness.
    expect(tagsWith(html, 'id="p-harness-0"')[0]).toContain('aria-label="Comet Cloud"');
  });

  it("keeps the monogram for a key with no logo, or none at all", () => {
    for (const iconKeys of [new Map([["harness", "terminal"]]), new Map(), undefined]) {
      const rail = railFor(false, iconKeys);
      const html = render(rail, initialPickerState(rail, current));
      expect(html).not.toContain(logoPath);
      expect(html).toContain(">Co<");
      expect(html).toContain(">Ce<");
    }
  });

  it("marks the current harness and model and highlights the current row", () => {
    const html = render(railFor(), initialPickerState(railFor(), current));
    const [own, other] = tagsWith(html, 'id="p-harness-');
    expect(own).toContain("data-current");
    expect(own).toContain('aria-selected="true"');
    expect(other).not.toContain("data-current");
    const row = tagsWith(html, 'id="p-model-0-1"')[0];
    expect(row).toContain("data-current");
    expect(row).toContain('aria-selected="true"');
    expect(tagsWith(html, 'id="p-model-0-0"')[0]).not.toContain("data-current");
    // The effort ladder, shortened.
    expect(html).toContain("low–high");
    // The input names the highlighted row.
    expect(tagsWith(html, 'role="combobox"')[0]).toContain('aria-activedescendant="p-model-0-1"');
  });

  it("disables a locked harness's models and says how to switch", () => {
    const rail = railFor(true);
    const html = render(rail, { ...initialPickerState(rail, current), harness: 1, zone: "rail" });
    const other = tagsWith(html, 'id="p-harness-1"')[0];
    expect(other).toContain('aria-disabled="true"');
    expect(other).toContain("Start a new thread to switch connector");
    expect(tagsWith(html, 'id="p-model-1-0"')[0]).toContain('aria-disabled="true"');
    expect(tagsWith(html, 'id="p-model-0-0"')[0]).not.toContain("aria-disabled");
  });

  it("lists search matches across harnesses with their monograms", () => {
    const state = { ...initialPickerState(railFor(), current), query: "swift" };
    const html = render(railFor(), state);
    const results = tagsWith(html, 'id="p-result-');
    expect(results).toHaveLength(2);
    expect(results[0]).toContain('aria-label="Swift One, Comet Cloud"');
    expect(results[1]).toContain('aria-label="Swift Mini, Cedar Cove"');
    expect(tagsWith(html, 'role="combobox"')[0]).toContain('aria-activedescendant="p-result-0"');
  });

  it("leads each search result with its harness's logo when it has one", () => {
    const rail = railFor(false, new Map([["harness", LOGO_ICON_KEY]]));
    const html = render(rail, { ...initialPickerState(rail, current), query: "swift" });
    // Two rail avatars and two result rows.
    expect(html.split(` d="${logoPath}"`)).toHaveLength(5);
  });

  it("draws a checkbox on every row in compare mode, flyouts and search results alike", () => {
    const ticked = new Set([
      encodeModelPick({ connectorInstanceId: id("b"), model: "swift-mini" }),
    ]);
    const start = initialPickerState(railFor(), current);
    const flyouts = render(railFor(), start, undefined, ticked);
    expect(tagsWith(flyouts, 'role="checkbox"')).toHaveLength(3);
    const options = tagsWith(flyouts, 'id="p-model-');
    expect(options.map((tag) => tag.includes('aria-checked="true"'))).toEqual([false, false, true]);

    const results = render(railFor(), { ...start, query: "swift" }, undefined, ticked);
    const rows = tagsWith(results, 'id="p-result-');
    expect(rows.map((tag) => tag.includes('aria-checked="true"'))).toEqual([false, true]);
    // Without `checked` no row is a checkbox.
    expect(render(railFor(), start)).not.toContain('role="checkbox"');
  });

  it("says so when nothing matches", () => {
    const state = { ...initialPickerState(railFor(), current), query: "zzz" };
    const html = render(railFor(), state);
    expect(html).toContain("No models match");
    expect(tagsWith(html, 'role="combobox"')[0]).not.toContain("aria-activedescendant");
  });

  it("says why an empty rail is empty", () => {
    const html = render([], initialPickerState([], current));
    expect(html).toContain("Empty rail");
    expect(html).toContain("Why it is empty.");
  });

  it("tells a harness whose models are all off from one that listed none", () => {
    const listed = [group("a", "Comet Cloud", [model("swift-1", "Swift One")])];
    const keep = { connectorInstanceId: id("a"), model: "swift-1" };
    const groups = modelPickerGroups([{ ...listed[0]!, models: [] }], {
      instanceId: id("a"),
      locked: false,
    });
    const off = harnessRail(groups, keep, listed);
    expect(render(off, initialPickerState(off, keep))).toContain("off in Settings → Models");
    const none = harnessRail(groups, keep, [{ ...listed[0]!, models: [] }]);
    expect(render(none, initialPickerState(none, keep))).toContain("listed no models");
  });

  it("shows a current model no harness lists verbatim", () => {
    const html = render(railFor(), initialPickerState(railFor(), current), "old-model");
    expect(html).toContain("Current · old-model");
  });
});

describe("HarnessPickerView provider marks", () => {
  const firstPath = (html: string) => / d="([^"]*)"/.exec(html)?.[1] ?? "";
  const deepseek = firstPath(renderToStaticMarkup(<Deepseek variant="bold" />));
  const openai = firstPath(renderToStaticMarkup(<Openai variant="bold" />));
  const mixed = [
    group("m", "Mixed", [
      { id: "deepseek/deepseek-v4-pro", label: "V4 Pro", family: "Open Source", efforts: [] },
      { id: "poolside/laguna-s-2.1-free", label: "Laguna", family: "Open Source", efforts: [] },
      { id: "gpt-5.5", label: "GPT-5.5", family: "OpenAI", efforts: [] },
    ]),
    group("s", "Single", [
      { id: "gpt-5.5", label: "GPT-5.5", family: "OpenAI", efforts: [] },
      { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", family: "OpenAI", efforts: [] },
    ]),
  ];
  const onMixed: ModelPick = { connectorInstanceId: id("m"), model: "gpt-5.5" };
  const rail = harnessRail(
    modelPickerGroups(mixed, { instanceId: id("m"), locked: false }),
    onMixed,
    mixed,
  );
  /** Each option's markup, from its opening tag up to the next option. */
  const options = (html: string, prefix: string) => html.split(`id="${prefix}`).slice(1);

  it("leads a multi-provider harness's rows with marks, and a box where none exists", () => {
    const html = render(rail, initialPickerState(rail, onMixed));
    const rows = options(html, "p-model-0-");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain(` d="${deepseek}"`);
    expect(rows[1]).toContain('<span aria-hidden="true" data-slot="provider-mark"');
    expect(rows[1]).not.toContain("<svg");
    expect(rows[2]).toContain(` d="${openai}"`);
  });

  it("draws no marks for a harness whose models share one provider", () => {
    const state = { ...initialPickerState(rail, onMixed), harness: 1, zone: "rail" as const };
    const html = render(rail, state);
    expect(options(html, "p-model-1-")).toHaveLength(2);
    for (const row of options(html, "p-model-1-")) {
      expect(row).not.toContain('data-slot="provider-mark"');
    }
  });

  it("keeps the marks in search results", () => {
    const html = render(rail, { ...initialPickerState(rail, onMixed), query: "v4" });
    const [row] = options(html, "p-result-");
    expect(row).toContain(` d="${deepseek}"`);
  });
});

describe("keyStep", () => {
  it("forwards picker keys to the reducer and leaves the rest to the input", () => {
    const rail = railFor();
    const opened = initialPickerState(rail, current);
    expect(keyStep("a", opened, rail)).toBeNull();
    const up = keyStep("ArrowUp", opened, rail);
    expect(up?.handled).toBe(true);
    expect(activeOptionId("p", up?.state ?? opened, rail)).toBe("p-model-0-0");
    const enter = keyStep("Enter", opened, rail);
    expect(enter?.effect).toEqual({ type: "pick", pick: current });
    const back = keyStep("Escape", opened, rail);
    expect(activeOptionId("p", back?.state ?? opened, rail)).toBe("p-harness-0");
  });
});
