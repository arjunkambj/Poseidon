/**
 * Find in thread: what the find bar searches, where each match lives, and
 * what has to open for the reader to see it.
 *
 * The timeline is virtualized, so most rows are not in the DOM and a
 * settled turn's work is not even in the projection until its fold opens.
 * Searching the page would miss them; this searches the thread snapshot
 * instead, walking the projection built with every fold open
 * (`ALL_FOLDS_OPEN`) in display order — the traversal `disclosureIds` uses:
 * top-level rows, the items inside a work group, then a task's children
 * depth-first, so a child's matches come after its task and before the next
 * row.
 *
 * Each item gives one document per text the reader sees on its row: a
 * message's text, a reasoning or plan body, a command line, a tool's name and
 * the file it names, a changed file's path, a search query, a task's title,
 * an error. Command output and tool payloads are left out: they are long, sit
 * behind the row's disclosure as raw output, and would drown the matches the
 * reader is after.
 *
 * Matching is case-insensitive over that source text, non-overlapping, in
 * document order. Offsets index the source text, so the same matcher splits a
 * plain-text row into marked and unmarked runs (`splitHighlights`).
 */

import type { ItemSnapshot } from "@poseidon/contracts/runtime";

import type { TimelineProjection } from "@/components/timeline/fold";
import { toolPathTarget } from "@/components/timeline/tool-target";

/**
 * Which text of an item a document holds. `body` is text inside the row's own
 * disclosure (a reasoning or plan body), so showing it means opening the row.
 */
export type FindField = "text" | "body" | "command" | "name" | "path";

export interface FindDocument {
  readonly itemId: string;
  readonly field: FindField;
  readonly text: string;
}

/** One occurrence: `[start, end)` in the document's text. */
export interface FindMatch {
  readonly itemId: string;
  readonly field: FindField;
  readonly start: number;
  readonly end: number;
}

export interface FindSegment {
  readonly text: string;
  readonly match: boolean;
}

/** Where a match shows: the top-level row to scroll to and the disclosures to open first. */
export interface FindLocation {
  readonly rowId: string;
  readonly open: ReadonlyArray<string>;
}

const stringField = (input: unknown, key: string): string | undefined => {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
};

/** The searchable texts of one item, as its row shows them. */
const itemDocuments = (item: ItemSnapshot): ReadonlyArray<[FindField, string | undefined]> => {
  switch (item.kind) {
    case "user_message":
    case "assistant_message":
    case "skill":
    case "task":
      return [["text", item.text]];
    case "reasoning":
      return [["body", item.text]];
    case "plan":
      return [["body", item.plan?.markdown ?? item.text]];
    case "command_execution":
      return [["command", item.command?.cmd ?? item.text]];
    case "tool_call":
    case "mcp_tool_call":
      return [
        ["name", item.tool?.name ?? item.text],
        ["path", toolPathTarget(item.tool?.input)],
      ];
    case "file_change":
      return [["path", item.fileChange?.path]];
    case "web_search":
      return [["text", stringField(item.tool?.input, "query") ?? item.text]];
    case "error":
      return [["text", item.error?.message ?? item.text]];
    default:
      return [];
  }
};

export const findDocuments = (projection: TimelineProjection): ReadonlyArray<FindDocument> => {
  const documents: FindDocument[] = [];
  const seen = new Set<string>();
  const visit = (item: ItemSnapshot) => {
    if (seen.has(item.itemId)) {
      return;
    }
    seen.add(item.itemId);
    for (const [field, text] of itemDocuments(item)) {
      if (text !== undefined && text !== "") {
        documents.push({ itemId: item.itemId, field, text });
      }
    }
    for (const child of projection.childrenByParent.get(item.itemId) ?? []) {
      visit(child);
    }
  };
  for (const row of projection.rows) {
    if (row.kind === "item") {
      visit(row.item);
    } else if (row.kind === "work-group") {
      row.items.forEach(visit);
    }
  }
  return documents;
};

