/**
 * The review's navigation buttons: a disabled one keeps its tooltip reachable
 * through a wrapper and says why it does nothing; an enabled one names itself.
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ReviewNav } from "./review-nav";

interface Slot {
  readonly children?: React.ReactNode;
  readonly render?: React.ReactElement;
}

vi.mock("@poseidon/ui/components/tooltip", () => ({
  Tooltip: ({ children }: Slot) => <div>{children}</div>,
  TooltipContent: ({ children }: Slot) => <div data-tooltip="">{children}</div>,
  TooltipTrigger: ({ children, render }: Slot) =>
    render === undefined ? <>{children}</> : React.cloneElement(render, undefined, children),
}));
vi.mock("@/lib/shortcuts", () => ({ CommandKbd: () => null }));

const render = (canStepChange: boolean, allViewed: boolean) =>
  renderToStaticMarkup(
    <ReviewNav
      canStepChange={canStepChange}
      onStepChange={() => {}}
      allViewed={allViewed}
      onNextUnviewed={() => {}}
    />,
  );

describe("review nav", () => {
  it("wraps every button so a disabled one still opens its tooltip", () => {
    const html = render(false, true);
    expect(html.match(/<span class="inline-flex"><button/g)).toHaveLength(3);
    expect(html.match(/ disabled=""/g)).toHaveLength(3);
  });

  it("says why a disabled button does nothing", () => {
    const html = render(false, true);
    expect(html).toContain("Previous change: no changed lines to step through");
    expect(html).toContain("Next change: no changed lines to step through");
    expect(html).toContain("Next unviewed file: every file is viewed");
  });

  it("names an enabled button without a reason", () => {
    const html = render(true, false);
    expect(html).not.toContain(" disabled=");
    expect(html).toContain('<div data-tooltip="">Next unviewed file</div>');
    expect(html).not.toContain("every file is viewed");
  });
});
