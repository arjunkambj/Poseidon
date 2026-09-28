import { Deepseek, Meta } from "@honeyicons/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProviderMark } from "./provider-mark";

const paths = (html: string) => [...html.matchAll(/ d="([^"]*)"/g)].map(([, d]) => d);

describe("ProviderMark", () => {
  it("draws the provider's bold, monochrome mark, hidden from assistive tech", () => {
    const html = renderToStaticMarkup(<ProviderMark providerKey="deepseek" />);
    expect(paths(html)).toEqual(paths(renderToStaticMarkup(<Deepseek variant="bold" />)));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("size-3.5");
    expect(html).toContain("text-foreground/85");
  });

  it("keeps Meta's bold mark, which differs from its linear outline", () => {
    const bold = paths(renderToStaticMarkup(<Meta variant="bold" />));
    // The linear drawing is built without JSX: it is the one the app never renders.
    expect(bold).not.toEqual(paths(renderToStaticMarkup(createElement(Meta))));
    expect(paths(renderToStaticMarkup(<ProviderMark providerKey="meta" />))).toEqual(bold);
  });

  it("holds an empty box the same size for a provider with no mark", () => {
    const html = renderToStaticMarkup(<ProviderMark providerKey="poolside" />);
    expect(html).not.toContain("<svg");
    expect(html).toBe(
      '<span aria-hidden="true" data-slot="provider-mark" class="size-3.5 shrink-0"></span>',
    );
  });
});
