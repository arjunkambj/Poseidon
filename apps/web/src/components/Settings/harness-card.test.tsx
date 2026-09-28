import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ModelOption } from "@poseidon/contracts/connectors";
import type { Effort } from "@poseidon/contracts/enums";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import {
  DEFAULT_MODEL_PICKER_SETTINGS,
  type ModelPickerSettings,
} from "@poseidon/contracts/settings";
import { TooltipProvider } from "@poseidon/ui/components/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { effortsText, HarnessCard } from "@/components/Settings/harness-card";
import { setHarness, setModel } from "@/lib/model-visibility";

const id = (value: string) => value as ConnectorInstanceId;

const model = (
  modelId: string,
  efforts: ReadonlyArray<Effort> = [],
  hidden?: boolean,
): ModelOption => ({
  id: modelId,
  label: modelId.toUpperCase(),
  family: "family",
  efforts,
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

const a = group("a", [model("m1", ["high", "low", "medium"]), model("secret", [], true)]);
const b = group("b", [model("m2")]);
const catalog = [a, b];
const none = DEFAULT_MODEL_PICKER_SETTINGS;

const render = (
  card: ConnectorModels,
  prefs: ModelPickerSettings,
  cards: ReadonlyArray<ConnectorModels> = catalog,
) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <HarnessCard group={card} catalog={cards} monogram="Ia" prefs={prefs} onChange={() => {}} />
    </TooltipProvider>,
  );

/** Each switch's aria-label with its checked and disabled state. */
const switches = (html: string) =>
  [...html.matchAll(/<[^>]*role="switch"[^>]*>/g)].map(([tag]) => ({
    label: /aria-label="([^"]*)"/.exec(tag)?.[1],
    checked: /aria-checked="true"/.test(tag),
    disabled: /data-disabled=""|aria-disabled="true"/.test(tag),
  }));

describe("effortsText", () => {
  it("reads the ladder lowest first, and says when there is none", () => {
    expect(effortsText(["high", "low", "medium"])).toBe("low · medium · high");
    expect(effortsText([])).toBe("No effort levels");
    expect(effortsText(null)).toContain("low · medium · high");
  });
});

describe("HarnessCard", () => {
  it("shows the harness, each model's id, family and efforts, and the switches' defaults", () => {
    const html = render(a, none);
    expect(html).toContain("Instance a");
    expect(html).toContain("Ia");
    expect(html).toContain("m1 · family");
    expect(html).toContain("low · medium · high");
    expect(html).toContain("No effort levels");
    expect(html).toContain("keep working");
    expect(switches(html)).toEqual([
      { label: "Show Instance a in model pickers", checked: true, disabled: false },
      { label: "Show M1 in model pickers", checked: true, disabled: false },
      // Hidden by its connector, so off until switched on.
      { label: "Show SECRET in model pickers", checked: false, disabled: false },
    ]);
  });

  it("follows the stored switches", () => {
    const prefs = setModel(setModel(none, "a", "secret", true), "a", "m1", false);
    expect(switches(render(a, prefs)).map((entry) => entry.checked)).toEqual([true, false, true]);
  });

  it("disables the model rows under a harness that is off", () => {
    const html = render(a, setHarness(none, "a", false));
    expect(switches(html)).toEqual([
      { label: "Show Instance a in model pickers", checked: false, disabled: false },
      { label: "Show M1 in model pickers", checked: true, disabled: true },
      { label: "Show SECRET in model pickers", checked: false, disabled: true },
    ]);
    expect(html).toContain('aria-disabled="true"');
  });

  it("refuses to switch off the last model and harness the pickers offer", () => {
    const prefs = setHarness(none, "b", false);
    const html = render(a, prefs);
    expect(switches(html)).toEqual([
      { label: "Show Instance a in model pickers", checked: true, disabled: true },
      { label: "Show M1 in model pickers", checked: true, disabled: true },
      { label: "Show SECRET in model pickers", checked: false, disabled: false },
    ]);
  });

  it("says when a harness lists no models", () => {
    expect(render(group("c", []), none, [...catalog, group("c", [])])).toContain("lists no models");
  });
});
