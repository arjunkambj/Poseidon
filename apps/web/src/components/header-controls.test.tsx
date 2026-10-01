import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import type { ThreadSettingsPatch } from "@poseidon/contracts/orchestration";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThreadSettingsControls } from "@/components/header-controls";

const id = (value: string) => value as ConnectorInstanceId;

// A harness that can switch ultracode and one whose model goes up to ultra.
const catalog = [
  {
    connector: { connectorInstanceId: id("ladder"), capabilities: {} },
    models: [{ id: "deep-ultra", label: "Deep", efforts: ["high", "xhigh", "max", "ultra"] }],
  },
  {
    connector: { connectorInstanceId: id("workflows"), capabilities: { ultracode: true } },
    models: [
      { id: "deep", label: "Deep", efforts: ["high", "xhigh", "max"] },
      { id: "light", label: "Light", efforts: ["low", "high"] },
    ],
  },
] as unknown as ReadonlyArray<ConnectorModels>;

const row = (instance: string, settings: ThreadSettingsPatch) =>
  renderToStaticMarkup(
    <ThreadSettingsControls
      settings={settings}
      catalog={catalog}
      connectorInstanceId={id(instance)}
      // The model picker reads app state; the effort picker beside it is the subject.
      modelPicker={() => null}
      onChange={() => {}}
    />,
  );

/** What the effort picker's trigger reads. */
const effortTrigger = (markup: string) =>
  /aria-label="Effort".*?data-slot="select-value"[^>]*>([^<]*)</.exec(markup)?.[1];

describe("ThreadSettingsControls ultracode", () => {
  it("draws no Ultracode button beside Plan mode, on or off", () => {
    for (const on of [false, true]) {
      const markup = row("workflows", { model: "deep", effort: "xhigh", ultracode: on });
      expect(markup).toContain('aria-label="Plan mode"');
      expect(markup).not.toContain('aria-label="Ultracode"');
    }
  });

  it("reads Ultracode in the effort picker while it is on, and the effort otherwise", () => {
    expect(
      effortTrigger(row("workflows", { model: "deep", effort: "xhigh", ultracode: true })),
    ).toBe("Ultracode");
    expect(effortTrigger(row("workflows", { model: "deep", effort: "xhigh" }))).toBe("xhigh");
    expect(
      effortTrigger(row("workflows", { model: "light", effort: "high", ultracode: true })),
    ).toBe("Ultracode");
  });

  it("reads Ultra for the ultra rung, the same way", () => {
    expect(effortTrigger(row("ladder", { model: "deep-ultra", effort: "ultra" }))).toBe("Ultra");
  });
});
