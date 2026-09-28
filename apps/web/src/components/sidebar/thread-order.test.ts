import { describe, expect, it } from "vitest";

import {
  groupedThreadOrder,
  neighbourThread,
  nthThread,
  projectForNewThread,
  sidebarThreadGroups,
  sidebarThreadOrder,
} from "./thread-order";

const thread = (
  threadId: string,
  projectId: string,
  status: "idle" | "running" | "archived" = "idle",
) => ({ threadId, projectId, status });

const projects = [{ projectId: "p1" }, { projectId: "p2" }];
const none: ReadonlySet<string> = new Set();

const ids = (list: ReadonlyArray<{ threadId: string }>) => list.map((t) => t.threadId);

describe("sidebarThreadOrder", () => {
  it("lists projects in order, each with its threads in list order", () => {
    const threads = [
      thread("b1", "p2"),
      thread("a1", "p1"),
      thread("b2", "p2"),
      thread("a2", "p1"),
    ];
    expect(ids(sidebarThreadOrder(projects, threads, none, null))).toEqual([
      "a1",
      "a2",
      "b1",
      "b2",
    ]);
  });

  it("puts threads whose project is gone last", () => {
    const threads = [thread("x", "gone"), thread("a1", "p1"), thread("b1", "p2")];
    expect(ids(sidebarThreadOrder(projects, threads, none, null))).toEqual(["a1", "b1", "x"]);
    expect(ids(sidebarThreadGroups(projects, threads, none, null).orphans)).toEqual(["x"]);
  });

  it("skips a folded project's threads", () => {
    const threads = [thread("a1", "p1"), thread("a2", "p1"), thread("b1", "p2")];
    expect(ids(sidebarThreadOrder(projects, threads, new Set(["p1"]), null))).toEqual(["b1"]);
  });

  it("keeps the open thread under a folded project", () => {
    const threads = [thread("a1", "p1"), thread("a2", "p1"), thread("b1", "p2")];
    expect(ids(sidebarThreadOrder(projects, threads, new Set(["p1"]), "a2"))).toEqual(["a2", "b1"]);
  });

  it("leaves archived threads out, except the open one", () => {
    const threads = [
      thread("a1", "p1", "archived"),
      thread("a2", "p1"),
      thread("b1", "p2", "archived"),
    ];
    expect(ids(sidebarThreadOrder(projects, threads, none, null))).toEqual(["a2"]);
    expect(ids(sidebarThreadOrder(projects, threads, none, "b1"))).toEqual(["a2", "b1"]);
  });

  it("does not fold orphans", () => {
    const threads = [thread("x1", "gone"), thread("x2", "gone")];
    expect(ids(sidebarThreadOrder(projects, threads, new Set(["gone"]), null))).toEqual([
      "x1",
      "x2",
    ]);
  });

  it("groups by project for the tree", () => {
    const threads = [thread("a1", "p1"), thread("b1", "p2"), thread("a2", "p1")];
    const { byProject } = sidebarThreadGroups(projects, threads, none, null);
    expect(ids(byProject.get("p1") ?? [])).toEqual(["a1", "a2"]);
    expect(ids(byProject.get("p2") ?? [])).toEqual(["b1"]);
  });
});

describe("the Done section", () => {
  const threads = [thread("a1", "p1"), thread("a2", "p1"), thread("a3", "p1"), thread("b1", "p2")];
  const done = new Set(["a1", "a3"]);
  const isDone = (t: { threadId: string }) => done.has(t.threadId);

  it("moves done threads out of the active rows and counts them", () => {
    const groups = sidebarThreadGroups(projects, threads, none, null, { isDone });
    expect(ids(groups.byProject.get("p1") ?? [])).toEqual(["a2"]);
    expect(groups.doneByProject.get("p1")).toBeUndefined();
    expect(groups.doneCount.get("p1")).toBe(2);
    expect(groups.doneCount.get("p2")).toBeUndefined();
  });

  it("lists every done thread while the section is expanded", () => {
    const options = { isDone, doneExpanded: new Set(["p1"]) };
    const groups = sidebarThreadGroups(projects, threads, none, null, options);
    expect(ids(groups.doneByProject.get("p1") ?? [])).toEqual(["a1", "a3"]);
  });

  it("keeps the open thread listed in a collapsed section", () => {
    const groups = sidebarThreadGroups(projects, threads, none, "a3", { isDone });
    expect(ids(groups.doneByProject.get("p1") ?? [])).toEqual(["a3"]);
    expect(groups.doneCount.get("p1")).toBe(2);
  });

  it("walks active rows, then the expanded Done rows, project by project", () => {
    expect(ids(sidebarThreadOrder(projects, threads, none, null, { isDone }))).toEqual([
      "a2",
      "b1",
    ]);
    const options = { isDone, doneExpanded: new Set(["p1"]) };
    expect(ids(sidebarThreadOrder(projects, threads, none, null, options))).toEqual([
      "a2",
      "a1",
      "a3",
      "b1",
    ]);
    const groups = sidebarThreadGroups(projects, threads, none, null, options);
    expect(ids(groupedThreadOrder(projects, groups))).toEqual(["a2", "a1", "a3", "b1"]);
  });

  it("never moves a pinned thread to Done", () => {
    const groups = sidebarThreadGroups(projects, threads, none, null, {
      pinned: ["a1"],
      isDone,
      doneExpanded: new Set(["p1"]),
    });
    expect(ids(groups.pinned)).toEqual(["a1"]);
    expect(ids(groups.doneByProject.get("p1") ?? [])).toEqual(["a3"]);
  });

  it("hides the Done section of a folded project, open thread aside", () => {
    const folded = new Set(["p1"]);
    const options = { isDone, doneExpanded: new Set(["p1"]) };
    const groups = sidebarThreadGroups(projects, threads, folded, "a3", options);
    expect(ids(groups.byProject.get("p1") ?? [])).toEqual(["a3"]);
    expect(groups.doneByProject.get("p1")).toBeUndefined();
    expect(groups.doneCount.get("p1")).toBeUndefined();
  });
});

