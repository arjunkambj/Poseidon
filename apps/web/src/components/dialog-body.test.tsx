import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DialogBody } from "@/components/dialog-body";

describe("DialogBody", () => {
  it("renders its children in a container that scrolls", () => {
    const markup = renderToStaticMarkup(
      <DialogBody>
        <p>Long body</p>
      </DialogBody>,
    );
    expect(markup).toContain('data-slot="dialog-body"');
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("max-h-[60vh]");
    expect(markup).toContain("<p>Long body</p>");
  });

  it("pads its edges as far as a checkbox's hit area reaches, so it only scrolls when it overflows", () => {
    // The stock Checkbox's hit area reaches 8px (inset-y-2) past its box.
    const markup = renderToStaticMarkup(<DialogBody>x</DialogBody>);
    expect(markup).toMatch(/class="[^"]*-my-2[^"]*py-2/);
  });

  it("merges a className and passes other props through", () => {
    const markup = renderToStaticMarkup(
      <DialogBody className="flex flex-col gap-3" aria-label="Files">
        x
      </DialogBody>,
    );
    expect(markup).toMatch(/class="[^"]*overflow-y-auto[^"]*flex flex-col gap-3"/);
    expect(markup).toContain('aria-label="Files"');
  });

  it("lets a className replace the default height cap", () => {
    const markup = renderToStaticMarkup(<DialogBody className="max-h-96">x</DialogBody>);
    expect(markup).toContain("max-h-96");
    expect(markup).not.toContain("max-h-[60vh]");
  });
});
