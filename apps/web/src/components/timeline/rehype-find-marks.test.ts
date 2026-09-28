import { describe, expect, it } from "vitest";

import { FIND_MARK_CLASSES, rehypeFindMarks } from "@/components/timeline/rehype-find-marks";

interface Node {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: ReadonlyArray<string> };
  children?: Node[];
}

const text = (value: string): Node => ({ type: "text", value });
const element = (tagName: string, children: Node[]): Node => ({
  type: "element",
  tagName,
  properties: {},
  children,
});
const root = (children: Node[]): Node => ({ type: "root", children });

const run = (tree: Node, query: string): Node => {
  rehypeFindMarks(query)()(tree);
  return tree;
};

/** The tree as `text` and `[marked]` runs, element by element. */
const flatten = (node: Node): string => {
  if (node.type === "text") {
    return node.value ?? "";
  }
  const inner = (node.children ?? []).map(flatten).join("");
  return node.tagName === "mark" ? `[${inner}]` : inner;
};

describe("rehypeFindMarks", () => {
  it("cuts a text node into marks, ignoring case", () => {
    const tree = run(root([element("p", [text("Deploy, then deploy again.")])]), "DEPLOY");
    expect(flatten(tree)).toBe("[Deploy], then [deploy] again.");
    const mark = tree.children?.[0]?.children?.[0];
    expect(mark?.tagName).toBe("mark");
    expect(mark?.properties?.className).toEqual([...FIND_MARK_CLASSES]);
  });

  it("marks inside nested inline elements", () => {
    const tree = run(
      root([element("p", [text("Run "), element("code", [text("npm test")]), text(".")])]),
      "test",
    );
    expect(flatten(tree)).toBe("Run npm [test].");
    expect(tree.children?.[0]?.children?.[1]?.children?.[1]?.tagName).toBe("mark");
  });

  it("leaves a fenced block alone", () => {
    const fence = element("pre", [element("code", [text("npm test\n")])]);
    const tree = run(root([element("p", [text("A test:")]), fence]), "test");
    expect(flatten(tree)).toBe("A [test]:npm test\n");
    expect(fence.children?.[0]?.children).toEqual([text("npm test\n")]);
  });

  it("keeps a text node without the query as the same node", () => {
    const untouched = text("Nothing here.");
    const tree = run(root([element("p", [untouched])]), "deploy");
    expect(tree.children?.[0]?.children?.[0]).toBe(untouched);
  });

  it("does nothing for an empty query", () => {
    const before = root([element("p", [text("Deploy")])]);
    const after = run(structuredClone(before), "  ");
    expect(after).toEqual(before);
  });
});
