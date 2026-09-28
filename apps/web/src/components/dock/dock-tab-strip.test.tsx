import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { installAppAtoms } from "@/state/app-runtime";

import { DockAddTabMenu } from "./dock-add-tab-menu";
import { dockTabsFor, offeredDockTabs } from "./dock-tab-meta";
import { DockTabStrip, dockTabId } from "./dock-tab-strip";
import { unopenedDockTabs, type DockPane, type DockTab } from "./dock-toggle";

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

  it("keeps the close buttons out of the tablist's tree and the Tab order", () => {
    const html = render(["changes", "files"], "files");
    const closes = html.match(/<button[^>]*aria-label="Close (?:Files|Changes)"[^>]*>/g) ?? [];
    expect(closes).toHaveLength(2);
    for (const close of closes) {
      expect(close).toContain('tabindex="-1"');
    }
    // Each close button sits in an aria-hidden span, beside its tab in a
    // presentation wrapper: the tablist owns tabs and nothing else.
    expect(html.match(/<span aria-hidden="true"[^>]*><button/g)).toHaveLength(2);
    expect(html.match(/<div role="presentation"/g)).toHaveLength(2);
  });

  it("announces Delete and Backspace as the way to close a tab", () => {
    for (const tab of tabsIn(render(["changes", "files"], "files"))) {
      expect(tab).toContain('aria-keyshortcuts="Delete Backspace"');
    }
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

// A closed menu renders only its trigger, so the items are checked through
// `unopenedDockTabs`, the list the menu draws.
describe("DockAddTabMenu", () => {
  const menu = (offered: ReadonlyArray<DockTab>, open: ReadonlyArray<DockTab>) =>
    renderToStaticMarkup(<DockAddTabMenu offeredTabs={offered} openTabs={open} onOpen={noop} />);

  it("offers to open a tab while some kind is not open", () => {
    expect(menu(dockTabsFor("thread"), ["changes"])).toContain('aria-label="Open a tab"');
    expect(unopenedDockTabs(dockTabsFor("thread"), ["changes"])).toEqual([
      "browser",
      "files",
      "agents",
      "pullRequest",
    ]);
  });

  it("is gone once every offered kind is open", () => {
    expect(
      menu(dockTabsFor("thread"), ["files", "changes", "browser", "agents", "pullRequest"]),
    ).toBe("");
    // Before the branch has a pull request (`offeredDockTabs`, tested beside it).
    expect(menu(offeredDockTabs("thread", false), ["files", "changes", "browser", "agents"])).toBe(
      "",
    );
    expect(menu(dockTabsFor("project"), ["changes", "files"])).toBe("");
  });

  it("is gone while no tab is open, where the launcher lists them all", () => {
    expect(menu(dockTabsFor("thread"), [])).toBe("");
  });

  it("never offers the Browser beside a project", () => {
    expect(unopenedDockTabs(dockTabsFor("project"), ["changes"])).toEqual(["files"]);
    expect(unopenedDockTabs(dockTabsFor("project"), [])).not.toContain("browser");
  });

  it("sits in the strip after the tabs, before the close button", () => {
    const html = renderToStaticMarkup(
      <DockTabStrip
        baseId="dock"
        openTabs={["changes"]}
        pane="changes"
        onTabChange={noop}
        onCloseTab={noop}
      >
        <DockAddTabMenu offeredTabs={dockTabsFor("thread")} openTabs={["changes"]} onOpen={noop} />
      </DockTabStrip>,
    );
    const add = html.indexOf('aria-label="Open a tab"');
    expect(add).toBeGreaterThan(html.indexOf('data-dock-tab="changes"'));
    expect(add).toBeLessThan(html.indexOf('aria-label="Close dock"'));
  });
});