/** The query to search for, or undefined when there is nothing to search. */
export const normalizeQuery = (query: string): string | undefined => {
  const trimmed = query.trim();
  return trimmed === "" ? undefined : trimmed;
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A case-insensitive matcher for the query. A regular expression rather than
 * lowercasing both sides: lowercasing can change a string's length, and the
 * offsets must index the text as written.
 */
const matcher = (query: string): RegExp => new RegExp(escapeRegExp(query), "giu");

export const findMatches = (
  documents: ReadonlyArray<FindDocument>,
  query: string,
): ReadonlyArray<FindMatch> => {
  const normalized = normalizeQuery(query);
  if (normalized === undefined) {
    return [];
  }
  const pattern = matcher(normalized);
  const matches: FindMatch[] = [];
  for (const { itemId, field, text } of documents) {
    for (const found of text.matchAll(pattern)) {
      matches.push({ itemId, field, start: found.index, end: found.index + found[0].length });
    }
  }
  return matches;
};

/** The next or previous match index, wrapping at either end; -1 when there are none. */
export const stepMatch = (count: number, index: number, direction: "next" | "previous"): number => {
  if (count <= 0) {
    return -1;
  }
  if (index < 0 || index >= count) {
    return direction === "next" ? 0 : count - 1;
  }
  return direction === "next" ? (index + 1) % count : (index - 1 + count) % count;
};

/**
 * Where an item shows, given the projection with every fold open (`allOpen`)
 * and one built with the folds as they are (`shown`, or every fold closed).
 * A top-level row of `allOpen` missing from `shown` sits behind the turn fold
 * before it, so that fold opens first; then the work group holding the item,
 * each task above it, and — for a reasoning or plan body — the row itself.
 */
export const locateItem = (
  allOpen: TimelineProjection,
  shown: TimelineProjection,
  itemId: string,
  field: FindField = "text",
): FindLocation | undefined => {
  const parentOf = new Map<string, string>();
  for (const [parentId, children] of allOpen.childrenByParent) {
    for (const child of children) {
      parentOf.set(child.itemId, parentId);
    }
  }
  const ancestors: string[] = [];
  let topId = itemId;
  for (let parent = parentOf.get(topId); parent !== undefined; parent = parentOf.get(topId)) {
    ancestors.unshift(parent);
    topId = parent;
  }

  const shownIds = new Set(shown.rows.map((row) => row.id));
  let fold: string | undefined;
  for (const row of allOpen.rows) {
    // Only a settled turn's own rows follow its fold, so a hidden row's fold
    // is the last one before it.
    if (row.kind === "turn-fold") {
      fold = row.id;
    }
    const holds =
      (row.kind === "item" && row.item.itemId === topId) ||
      (row.kind === "work-group" && row.items.some((item) => item.itemId === topId));
    if (!holds) {
      continue;
    }
    const open: string[] = [];
    if (fold !== undefined && !shownIds.has(row.id)) {
      open.push(fold);
    }
    if (row.kind === "work-group") {
      open.push(row.id);
    }
    open.push(...ancestors);
    if (field === "body") {
      open.push(itemId);
    }
    return { rowId: row.id, open };
  }
  return undefined;
};

/** `text` cut into marked and unmarked runs for the query; one unmarked run without one. */
export const splitHighlights = (text: string, query: string): ReadonlyArray<FindSegment> => {
  const normalized = normalizeQuery(query);
  if (text === "") {
    return [];
  }
  if (normalized === undefined) {
    return [{ text, match: false }];
  }
  const segments: FindSegment[] = [];
  let cursor = 0;
  for (const found of text.matchAll(matcher(normalized))) {
    if (found.index > cursor) {
      segments.push({ text: text.slice(cursor, found.index), match: false });
    }
    segments.push({ text: found[0], match: true });
    cursor = found.index + found[0].length;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), match: false });
  }
  return segments;
};
