import { describe, expect, it } from "vitest";

import {
  adjacentDockTab,
  closeDockTab,
  dockArrivalTarget,
  dockStripTabs,
  dockTabKeyAction,
  dockTabTarget,
  dockToggleTarget,
  isDockPane,
  isDockTab,
  isProjectDockPane,
  noteDockShown,
  projectDockTabs,
  rememberDockMove,
  unopenedDockTabs,
  type DockMemory,
  type DockPane,
} from "./dock-toggle";

describe("isDockPane", () => {
  it("takes the tabs and the launcher", () => {
    expect(isDockPane("changes")).toBe(true);
    expect(isDockPane("home")).toBe(true);
  });

  it("leaves the launcher out of the tabs", () => {
    expect(isDockTab("home")).toBe(false);
    expect(isDockTab("files")).toBe(true);
  });

  it("reads anything else as a closed dock", () => {
    expect(isDockPane("terminal")).toBe(false);
    expect(isDockPane(undefined)).toBe(false);
    expect(isDockPane(3)).toBe(false);
  });
});

describe("dockToggleTarget", () => {
  it("closes an open dock whatever it shows", () => {
    expect(dockToggleTarget("files", "browser")).toBeNull();
    expect(dockToggleTarget("changes", undefined)).toBeNull();
    expect(dockToggleTarget("home", "files")).toBeNull();
  });

  it("reopens a closed dock on the last tab used, else the launcher", () => {
    expect(dockToggleTarget(undefined, "files")).toBe("files");
    expect(dockToggleTarget(undefined, undefined)).toBe("home");
  });
});

describe("dockTabTarget", () => {
  it("opens the tab from a closed dock, the launcher or another tab", () => {
    expect(dockTabTarget(undefined, "files")).toBe("files");
    expect(dockTabTarget("home", "changes")).toBe("changes");
    expect(dockTabTarget("changes", "files")).toBe("files");
  });

  it("closes the dock when it already shows that tab", () => {
    expect(dockTabTarget("browser", "browser")).toBeNull();
  });
});

describe("dock memory", () => {
  it("starts with nothing to reopen", () => {
    expect(dockArrivalTarget(undefined)).toBeUndefined();
  });

  it("reopens what the user left the dock on", () => {
    expect(dockArrivalTarget(rememberDockMove(undefined, "browser"))).toBe("browser");
    expect(dockArrivalTarget(rememberDockMove(undefined, "home"))).toBe("home");
  });

  it("forgets the dock on close but keeps the last tab for the toggle", () => {
    const closed = rememberDockMove(rememberDockMove(undefined, "files"), null);
    expect(dockArrivalTarget(closed)).toBeUndefined();
    expect(dockToggleTarget(undefined, closed.lastTab)).toBe("files");
  });

  it("does not let the launcher replace the last tab", () => {
    const back = rememberDockMove(rememberDockMove(undefined, "browser"), "home");
    expect(back).toEqual({ shown: "home", lastTab: "browser", openTabs: ["browser"] });
  });

  it("notes a tab someone else opened without reopening it on arrival", () => {
    const noted = noteDockShown(undefined, "changes");
    expect(noted?.lastTab).toBe("changes");
    expect(dockArrivalTarget(noted)).toBeUndefined();
  });

  it("returns the same memory when nothing new was shown", () => {
    const memory = rememberDockMove(undefined, "files");
    expect(noteDockShown(memory, "files")).toBe(memory);
    expect(noteDockShown(memory, "home")).toBe(memory);
    expect(noteDockShown(memory, undefined)).toBe(memory);
  });
});

describe("open tabs", () => {
  const moves = (...panes: ReadonlyArray<DockPane | null>): DockMemory =>
    panes.reduce<DockMemory>((memory, pane) => rememberDockMove(memory, pane), {});

  it("adds a tab the user moves to", () => {
    expect(rememberDockMove(undefined, "files").openTabs).toEqual(["files"]);
  });

  it("leaves the tabs alone for the launcher and a close", () => {
    expect(rememberDockMove(undefined, "home").openTabs ?? []).toEqual([]);
    expect(moves("files", "home", null).openTabs).toEqual(["files"]);
  });

  it("keeps opening order and never duplicates or reorders", () => {
    expect(moves("files", "changes", "browser").openTabs).toEqual(["files", "changes", "browser"]);
    expect(moves("files", "changes", "files", "changes").openTabs).toEqual(["files", "changes"]);
  });

  it("adds a tab a link or the browser opened", () => {
    const noted = noteDockShown(rememberDockMove(undefined, "files"), "browser");
    expect(noted?.openTabs).toEqual(["files", "browser"]);
    expect(noted?.lastTab).toBe("browser");
    expect(noteDockShown(undefined, "changes")?.openTabs).toEqual(["changes"]);
  });

  it("returns the same memory when the shown tab is already open and last", () => {
    const memory = moves("files", "changes");
    expect(noteDockShown(memory, "changes")).toBe(memory);
    const reopened = moves("files", "changes", "files");
    expect(noteDockShown(reopened, "files")).toBe(reopened);
  });

  it("notes a tab that is open but not last without re-adding it", () => {
    const memory = moves("files", "changes");
    const noted = noteDockShown(memory, "files");
    expect(noted).not.toBe(memory);
    expect(noted?.openTabs).toBe(memory.openTabs);
    expect(noted?.lastTab).toBe("files");
  });
});

