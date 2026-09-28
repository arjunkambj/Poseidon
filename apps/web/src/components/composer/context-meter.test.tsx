import { TooltipProvider } from "@poseidon/ui/components/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ContextBreakdown, ContextMeter } from "@/components/composer/context-meter";

const meter = (used: number, limit: number) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <ContextMeter used={used} limit={limit} />
    </TooltipProvider>,
  );

describe("ContextMeter", () => {
  it("reads the share of the window used, rounded", () => {
    const markup = meter(24_600, 200_000);
    expect(markup).toContain('aria-label="Context window 12% used"');
    expect(markup).toContain("12%");
  });

  it("reads 0% before a turn has reported any usage", () => {
    expect(meter(0, 200_000)).toContain("0%");
  });

  it("turns destructive once the window is nearly full, and caps at 100%", () => {
    expect(meter(150_000, 200_000)).not.toContain("stroke-destructive");
    expect(meter(170_000, 200_000)).toContain("stroke-destructive");
    expect(meter(250_000, 200_000)).toContain("100%");
  });

  it("offers no Compact now without a compact action", () => {
    expect(meter(24_600, 200_000)).not.toContain("Compact now");
  });
});

describe("ContextBreakdown", () => {
  const compact = (disabledReason: string | null) => ({
    onCompact: () => {},
    disabledReason,
    pending: false,
  });

  it("reads used, window and remaining tokens, with the bar at the share used", () => {
    const markup = renderToStaticMarkup(<ContextBreakdown used={24_600} limit={200_000} />);
    expect(markup).toContain("24.6K tokens");
    expect(markup).toContain("200K tokens");
    expect(markup).toContain("175.4K tokens");
    expect(markup).toContain('aria-valuenow="12"');
    expect(markup).not.toContain("Compact now");
  });

  it("never reads a negative remainder past the window", () => {
    expect(renderToStaticMarkup(<ContextBreakdown used={250_000} limit={200_000} />)).toContain(
      "0 tokens",
    );
  });

  it("offers Compact now, and disables it with its reason", () => {
    const ready = renderToStaticMarkup(
      <ContextBreakdown used={1} limit={10} compact={compact(null)} />,
    );
    expect(ready).toContain("Compact now");
    expect(ready).not.toContain(`disabled=""`);
    const busy = renderToStaticMarkup(
      <ContextBreakdown used={1} limit={10} compact={compact("Wait for the turn")} />,
    );
    expect(busy).toContain(`disabled=""`);
    expect(busy).toContain("Wait for the turn");
  });
});
