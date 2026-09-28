import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DialogActions } from "@/components/dialog-actions";

describe("DialogActions", () => {
  it("draws one hairline on top of the tonal footer, which holds the actions", () => {
    const markup = renderToStaticMarkup(
      <DialogActions>
        <button type="button">Save</button>
      </DialogActions>,
    );
    const separator = markup.indexOf('data-slot="separator"');
    const footer = markup.indexOf('data-slot="dialog-footer"');
    expect(separator).toBeGreaterThan(-1);
    expect(footer).toBeGreaterThan(separator);
    expect(markup.match(/data-slot="separator"/g)).toHaveLength(1);
    expect(markup).toContain("bg-muted/50");
    expect(markup).toContain("Save</button>");
  });

  it("runs edge to edge itself, so the footer drops its own edge margins", () => {
    const markup = renderToStaticMarkup(<DialogActions>x</DialogActions>);
    expect(markup).toMatch(/data-slot="dialog-actions" class="-mx-4 -mb-4 flex flex-col"/);
    const footerClass = /data-slot="dialog-footer" class="([^"]*)"/.exec(markup)?.[1] ?? "";
    expect(footerClass).toContain("mx-0");
    expect(footerClass).toContain("mb-0");
    expect(footerClass).not.toContain("-mx-4");
    expect(footerClass).not.toContain("-mb-4");
  });
});
