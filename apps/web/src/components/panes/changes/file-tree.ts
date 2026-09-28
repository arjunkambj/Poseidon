/**
 * The Changes pane's file tree, with no React in the way.
 *
 * `buildFileTree` folds a comparison's flat file list into folders, with a
 * chain of folders that each hold one folder and nothing else shown as one
 * row (`apps/web/src`), folders before files and each group by name.
 * `filterTree` keeps the files whose path holds the filter text and the
 * folders above them; `visibleRows` flattens what is open into the rows the
 * tree renders; `moveFocus` is what each navigation key does to them. A
 * folder is known by its full path — the deepest folder of a compressed
 * chain — which is also what the pane remembers as collapsed.
 */

import type { GitDiffFile } from "@poseidon/contracts/rpc";

/** What the tree needs of one changed file. */
export type TreeFileInput = Pick<
  GitDiffFile,
  "path" | "kind" | "oldPath" | "additions" | "deletions"
>;

export interface TreeFile {
  readonly type: "file";
  /** The file's name, the last segment of `path`. */
  readonly name: string;
  readonly path: string;
  readonly kind: GitDiffFile["kind"];
  readonly oldPath?: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface TreeFolder {
  readonly type: "folder";
  /** The label: one segment, or a compressed chain like `apps/web/src`. */
  readonly name: string;
  /** The full path of the deepest folder in the chain. */
  readonly path: string;
  readonly children: ReadonlyArray<TreeNode>;
}

export type TreeNode = TreeFile | TreeFolder;

interface Draft {
  readonly folders: Map<string, Draft>;
  readonly files: Array<TreeFile>;
}

const byName = (a: TreeNode, b: TreeNode): number =>
  a.type === b.type
    ? a.name < b.name
      ? -1
      : a.name > b.name
        ? 1
        : 0
    : a.type === "folder"
      ? -1
      : 1;

const finish = (draft: Draft, parent: string): ReadonlyArray<TreeNode> => {
  const nodes: Array<TreeNode> = [...draft.files];
  for (const [segment, child] of draft.folders) {
    let name = segment;
    let path = parent === "" ? segment : `${parent}/${segment}`;
    let current = child;
    // A folder holding exactly one folder and no files reads as one row.
    while (current.files.length === 0 && current.folders.size === 1) {
      const [[next, only]] = current.folders;
      name = `${name}/${next}`;
      path = `${path}/${next}`;
      current = only;
    }
    nodes.push({ type: "folder", name, path, children: finish(current, path) });
  }
  return nodes.sort(byName);
};

/** The files as a tree of folders, chains compressed, folders first, then by name. */
export const buildFileTree = (files: ReadonlyArray<TreeFileInput>): ReadonlyArray<TreeNode> => {
  const root: Draft = { folders: new Map(), files: [] };
  for (const file of files) {
    const segments = file.path.split("/");
    const name = segments.pop() ?? file.path;
    let draft = root;
    for (const segment of segments) {
      let next = draft.folders.get(segment);
      if (next === undefined) {
        next = { folders: new Map(), files: [] };
        draft.folders.set(segment, next);
      }
      draft = next;
    }
    draft.files.push({
      type: "file",
      name,
      path: file.path,
      kind: file.kind,
      ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
      additions: file.additions,
      deletions: file.deletions,
    });
  }
  return finish(root, "");
};

/** Every file of the tree, in tree order. */
export const treeFiles = (tree: ReadonlyArray<TreeNode>): ReadonlyArray<TreeFile> =>
  tree.flatMap((node) => (node.type === "file" ? [node] : treeFiles(node.children)));

/**
 * The tree cut to the files whose full path holds `query`, ignoring case, with
 * the folders above them; an empty query keeps everything. Rebuilt from the
 * kept files, so a chain the filter leaves with one folder compresses again.
 * Every folder left holds a match, so the pane shows them all open.
 */
export const filterTree = (
  tree: ReadonlyArray<TreeNode>,
  query: string,
): ReadonlyArray<TreeNode> => {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return tree;
  }
  return buildFileTree(treeFiles(tree).filter((file) => file.path.toLowerCase().includes(needle)));
};

/** One rendered row: a node, how deep it sits, and its parent row. */
export interface TreeRow {
  readonly node: TreeNode;
  /** 0 at the top level. */
  readonly depth: number;
  /** The index of the parent folder's row, `-1` at the top level. */
  readonly parent: number;
  /** For a folder, whether its children are shown. */
  readonly expanded: boolean;
}

/** The rows on screen: every node under an open folder, depth first. */
export const visibleRows = (
  tree: ReadonlyArray<TreeNode>,
  collapsed: ReadonlySet<string>,
): ReadonlyArray<TreeRow> => {
  const rows: Array<TreeRow> = [];
  const walk = (nodes: ReadonlyArray<TreeNode>, depth: number, parent: number) => {
    for (const node of nodes) {
      const expanded = node.type === "folder" && !collapsed.has(node.path);
      rows.push({ node, depth, parent, expanded });
      if (node.type === "folder" && expanded) {
        walk(node.children, depth + 1, rows.length - 1);
      }
    }
  };
  walk(tree, 0, -1);
  return rows;
};

/** The letter a changed file shows: renamed, added, deleted or modified. */
export const statusLetter = (file: Pick<TreeFile, "kind" | "oldPath">): "R" | "A" | "D" | "M" =>
  file.oldPath !== undefined
    ? "R"
    : file.kind === "create"
      ? "A"
      : file.kind === "delete"
        ? "D"
        : "M";

/**
 * What a key does in the tree: the row to focus, and a folder to fold or
 * unfold on the way.
 */
export interface TreeMove {
  readonly focus: number;
  readonly collapse?: string;
  readonly expand?: string;
}

/**
 * The move for `key` from the focused row `index` (`-1` for none), or `null`
 * for a key the tree does not handle or a tree with no rows. Up and Down step
 * one row and stop at the ends, Home and End jump to them. Left folds an open
 * folder, else moves to the parent; Right unfolds a closed folder, else moves
 * into an open one's first child.
 */
export const moveFocus = (
  rows: ReadonlyArray<TreeRow>,
  index: number,
  key: string,
): TreeMove | null => {
  if (rows.length === 0) {
    return null;
  }
  const last = rows.length - 1;
  const row = rows[index];
  switch (key) {
    case "ArrowDown":
      return { focus: Math.min(index + 1, last) };
    case "ArrowUp":
      return { focus: index < 0 ? last : Math.max(index - 1, 0) };
    case "Home":
      return { focus: 0 };
    case "End":
      return { focus: last };
    case "ArrowLeft":
      if (row === undefined) {
        return { focus: 0 };
      }
      if (row.node.type === "folder" && row.expanded) {
        return { focus: index, collapse: row.node.path };
      }
      return { focus: row.parent >= 0 ? row.parent : index };
    case "ArrowRight":
      if (row === undefined) {
        return { focus: 0 };
      }
      if (row.node.type === "folder" && !row.expanded) {
        return { focus: index, expand: row.node.path };
      }
      return {
        focus: row.node.type === "folder" && rows[index + 1]?.parent === index ? index + 1 : index,
      };
    default:
      return null;
  }
};
