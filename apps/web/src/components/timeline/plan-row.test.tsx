import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { makeItemId } from "@poseidon/contracts/ids";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlanRow } from "@/components/timeline/plan-row";

const plan = (markdown: string): ItemSnapshot => ({
  itemId: makeItemId(),
  kind: "plan",
  status: "completed",
  plan: { markdown },
});

describe("PlanRow", () => {
  it("renders the plan with a copy button under it", () => {
    const markup = renderToStaticMarkup(<PlanRow item={plan("# Ship it\n\n- step one")} />);
    expect(markup).toContain("Ship it");
    expect(markup).toContain('aria-label="Copy plan"');
    expect(markup.indexOf("step one")).toBeLessThan(markup.indexOf('aria-label="Copy plan"'));
  });

  it("offers Implement and Save only for a thread it knows", () => {
    // Outside a timeline there is no thread to start from or save into.
    const markup = renderToStaticMarkup(<PlanRow item={plan("# Ship it")} />);
    expect(markup).not.toContain('aria-label="Implement in new thread"');
    expect(markup).not.toContain('aria-label="Save as .md"');
  });
});
