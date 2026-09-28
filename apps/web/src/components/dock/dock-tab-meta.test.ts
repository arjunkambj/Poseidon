import { describe, expect, it, vi } from "vitest";

import { DOCK_TAB_META, dockTabsFor } from "./dock-tab-meta";
import { DOCK_TAB_PANES } from "./dock-tab-panes";
import { dockTabs, isProjectDockPane, projectDockTabs } from "./dock-toggle";

// The panes pull in the diff worker and the browser host, which need a DOM;
// only the registry's shape is under test here.
vi.mock("@/components/panes/browser/browser-pane", () => ({ BrowserPane: () => null }));
vi.mock("@/components/panes/changes/changes-pane", () => ({ ChangesPane: () => null }));
vi.mock("@/components/panes/changes/project-changes-pane", () => ({
  ProjectChangesPane: () => null,
}));
vi.mock("@/components/panes/files/files-pane", () => ({ FilesPane: () => null }));

describe("the dock tab kind registry", () => {
  it("has meta and a pane renderer for every tab", () => {
    for (const tab of dockTabs) {
      expect(DOCK_TAB_META[tab].label).not.toBe("");
      expect(DOCK_TAB_META[tab].command).not.toBe("");
      expect(typeof DOCK_TAB_META[tab].icon).not.toBe("undefined");
      expect(typeof DOCK_TAB_PANES[tab]).toBe("function");
    }
    expect(Object.keys(DOCK_TAB_META).sort()).toEqual([...dockTabs].sort());
    expect(Object.keys(DOCK_TAB_PANES).sort()).toEqual([...dockTabs].sort());
  });

  it("offers a thread's dock every kind, in strip order", () => {
    expect(dockTabsFor("thread")).toEqual(dockTabs);
  });

  it("offers a project's dock the project tabs, without the browser", () => {
    expect(dockTabsFor("project")).toEqual(projectDockTabs);
    expect(dockTabsFor("project")).not.toContain("browser");
    for (const tab of dockTabs) {
      expect(isProjectDockPane(tab)).toBe(dockTabsFor("project").includes(tab));
    }
  });
});
