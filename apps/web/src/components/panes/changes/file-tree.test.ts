import { describe, expect, it } from "vitest";

import {
  buildFileTree,
  filterTree,
  moveFocus,
  statusLetter,
  treeFiles,
  visibleRows,
  type TreeFileInput,
  type TreeNode,
} from "./file-tree";

const file = (path: string, extra: Partial<TreeFileInput> = {}): TreeFileInput => ({
  path,
  kind: "edit",
  additions: 1,
  deletions: 0,
  ...extra,
});

/** The tree as `name` lines, folders suffixed with `/`, indented two spaces per level. */
const outline = (nodes: ReadonlyArray<TreeNode>, depth = 0): ReadonlyArray<string> =>
  nodes.flatMap((node) =>
    node.type === "folder"
      ? [`${"  ".repeat(depth)}${node.name}/`, ...outline(node.children, depth + 1)]
      : [`${"  ".repeat(depth)}${node.name}`],
  );

describe("buildFileTree", () => {
  it("compresses chains of single folders into one row", () => {
    const tree = buildFileTree([
      file("apps/web/src/a.ts"),
      file("apps/web/src/lib/b.ts"),
      file("README.md"),
    ]);
    expect(outline(tree)).toEqual(["apps/web/src/", "  lib/", "    b.ts", "  a.ts", "README.md"]);
    const folder = tree[0];
    expect(folder?.type === "folder" && folder.path).toBe("apps/web/src");
    const lib = folder?.type === "folder" ? folder.children[0] : undefined;
    expect(lib?.path).toBe("apps/web/src/lib");
  });

  it("does not compress a folder that holds files beside its one folder", () => {
    const tree = buildFileTree([file("a/x.ts"), file("a/b/y.ts")]);
    expect(outline(tree)).toEqual(["a/", "  b/", "    y.ts", "  x.ts"]);
  });

  it("sorts folders before files, each by name", () => {
    const tree = buildFileTree([
      file("z.ts"),
      file("b/one.ts"),
      file("a.ts"),
      file("a/two.ts"),
      file("b/c/three.ts"),
    ]);
    expect(outline(tree)).toEqual([
      "a/",
      "  two.ts",
      "b/",
      "  c/",
      "    three.ts",
      "  one.ts",
      "a.ts",
      "z.ts",
    ]);
  });

  it("carries each file's path, kind, old path and counts", () => {
    const [node] = buildFileTree([
      file("src/new.ts", { kind: "create", oldPath: "src/old.ts", additions: 3, deletions: 2 }),
    ]);
    const leaf = node?.type === "folder" ? node.children[0] : undefined;
    expect(leaf).toEqual({
      type: "file",
      name: "new.ts",
      path: "src/new.ts",
      kind: "create",
      oldPath: "src/old.ts",
      additions: 3,
      deletions: 2,
    });
  });

  it("lists the files back in tree order", () => {
    const tree = buildFileTree([file("b.ts"), file("a/c.ts")]);
    expect(treeFiles(tree).map((leaf) => leaf.path)).toEqual(["a/c.ts", "b.ts"]);
  });
});

describe("filterTree", () => {
  const tree = buildFileTree([
    file("apps/web/src/Button.tsx"),
    file("apps/web/src/lib/utils.ts"),
    file("apps/server/main.ts"),
    file("README.md"),
  ]);

  it("keeps everything for an empty or blank query", () => {
    expect(filterTree(tree, "")).toBe(tree);
    expect(filterTree(tree, "  ")).toBe(tree);
  });

  it("keeps matching files and the folders above them, ignoring case", () => {
    expect(outline(filterTree(tree, "button"))).toEqual(["apps/web/src/", "  Button.tsx"]);
  });

  it("matches on the full path, so a folder name keeps its files", () => {
    expect(outline(filterTree(tree, "SERVER"))).toEqual(["apps/server/", "  main.ts"]);
  });

  it("drops everything when nothing matches", () => {
    expect(filterTree(tree, "nothing")).toEqual([]);
  });
});

