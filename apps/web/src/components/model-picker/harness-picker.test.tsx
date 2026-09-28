import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ModelOption } from "@poseidon/contracts/connectors";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import { TooltipProvider } from "@poseidon/ui/components/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HarnessPickerView } from "@/components/model-picker/harness-picker";
import { activeOptionId, keyStep } from "@/components/model-picker/picker-keys";
import { harnessRail, initialPickerState, type PickerState } from "@/lib/harness-picker";
import { modelPickerGroups, type ModelPick } from "@/lib/model-picks";

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

const railFor = (locked = false) =>
  harnessRail(modelPickerGroups(catalog, { instanceId: id("a"), locked }), current);

const render = (rail: ReturnType<typeof railFor>, state: PickerState, unlisted?: string) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <HarnessPickerView
        base="p"
        rail={rail}
        state={state}
        {...(unlisted === undefined ? {} : { unlisted })}
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

  it("says so when nothing matches", () => {
    const state = { ...initialPickerState(railFor(), current), query: "zzz" };
    const html = render(railFor(), state);
    expect(html).toContain("No models match");
    expect(tagsWith(html, 'role="combobox"')[0]).not.toContain("aria-activedescendant");
  });

  it("shows a current model no harness lists verbatim", () => {
    const html = render(railFor(), initialPickerState(railFor(), current), "old-model");
    expect(html).toContain("Current · old-model");
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
