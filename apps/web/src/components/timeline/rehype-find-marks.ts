/**
 * Marks the find bar's query in rendered markdown: a rehype plugin that cuts
 * each text node holding the query into plain text and `<mark>` elements,
 * with the same classes the plain-text rows use (`thread-find-context.tsx`).
 *
 * It runs on the hast tree react-markdown builds, so the marks land inside
 * paragraphs, list items, links, emphasis and inline code alike. A `pre`
 * subtree is left alone: a fenced block renders through `CodeBlock` and its
 * highlighter, which read the fence's text off the node and would not show
 * the marks anyway — matches inside a fence are counted but not marked.
 *
 * The match runs over the rendered text, so markup the source carries
 * (`**de**ploy`) splits a word the bar counts once into runs no mark spans.
 * An inline code span holding a match renders as code, not as its file chip,
 * while it is marked: the chip is only offered for a span that is plain text.
 */

import { hasMatch, splitHighlights } from "./thread-find";

/** The classes a marked run carries, on existing tokens only. */
export const FIND_MARK_CLASSES = ["rounded-sm", "bg-primary/15", "text-foreground"] as const;

interface HastText {
  readonly type: "text";
  readonly value: string;
}

interface HastParent {
  readonly type: string;
  readonly tagName?: string;
  children?: Array<HastNode>;
}

type HastNode = HastText | HastParent;

const isText = (node: HastNode): node is HastText => node.type === "text";

const markNode = (value: string): HastParent & Record<string, unknown> => ({
  type: "element",
  tagName: "mark",
  properties: { className: [...FIND_MARK_CLASSES] },
  children: [{ type: "text", value }],
});

const markChildren = (parent: HastParent, query: string): void => {
  if (parent.children === undefined || parent.tagName === "pre") {
    return;
  }
  const next: HastNode[] = [];
  for (const child of parent.children) {
    if (!isText(child)) {
      markChildren(child, query);
      next.push(child);
      continue;
    }
    if (!hasMatch(child.value, query)) {
      next.push(child);
      continue;
    }
    for (const segment of splitHighlights(child.value, query)) {
      next.push(segment.match ? markNode(segment.text) : { type: "text", value: segment.text });
    }
  }
  parent.children = next;
};

/** The plugin for one query; an empty query leaves the tree as it is. */
export const rehypeFindMarks = (query: string) => () => (tree: HastParent) => {
  if (query.trim() !== "") {
    markChildren(tree, query);
  }
};
