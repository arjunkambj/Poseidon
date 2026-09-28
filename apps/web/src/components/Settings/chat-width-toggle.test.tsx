import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChatWidth } from "@poseidon/contracts/settings";

import { ChatWidthPicker } from "@/components/Settings/chat-width-toggle";

const picker = (width: ChatWidth) =>
  renderToStaticMarkup(<ChatWidthPicker width={width} onChange={() => {}} />);

const pressed = (markup: string) =>
  [...markup.matchAll(/<button[^>]*aria-pressed="true"[^>]*>([^<]*)</gu)].map((m) => m[1]);

describe("ChatWidthPicker", () => {
  it("lists the three widths in order under one labelled group", () => {
    const markup = picker("comfortable");
    expect(markup).toContain('aria-label="Chat width"');
    const labels = [...markup.matchAll(/<button[^>]*>([^<]*)</gu)].map((m) => m[1]);
    expect(labels).toEqual(["Comfortable", "Wide", "Full"]);
  });

  it("presses only the current width", () => {
    expect(pressed(picker("comfortable"))).toEqual(["Comfortable"]);
    expect(pressed(picker("wide"))).toEqual(["Wide"]);
    expect(pressed(picker("full"))).toEqual(["Full"]);
  });
});
