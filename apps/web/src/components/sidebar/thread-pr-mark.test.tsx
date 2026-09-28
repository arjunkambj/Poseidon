import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeThreadId } from "@poseidon/contracts/ids";
import type { PullRequestMark } from "@poseidon/contracts/pullRequest";

import { ThreadPrMark } from "./thread-pr-mark";

const seen = vi.hoisted(() => ({
  navigate: vi.fn<(options: unknown) => Promise<void>>(async () => {}),
  clicks: [] as Array<(event: unknown) => void>,
}));

type Slot = { readonly children?: React.ReactNode; readonly render?: React.ReactElement };

// The tooltip is portalled, which a static render leaves out; render its parts
// in place and keep the trigger's click so a test can press it without a DOM.
vi.mock("@poseidon/ui/components/tooltip", () => ({
  Tooltip: ({ children }: Slot) => <>{children}</>,
  TooltipContent: ({ children }: Slot) => <span data-tooltip="">{children}</span>,
  TooltipTrigger: ({ children, render }: Slot) => {
    if (render === undefined) {
      return <>{children}</>;
    }
    const { onClick } = render.props as { readonly onClick?: (event: unknown) => void };
    if (onClick !== undefined) {
      seen.clicks.push(onClick);
    }
    return React.cloneElement(render, undefined, children);
  },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => seen.navigate }));
// Only the view is rendered here; the marks atom is the hook's, not the glyph's.
vi.mock("@/components/panes/pull-request/pull-request-atoms", () => ({
  usePullRequestAtoms: () => ({}),
}));

const threadId = makeThreadId();

const mark = (overrides: Partial<PullRequestMark> = {}): PullRequestMark => ({
  threadId,
  number: 12,
  url: "https://github.com/acme/app/pull/12",
  state: "open",
  isDraft: false,
  failing: false,
  ...overrides,
});

beforeEach(() => {
  seen.navigate.mockClear();
  seen.clicks.length = 0;
});

describe("ThreadPrMark", () => {
  it("renders nothing when the branch has no pull request", () => {
    expect(renderToStaticMarkup(<ThreadPrMark threadId={threadId} mark={null} />)).toBe("");
  });

  it("tints a merged pull request with the merge glyph and names it", () => {
    const html = renderToStaticMarkup(
      <ThreadPrMark threadId={threadId} mark={mark({ state: "merged" })} />,
    );
    expect(html).toContain('data-pull-request="merged"');
    expect(html).toContain("text-primary");
    expect(html).toContain('aria-label="PR #12 · Merged"');
    expect(html).toContain('role="button"');
  });

  it("says when an open pull request's checks fail", () => {
    const html = renderToStaticMarkup(
      <ThreadPrMark threadId={threadId} mark={mark({ failing: true })} />,
    );
    expect(html).toContain('data-pull-request="failing"');
    expect(html).toContain("text-destructive");
    expect(html).toContain("PR #12 · Open · Checks failing");
  });

  it("opens the thread on its Pull request tab and keeps the row's link from following", () => {
    renderToStaticMarkup(<ThreadPrMark threadId={threadId} mark={mark()} />);
    expect(seen.clicks).toHaveLength(1);
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    seen.clicks[0]?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(seen.navigate).toHaveBeenCalledWith({
      to: "/t/$threadId",
      params: { threadId },
      search: { pane: "pullRequest" },
    });
  });
});