describe("nthThread", () => {
  const order = [thread("a", "p1"), thread("b", "p1"), thread("c", "p2")];

  it("is 1-based", () => {
    expect(nthThread(order, 1)?.threadId).toBe("a");
    expect(nthThread(order, 3)?.threadId).toBe("c");
  });

  it("is undefined out of range", () => {
    expect(nthThread(order, 4)).toBeUndefined();
    expect(nthThread(order, 9)).toBeUndefined();
    expect(nthThread(order, 0)).toBeUndefined();
    expect(nthThread([], 1)).toBeUndefined();
  });
});

describe("neighbourThread", () => {
  const order = [thread("a", "p1"), thread("b", "p1"), thread("c", "p2")];

  it("steps down and up", () => {
    expect(neighbourThread(order, "a", 1)?.threadId).toBe("b");
    expect(neighbourThread(order, "c", -1)?.threadId).toBe("b");
  });

  it("wraps at both ends", () => {
    expect(neighbourThread(order, "c", 1)?.threadId).toBe("a");
    expect(neighbourThread(order, "a", -1)?.threadId).toBe("c");
  });

  it("starts at the first or last row with no open thread", () => {
    expect(neighbourThread(order, null, 1)?.threadId).toBe("a");
    expect(neighbourThread(order, null, -1)?.threadId).toBe("c");
    expect(neighbourThread(order, "unlisted", 1)?.threadId).toBe("a");
  });

  it("stays on a lone thread and is undefined for none", () => {
    expect(neighbourThread([thread("a", "p1")], "a", 1)?.threadId).toBe("a");
    expect(neighbourThread([], null, 1)).toBeUndefined();
  });
});

describe("projectForNewThread", () => {
  const listed = [{ projectId: "p1" }, { projectId: "p2" }, { projectId: "p3" }];

  it("prefers the open thread's project", () => {
    expect(projectForNewThread(listed, "p3", "p2")?.projectId).toBe("p3");
  });

  it("falls back to the last project, then the first", () => {
    expect(projectForNewThread(listed, undefined, "p2")?.projectId).toBe("p2");
    expect(projectForNewThread(listed, "gone", "p2")?.projectId).toBe("p2");
    expect(projectForNewThread(listed, undefined, "gone")?.projectId).toBe("p1");
    expect(projectForNewThread(listed, undefined, null)?.projectId).toBe("p1");
  });

  it("is undefined with no projects", () => {
    expect(projectForNewThread([], "p1", "p1")).toBeUndefined();
  });
});

describe("pinned threads", () => {
  const threads = [thread("a1", "p1"), thread("a2", "p1"), thread("b1", "p2"), thread("x", "gone")];

  it("come first, in pin order, and leave their own group", () => {
    const pinned = ["b1", "a2"];
    expect(ids(sidebarThreadOrder(projects, threads, none, null, { pinned }))).toEqual([
      "b1",
      "a2",
      "a1",
      "x",
    ]);
    const groups = sidebarThreadGroups(projects, threads, none, null, { pinned });
    expect(ids(groups.pinned)).toEqual(["b1", "a2"]);
    expect(ids(groups.byProject.get("p1") ?? [])).toEqual(["a1"]);
    expect(groups.byProject.get("p2")).toBeUndefined();
  });

  it("takes orphans out of Other threads too", () => {
    const groups = sidebarThreadGroups(projects, threads, none, null, { pinned: ["x"] });
    expect(ids(groups.pinned)).toEqual(["x"]);
    expect(groups.orphans).toEqual([]);
  });

  it("stay listed when their project is folded", () => {
    expect(
      ids(sidebarThreadOrder(projects, threads, new Set(["p1"]), null, { pinned: ["a2"] })),
    ).toEqual(["a2", "b1", "x"]);
  });

  it("hide an archived pinned thread unless it is open", () => {
    const withArchived = [thread("a1", "p1", "archived"), thread("b1", "p2")];
    const pinned = ["a1"];
    expect(ids(sidebarThreadOrder(projects, withArchived, none, null, { pinned }))).toEqual(["b1"]);
    expect(ids(sidebarThreadOrder(projects, withArchived, none, "a1", { pinned }))).toEqual([
      "a1",
      "b1",
    ]);
  });

  it("ignore pins for threads that are gone", () => {
    expect(ids(sidebarThreadOrder(projects, threads, none, null, { pinned: ["deleted"] }))).toEqual(
      ["a1", "a2", "b1", "x"],
    );
  });

  it("are the first rows the thread keys reach", () => {
    const order = sidebarThreadOrder(projects, threads, none, null, { pinned: ["b1"] });
    expect(nthThread(order, 1)?.threadId).toBe("b1");
    expect(neighbourThread(order, null, 1)?.threadId).toBe("b1");
    expect(neighbourThread(order, "b1", 1)?.threadId).toBe("a1");
    // Up from the pinned row wraps to the bottom of the tree.
    expect(neighbourThread(order, "b1", -1)?.threadId).toBe("x");
    expect(neighbourThread(order, "x", 1)?.threadId).toBe("b1");
  });
});