describe("visibleRows", () => {
  const tree = buildFileTree([file("a/b/one.ts"), file("a/two.ts"), file("three.ts")]);

  it("lists every node depth first with depth and parent when all are open", () => {
    const rows = visibleRows(tree, new Set());
    expect(rows.map((row) => [row.node.name, row.depth, row.parent, row.expanded])).toEqual([
      ["a", 0, -1, true],
      ["b", 1, 0, true],
      ["one.ts", 2, 1, false],
      ["two.ts", 1, 0, false],
      ["three.ts", 0, -1, false],
    ]);
  });

  it("hides a collapsed folder's descendants", () => {
    const rows = visibleRows(tree, new Set(["a"]));
    expect(rows.map((row) => [row.node.name, row.expanded])).toEqual([
      ["a", false],
      ["three.ts", false],
    ]);
  });

  it("keeps a nested folder's own state under an open parent", () => {
    const rows = visibleRows(tree, new Set(["a/b"]));
    expect(rows.map((row) => row.node.name)).toEqual(["a", "b", "two.ts", "three.ts"]);
  });
});

describe("statusLetter", () => {
  it("reads A, D, R and M", () => {
    expect(statusLetter({ kind: "create" })).toBe("A");
    expect(statusLetter({ kind: "delete" })).toBe("D");
    expect(statusLetter({ kind: "edit" })).toBe("M");
    expect(statusLetter({ kind: "edit", oldPath: "old.ts" })).toBe("R");
  });
});

describe("moveFocus", () => {
  // a/ (0) > b/ (1) > one.ts (2); a/two.ts (3); three.ts (4)
  const tree = buildFileTree([file("a/b/one.ts"), file("a/two.ts"), file("three.ts")]);
  const rows = visibleRows(tree, new Set());

  it("steps down and up, stopping at the ends", () => {
    expect(moveFocus(rows, 0, "ArrowDown")).toEqual({ focus: 1 });
    expect(moveFocus(rows, 4, "ArrowDown")).toEqual({ focus: 4 });
    expect(moveFocus(rows, 2, "ArrowUp")).toEqual({ focus: 1 });
    expect(moveFocus(rows, 0, "ArrowUp")).toEqual({ focus: 0 });
  });

  it("starts from the ends with nothing focused", () => {
    expect(moveFocus(rows, -1, "ArrowDown")).toEqual({ focus: 0 });
    expect(moveFocus(rows, -1, "ArrowUp")).toEqual({ focus: 4 });
    expect(moveFocus(rows, -1, "ArrowLeft")).toEqual({ focus: 0 });
    expect(moveFocus(rows, -1, "ArrowRight")).toEqual({ focus: 0 });
  });

  it("jumps to the first and last rows on Home and End", () => {
    expect(moveFocus(rows, 3, "Home")).toEqual({ focus: 0 });
    expect(moveFocus(rows, 1, "End")).toEqual({ focus: 4 });
  });

  it("folds an open folder on Left, else moves to the parent", () => {
    expect(moveFocus(rows, 1, "ArrowLeft")).toEqual({ focus: 1, collapse: "a/b" });
    expect(moveFocus(rows, 2, "ArrowLeft")).toEqual({ focus: 1 });
    expect(moveFocus(rows, 3, "ArrowLeft")).toEqual({ focus: 0 });
    // A top-level file has no parent to go to.
    expect(moveFocus(rows, 4, "ArrowLeft")).toEqual({ focus: 4 });
    const folded = visibleRows(tree, new Set(["a"]));
    expect(moveFocus(folded, 0, "ArrowLeft")).toEqual({ focus: 0 });
  });

  it("unfolds a closed folder on Right, else moves to its first child", () => {
    const folded = visibleRows(tree, new Set(["a"]));
    expect(moveFocus(folded, 0, "ArrowRight")).toEqual({ focus: 0, expand: "a" });
    expect(moveFocus(rows, 0, "ArrowRight")).toEqual({ focus: 1 });
    // A file stays put.
    expect(moveFocus(rows, 2, "ArrowRight")).toEqual({ focus: 2 });
  });

  it("ignores other keys and an empty tree", () => {
    expect(moveFocus(rows, 0, "Enter")).toBeNull();
    expect(moveFocus([], 0, "ArrowDown")).toBeNull();
  });
});
