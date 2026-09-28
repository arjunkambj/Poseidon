import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

describe("dialogs with a scrolling body", () => {
  const components = fileURLToPath(new URL(".", import.meta.url));
  const sources = (dir: string): ReadonlyArray<string> =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [path] : [];
    });

  it("cap the popup to the viewport and scroll it whole, so a short window never clips the footer", () => {
    const users = sources(components).filter(
      (path) =>
        !path.endsWith("dialog-body.tsx") && readFileSync(path, "utf8").includes("<DialogBody"),
    );
    expect(users.length).toBeGreaterThan(0);
    const uncapped = users.filter(
      (path) =>
        !/<DialogContent[^>]*className="[^"]*max-h-\[calc\(100dvh-2rem\)\] overflow-y-auto/.test(
          readFileSync(path, "utf8"),
        ),
    );
    expect(uncapped).toEqual([]);
  });
});
