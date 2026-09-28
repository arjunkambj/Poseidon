import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import type { ThreadSettingsPatch } from "@poseidon/contracts/orchestration";
import { TooltipProvider } from "@poseidon/ui/components/tooltip";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { UltracodeToggle } from "@/components/ultracode-toggle";
import { ultracodeOfferedIn } from "@/lib/ultracode";

const id = (value: string) => value as ConnectorInstanceId;

// A harness that can switch ultracode, with an xhigh model and one without,
// beside two that cannot: one whose models go up to ultra, one up to xhigh.
const catalog = [
  {
    connector: { connectorInstanceId: id("ladder"), capabilities: {} },
    models: [{ id: "deep-ultra", efforts: ["high", "xhigh", "ultra"] }],
  },
  {
    connector: { connectorInstanceId: id("plain"), capabilities: {} },
    models: [{ id: "plain-xhigh", efforts: ["high", "xhigh"] }],
  },
  {
    connector: { connectorInstanceId: id("workflows"), capabilities: { ultracode: true } },
    models: [
      { id: "deep", efforts: ["high", "xhigh", "max"] },
      { id: "light", efforts: ["low", "medium", "high"] },
    ],
  },
] as unknown as ReadonlyArray<ConnectorModels>;

const toggle = (
  instance: string,
  model: string,
  on = false,
  onChange: (patch: ThreadSettingsPatch) => void = () => {},
) => (
  <UltracodeToggle
    offered={ultracodeOfferedIn(catalog, id(instance), model)}
    on={on}
    onChange={onChange}
  />
);

const markup = (element: React.ReactElement) =>
  renderToStaticMarkup(<TooltipProvider>{element}</TooltipProvider>);

type Clickable = React.ReactElement<{ onClick: () => void }>;
type Drawn = React.ReactElement<{ children?: React.ReactNode; render?: Clickable }>;

/** The button the tooltip trigger renders, found in the toggle's element tree. */
const button = (element: React.ReactElement): Clickable => {
  const find = (node: React.ReactNode): Clickable | undefined => {
    for (const child of React.Children.toArray(node)) {
      if (!React.isValidElement<Drawn["props"]>(child)) continue;
      const found = child.props.render ?? find(child.props.children);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const found = find(UltracodeToggle(element.props as Parameters<typeof UltracodeToggle>[0]));
  if (found === undefined) throw new Error("no toggle button drawn");
  return found;
};

describe("UltracodeToggle", () => {
  it("is hidden under harnesses that cannot switch it, and on a model without xhigh", () => {
    expect(markup(toggle("ladder", "deep-ultra"))).toBe("");
    expect(markup(toggle("plain", "plain-xhigh"))).toBe("");
    expect(markup(toggle("workflows", "light"))).toBe("");
  });

  it("shows on an xhigh model of a harness that can: an icon while off, the word while on", () => {
    const off = markup(toggle("workflows", "deep"));
    expect(off).toContain('aria-label="Ultracode"');
    expect(off).toContain('aria-pressed="false"');
    expect(off).not.toContain(">Ultracode<");
    const on = markup(toggle("workflows", "deep", true));
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain("Ultracode");
  });

  it("stays while on where it is not offered, so it can be switched off", () => {
    expect(markup(toggle("workflows", "light", true))).toContain('aria-pressed="true"');
  });

  it("sends ultracode on at xhigh, and off with the effort kept", () => {
    const onChange = vi.fn<(patch: ThreadSettingsPatch) => void>();
    button(toggle("workflows", "deep", false, onChange)).props.onClick();
    expect(onChange).toHaveBeenLastCalledWith({ ultracode: true, effort: "xhigh" });
    button(toggle("workflows", "deep", true, onChange)).props.onClick();
    expect(onChange).toHaveBeenLastCalledWith({ ultracode: false });
  });
});