describe("dockStripTabs", () => {
  it("shows the open tabs", () => {
    const memory = rememberDockMove(rememberDockMove(undefined, "files"), "changes");
    expect(dockStripTabs(memory, "changes")).toBe(memory.openTabs);
    expect(dockStripTabs(memory, "home")).toEqual(["files", "changes"]);
  });

  it("adds the current tab before the memory has caught up", () => {
    const memory = rememberDockMove(undefined, "files");
    expect(dockStripTabs(memory, "browser")).toEqual(["files", "browser"]);
    expect(dockStripTabs(undefined, "changes")).toEqual(["changes"]);
  });

  it("is empty for a dock that never opened a tab", () => {
    expect(dockStripTabs(undefined, "home")).toEqual([]);
    expect(dockStripTabs(undefined, undefined)).toEqual([]);
  });
});

describe("unopenedDockTabs", () => {
  it("lists the offered kinds not open, in offered order", () => {
    expect(unopenedDockTabs(["changes", "browser", "files"], ["files"])).toEqual([
      "changes",
      "browser",
    ]);
    expect(unopenedDockTabs(projectDockTabs, ["files", "changes"])).toEqual([]);
    expect(unopenedDockTabs(projectDockTabs, [])).toEqual(["changes", "files"]);
  });
});

describe("closeDockTab", () => {
  const memory: DockMemory = {
    shown: "browser",
    lastTab: "browser",
    openTabs: ["files", "browser", "changes"],
  };

  it("moves to the right neighbour when closing the tab on show", () => {
    const closed = closeDockTab(memory, "browser", "browser");
    expect(closed.pane).toBe("changes");
    expect(closed.memory).toEqual({
      shown: "changes",
      lastTab: "changes",
      openTabs: ["files", "changes"],
    });
  });

  it("moves to the left neighbour when closing the rightmost", () => {
    const closed = closeDockTab(
      { ...memory, shown: "changes", lastTab: "changes" },
      "changes",
      "changes",
    );
    expect(closed.pane).toBe("browser");
    expect(closed.memory.openTabs).toEqual(["files", "browser"]);
    expect(closed.memory.lastTab).toBe("browser");
  });

  it("keeps the pane when closing a tab not on show", () => {
    const closed = closeDockTab(memory, "files", "browser");
    expect(closed.pane).toBe("browser");
    expect(closed.memory).toEqual({
      shown: "browser",
      lastTab: "browser",
      openTabs: ["browser", "changes"],
    });
  });

  it("never makes an auto-opened pane the one arriving reopens by closing another tab", () => {
    // Files opened, the dock closed, then the agent's browser opened itself.
    const shut = rememberDockMove(rememberDockMove(undefined, "files"), null);
    const auto = noteDockShown(shut, "browser");
    expect(auto?.shown).toBeUndefined();
    const closed = closeDockTab(auto, "files", "browser");
    expect(closed.pane).toBe("browser");
    expect(closed.memory.openTabs).toEqual(["browser"]);
    expect(closed.memory.shown).toBeUndefined();
    expect(dockArrivalTarget(closed.memory)).toBeUndefined();
  });

  it("forgets the user's pane when the tab closed was it, behind an auto-opened one", () => {
    const auto = noteDockShown(rememberDockMove(undefined, "files"), "browser");
    expect(auto?.shown).toBe("files");
    const closed = closeDockTab(auto, "files", "browser");
    expect(closed.memory.shown).toBeUndefined();
    expect(dockArrivalTarget(closed.memory)).toBeUndefined();
  });

  it("falls back to the last open tab when the launcher shows and the last tab closes", () => {
    const closed = closeDockTab({ ...memory, shown: "home" }, "browser", "home");
    expect(closed.pane).toBe("home");
    expect(closed.memory.lastTab).toBe("changes");
  });

  it("shows the launcher and forgets the last tab after the last close", () => {
    const closed = closeDockTab(rememberDockMove(undefined, "files"), "files", "files");
    expect(closed.pane).toBe("home");
    expect(closed.memory.openTabs).toEqual([]);
    expect(closed.memory.lastTab).toBeUndefined();
    const shut = rememberDockMove(closed.memory, null);
    expect(dockToggleTarget(undefined, shut.lastTab)).toBe("home");
  });

  it("closes a tab the memory has not caught up with", () => {
    const closed = closeDockTab(rememberDockMove(undefined, "files"), "browser", "browser");
    expect(closed.pane).toBe("files");
    expect(closed.memory.openTabs).toEqual(["files"]);
  });

  it("reopens on the remaining active tab after the dock is closed", () => {
    const closed = closeDockTab(memory, "browser", "browser");
    const shut = rememberDockMove(closed.memory, null);
    expect(dockToggleTarget(undefined, shut.lastTab)).toBe("changes");
    expect(dockStripTabs(shut, "changes")).toEqual(["files", "changes"]);
  });

  it("leaves everything alone for a tab that is not open", () => {
    const closed = closeDockTab(memory, "files", "browser");
    expect(closeDockTab(closed.memory, "files", "browser").memory).toBe(closed.memory);
  });
});

