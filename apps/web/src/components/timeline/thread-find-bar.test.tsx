import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThreadFindBar } from "@/components/timeline/thread-find-bar";
import type { ThreadFind } from "@/components/timeline/use-thread-find";

const find = (over: Partial<ThreadFind> = {}): ThreadFind => ({
  open: true,
  query: "deploy",
  setQuery: () => {},
  searching: true,
  count: 12,
  index: 2,
  step: () => {},
  close: () => {},
  focusKey: 0,
  highlight: null,
  ...over,
});

describe("ThreadFindBar", () => {
  it("shows the current match and the count, with a named button for each step", () => {
    const html = renderToStaticMarkup(<ThreadFindBar find={find()} />);
    expect(html).toContain('aria-label="Find in thread"');
    expect(html).toContain(">3/12<");
    for (const label of ["Previous match", "Next match", "Close find"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
  });

  it("shows 0/0 without matches and no count before a query is searched", () => {
    expect(renderToStaticMarkup(<ThreadFindBar find={find({ count: 0, index: -1 })} />)).toContain(
      ">0/0<",
    );
    const idle = renderToStaticMarkup(
      <ThreadFindBar find={find({ query: "", searching: false, count: 0, index: -1 })} />,
    );
    expect(idle).not.toContain("0/0");
  });
});
