import { DeepseekColor, Openai } from "@honeyicons/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProviderMark } from "./provider-mark";

const paths = (html: string) => [...html.matchAll(/ d="([^"]*)"/g)].map(([, d]) => d);

describe("ProviderMark", () => {
  it("draws the provider's colour mark, hidden from assistive tech", () => {
    const html = renderToStaticMarkup(<ProviderMark providerKey="deepseek" />);
    expect(html).toBe(
      renderToStaticMarkup(
        <DeepseekColor
          variant="bold"
          aria-hidden
          data-slot="provider-mark"
          className="size-3.5 shrink-0 text-foreground/85"
        />,
      ),
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("size-3.5");
  });

  it("keeps the bold, monochrome mark for a provider with no colour logo", () => {
    const bold = paths(renderToStaticMarkup(<Openai variant="bold" />));
    expect(paths(renderToStaticMarkup(<ProviderMark providerKey="openai" />))).toEqual(bold);
    expect(renderToStaticMarkup(<ProviderMark providerKey="openai" />)).toContain(
      "text-foreground/85",
    );
  });

  it("holds an empty box the same size for a provider with no mark", () => {
    const html = renderToStaticMarkup(<ProviderMark providerKey="poolside" />);
    expect(html).not.toContain("<svg");
    expect(html).toBe(
      '<span aria-hidden="true" data-slot="provider-mark" class="size-3.5 shrink-0"></span>',
    );
  });
});
