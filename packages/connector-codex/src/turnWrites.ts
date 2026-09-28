/**
 * The files a turn wrote that no file-change item accounts for.
 *
 * The CLI reports each turn's whole diff as it grows (`turn/diff/updated`),
 * and every file change it applies as a `fileChange` item, which is what it
 * asks about and what the gate counts. A write that shows in the diff with
 * no such item came some other way — seen once on 0.156.1, a patch applied
 * from inside the CLI's scripted `exec` tool, with no request and no item — so
 * the gate adds it to the turn's ungated warning (`toolGate.ts`).
 *
 * On the recordings only file changes reach the diff: a command's write does
 * not (`conformance`: `printf … > conformance.txt` sends none). The diff names
 * paths relative to the repository and an item names them absolute, so a
 * diff path is accounted for by any item path that ends with it.
 */

import { pathsOfChanges } from "./approvals";
import { asRecord, asString, type Json } from "./translate/pending";

/** Every path a unified diff writes: the `b/` side of each file header. */
export const diffPaths = (diff: string): ReadonlyArray<string> => {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (header?.[1] !== undefined) paths.add(header[1]);
  }
  return [...paths];
};

export interface TurnWrites {
  readonly observe: (method: string, params: Json) => void;
  /** How many paths the turn's diff wrote that no file-change item names. */
  readonly unaccounted: () => number;
  readonly clear: () => void;
}

export const makeTurnWrites = (): TurnWrites => {
  let written: ReadonlyArray<string> = [];
  const itemPaths = new Set<string>();
  return {
    observe: (method, params) => {
      if (method === "turn/diff/updated") {
        // Each update is the turn's whole diff so far, not an increment.
        written = diffPaths(asString(params.diff) ?? "");
        return;
      }
      if (method !== "item/started" && method !== "item/completed") return;
      const item = asRecord(params.item);
      if (asString(item.type) !== "fileChange") return;
      for (const path of pathsOfChanges(item.changes)) itemPaths.add(path);
    },
    unaccounted: () =>
      written.filter(
        (path) =>
          !itemPaths.has(path) && ![...itemPaths].some((itemPath) => itemPath.endsWith(`/${path}`)),
      ).length,
    clear: () => {
      written = [];
      itemPaths.clear();
    },
  };
};
