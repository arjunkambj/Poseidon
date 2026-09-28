import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { installAppAtoms } from "@/state/app-runtime";

import { DockTabStrip, dockTabId } from "./dock-tab-strip";
import type { DockPane, DockTab } from "./dock-toggle";

// The tooltips' keys are read from the app's keybindings.
installAppAtoms(null);

const noop = () => {};

const render = (openTabs: ReadonlyArray<DockTab>, pane: DockPane) =>
  renderToStaticMarkup(
    <DockTabStrip
      baseId="dock"
      openTabs={openTabs}
      pane={pane}
      onTabChange={noop}
      onCloseTab={noop}
    />,
  );

/** Each `role="tab"` button's opening tag, in document order. */
const tabsIn = (html: string) => html.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];

describe("DockTabStrip", () => {
  it("shows only the opened tabs, in opening order, with their names", () => {
    const html = render(["files", "changes"], "changes");
    const tabs = tabsIn(html);
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toContain('data-dock-tab="files"');
    expect(tabs[1]).toContain('data-dock-tab="changes"');
    expect(html).not.toContain('data-dock-tab="browser"');
    expect(html).toContain(">Files</span>");
    expect(html).toContain(">Changes</span>");
  });

  it("selects the active tab and makes it the one Tab stop", () => {
    const [files, changes] = tabsIn(render(["files", "changes"], "changes"));
    expect(changes).toContain('aria-selected="true"');
    expect(changes).toContain('tabindex="0"');
    expect(changes).toContain(`id="${dockTabId("dock", "changes")}"`);
    expect(files).toContain('aria-selected="false"');
    expect(files).toContain('tabindex="-1"');
  });

  it("gives each tab its own close button, beside the tab rather than in it", () => {
    const html = render(["changes", "browser"], "browser");
    expect(html).toContain('aria-label="Close Changes"');
    expect(html).toContain('aria-label="Close Browser"');
    // No button opens inside a tab before the tab closes.
    for (const match of html.matchAll(/<button[^>]*role="tab"[^>]*>([\s\S]*?)<\/button>/g)) {
      expect(match[1]).not.toContain("<button");
    }
  });

  it("keeps the active tab's close button in the Tab order and the others out", () => {
    const html = render(["changes", "files"], "files");
    expect(html).toMatch(
      /aria-label="Close Files"[^>]*tabindex="0"|tabindex="0"[^>]*aria-label="Close Files"/,
    );
    expect(html).toMatch(
      /aria-label="Close Changes"[^>]*tabindex="-1"|tabindex="-1"[^>]*aria-label="Close Changes"/,
    );
  });

  it("has no tablist on the launcher once every tab is closed", () => {
    const html = render([], "home");
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain('aria-label="Close dock"');
  });

  it("keeps the open tabs on the launcher, with the first as the Tab stop", () => {
    const tabs = tabsIn(render(["browser", "files"], "home"));
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toContain('tabindex="0"');
    expect(tabs[0]).toContain('aria-selected="false"');
    expect(tabs[1]).toContain('tabindex="-1"');
  });
});