describe("adjacentDockTab", () => {
  it("steps along the strip and wraps", () => {
    expect(adjacentDockTab("changes", 1)).toBe("browser");
    expect(adjacentDockTab("files", 1)).toBe("agents");
    expect(adjacentDockTab("agents", 1)).toBe("changes");
    expect(adjacentDockTab("changes", -1)).toBe("agents");
  });

  it("steps from the launcher's tab stop, the first tab", () => {
    expect(adjacentDockTab("home", 1)).toBe("browser");
    expect(adjacentDockTab("home", -1)).toBe("agents");
    expect(adjacentDockTab("home", 1)).toBe(adjacentDockTab("changes", 1));
  });
});

describe("a project's dock", () => {
  it("offers Changes and Files, and no Browser", () => {
    expect(projectDockTabs).toEqual(["changes", "files"]);
  });

  it("steps along its own strip, from the launcher too", () => {
    expect(adjacentDockTab("changes", 1, projectDockTabs)).toBe("files");
    expect(adjacentDockTab("files", 1, projectDockTabs)).toBe("changes");
    expect(adjacentDockTab("changes", -1, projectDockTabs)).toBe("files");
    expect(adjacentDockTab("home", 1, projectDockTabs)).toBe("files");
  });

  it("steps from its first tab when asked from a tab it does not hold", () => {
    expect(adjacentDockTab("browser", 1, projectDockTabs)).toBe("files");
  });

  it("reads a Browser `?pane=` as a closed dock", () => {
    expect(isProjectDockPane("changes")).toBe(true);
    expect(isProjectDockPane("files")).toBe(true);
    expect(isProjectDockPane("home")).toBe(true);
    expect(isProjectDockPane("browser")).toBe(false);
    expect(isProjectDockPane(undefined)).toBe(false);
  });
});

describe("dockTabKeyAction", () => {
  const key = (
    name: string,
    mods: Partial<Record<"altKey" | "ctrlKey" | "metaKey" | "shiftKey", boolean>> = {},
  ) => ({
    key: name,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
  });

  it("closes on a bare Delete or Backspace and steps on a bare arrow", () => {
    expect(dockTabKeyAction(key("Delete"))).toBe("close");
    expect(dockTabKeyAction(key("Backspace"))).toBe("close");
    expect(dockTabKeyAction(key("ArrowRight"))).toBe(1);
    expect(dockTabKeyAction(key("ArrowLeft"))).toBe(-1);
    expect(dockTabKeyAction(key("Enter"))).toBeNull();
  });

  it("leaves a modified key to the app's chords, so Mod+Alt+Backspace still deletes the thread", () => {
    expect(dockTabKeyAction(key("Backspace", { metaKey: true, altKey: true }))).toBeNull();
    expect(dockTabKeyAction(key("Backspace", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(dockTabKeyAction(key("Backspace", { shiftKey: true }))).toBeNull();
    expect(dockTabKeyAction(key("Delete", { altKey: true }))).toBeNull();
    expect(dockTabKeyAction(key("ArrowLeft", { altKey: true }))).toBeNull();
  });
});
