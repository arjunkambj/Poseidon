import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { makeItemId } from "@poseidon/contracts/ids";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReasoningRow } from "@/components/timeline/tool-rows";

const reasoning = (text: string | undefined): ItemSnapshot => ({
  itemId: makeItemId(),
  kind: "reasoning",
  status: "completed",
  ...(text === undefined ? {} : { text }),
});

describe("ReasoningRow", () => {
  it("opens onto what the model thought", () => {
    const markup = renderToStaticMarkup(<ReasoningRow item={reasoning("Check the router.")} />);
    expect(markup).toContain("<button");
    expect(markup).toContain("Check the router.");
  });

  it("is a plain line when the model thought without saying what", () => {
    for (const text of [undefined, "", " \n"]) {
      const markup = renderToStaticMarkup(<ReasoningRow item={reasoning(text)} />);
      expect(markup).toContain("Reasoning");
      expect(markup).not.toContain("<button");
    }
  });
});
