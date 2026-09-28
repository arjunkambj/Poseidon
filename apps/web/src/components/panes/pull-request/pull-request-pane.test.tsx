import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeThreadId } from "@poseidon/contracts/ids";
import type { PullRequestDetail, PullRequestView } from "@poseidon/contracts/pullRequest";

import type { CommentActions } from "./pr-comment";
import { PullRequestPaneView } from "./pull-request-pane";
import { useCommentActions } from "./use-comment-actions";

// What the last render handed out and what the actions reached, so a test
// can press a button without a DOM.
const seen = vi.hoisted(() => ({
  clicks: new Map<string, Array<() => void>>(),
  setText: vi.fn<(update: (current: string) => string) => void>(),
  setChangesScope: vi.fn<(scope: string) => void>(),
  dispatch: vi.fn<(command: string) => void>(),
  navigate: vi.fn<(options: unknown) => Promise<void>>(async () => {}),
  toast: vi.fn<(text: string) => void>(),
}));

type Slot = { readonly children?: React.ReactNode; readonly render?: React.ReactElement };

// The tooltips are portalled, which a static render leaves out; render their
// parts in place so the body can be read.
vi.mock("@poseidon/ui/components/tooltip", () => ({
  Tooltip: ({ children }: Slot) => <>{children}</>,
  TooltipContent: ({ children }: Slot) => <span data-tooltip="">{children}</span>,
  TooltipTrigger: ({ children, render }: Slot) =>
    render === undefined ? <>{children}</> : React.cloneElement(render, undefined, children),
}));
vi.mock("@poseidon/ui/components/button", () => ({
  Button: ({
    children,
    onClick,
    "aria-label": label,
  }: {
    readonly children?: React.ReactNode;
    readonly onClick?: () => void;
    readonly "aria-label"?: string;
  }) => {
    const text = React.Children.toArray(children).find((child) => typeof child === "string");
    const name = label ?? (typeof text === "string" ? text : undefined);
    if (name !== undefined && onClick !== undefined) {
      seen.clicks.set(name, [...(seen.clicks.get(name) ?? []), onClick]);
    }
    return (
      <button type="button" aria-label={label}>
        {children}
      </button>
    );
  },
}));
// The markdown renderer pulls in the highlighter; the body text is enough here.
vi.mock("@/components/timeline/markdown", () => ({
  MarkdownBody: ({ text }: { readonly text: string }) => <div data-markdown="">{text}</div>,
}));
vi.mock("@/state/ui", () => ({
  useComposerDraft: () => ({ setText: seen.setText }),
  useChangesScope: () => ["turn", seen.setChangesScope],
}));
vi.mock("@/lib/shortcuts", () => ({ useKeybindingDispatch: () => seen.dispatch }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => seen.navigate }));
vi.mock("sonner", () => ({ toast: { success: seen.toast } }));

const noActions: CommentActions = { onAddToChat: () => {}, onOpenInChanges: () => {} };

const render = (view: PullRequestView | null, actions: CommentActions = noActions) =>
  renderToStaticMarkup(
    <PullRequestPaneView
      query={view === null ? null : { _tag: "ok", value: view }}
      connected
      onRefresh={() => {}}
      actions={actions}
    />,
  );

const pullRequest: PullRequestDetail = {
  number: 42,
  title: "Teach the parser about tabs",
  url: "https://github.com/o/r/pull/42",
  state: "open",
  isDraft: false,
  baseRefName: "main",
  headRefName: "tabs",
  headRefOid: "0123456789abcdef0123456789abcdef01234567",
  author: "ana",
  updatedAt: "2026-09-28T11:00:00Z",
  mergeable: "mergeable",
  reviewDecision: "changes-requested",
  checks: [
    {
      name: "lint",
      workflow: "CI",
      bucket: "fail",
      startedAt: "2026-09-28T10:00:00Z",
      completedAt: "2026-09-28T10:00:42Z",
      url: "https://github.com/o/r/actions/runs/1/job/7",
      jobId: "7",
    },
    {
      name: "unit",
      workflow: "CI",
      bucket: "pass",
      startedAt: "2026-09-28T10:00:00Z",
      completedAt: "2026-09-28T10:03:00Z",
      url: "https://github.com/o/r/actions/runs/1/job/8",
      jobId: "8",
    },
  ],
  reviews: [
    { author: "ben", state: "changes-requested", body: "", submittedAt: "2026-09-28T10:30:00Z" },
  ],
  reviewThreads: [
    {
      id: "T1",
      path: "src/parse.ts",
      line: 12,
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          author: "ben",
          body: "This drops the tab width.",
          createdAt: "2026-09-28T10:29:00Z",
          url: "https://github.com/o/r/pull/42#discussion_r1",
        },
      ],
    },
    {
      id: "T2",
      path: "src/lex.ts",
      line: 3,
      isResolved: true,
      isOutdated: true,
      comments: [
        {
          author: "ben",
          body: "Fixed already.",
          createdAt: "2026-09-28T10:28:00Z",
          url: "https://github.com/o/r/pull/42#discussion_r2",
        },
      ],
    },
  ],
  comments: [
    {
      author: "cy",
      body: "Thanks for picking this up.",
      createdAt: "2026-09-28T09:00:00Z",
      url: "https://github.com/o/r/pull/42#issuecomment-1",
    },
  ],
  mergeMethods: { merge: true, squash: true, rebase: false },
};

beforeEach(() => {
  seen.clicks.clear();
  vi.clearAllMocks();
});

describe("PullRequestPaneView", () => {
  it("says the branch has no pull request, naming it", () => {
    const html = render({ state: "none", branch: "tabs" });
    expect(html).toContain("No pull request for this branch.");
    expect(html).toContain("tabs");
  });

  it("says why gh cannot answer, in gh's words", () => {
    const html = render({
      state: "unavailable",
      reason: "gh is not signed in. Run `gh auth login` in a terminal.",
    });
    expect(html).toContain("The GitHub CLI is not ready.");
    expect(html).toContain("gh auth login");
  });

  it("shows a failed read with a retry, and waits while loading", () => {
    const html = renderToStaticMarkup(
      <PullRequestPaneView
        query={{ _tag: "error", message: "HTTP 502" }}
        connected
        onRefresh={() => {}}
        actions={noActions}
      />,
    );
    expect(html).toContain("HTTP 502");
    expect(seen.clicks.get("Try again")).toHaveLength(1);
    expect(render(null)).toContain("Loading pull request…");
  });

  it("shows the summary, failing checks first with durations, and the reviews", () => {
    const html = render({ state: "found", pullRequest });
    expect(html).toContain("Teach the parser about tabs");
    expect(html).toContain("#42");
    expect(html).toContain("main ← tabs");
    expect(html).toContain("@ana");
    expect(html).toContain("1 failing, 1 passing");
    expect(html.indexOf("lint")).toBeLessThan(html.indexOf("unit"));
    expect(html).toContain("42s");
    expect(html).toContain("3m 00s");
    expect(seen.clicks.get("Open the log of lint")).toHaveLength(1);
    expect(html).toContain("Changes requested");
    expect(html).toContain("requested changes");
    expect(html).toContain("src/parse.ts");
    expect(html).toContain("line 12");
    expect(html).toContain("This drops the tab width.");
    expect(html).toContain("1 open, 1 resolved");
    // The resolved thread is folded away.
    expect(html).not.toContain("Fixed already.");
    expect(html).toContain("Thanks for picking this up.");
  });
});

describe("the comment actions", () => {
  const threadId = makeThreadId();

  function Harness() {
    const actions = useCommentActions(threadId);
    return (
      <PullRequestPaneView
        query={{ _tag: "ok", value: { state: "found", pullRequest } }}
        connected
        onRefresh={() => {}}
        actions={actions}
      />
    );
  }

  it("Add to chat appends a quote of the comment to the thread's message", () => {
    renderToStaticMarkup(<Harness />);
    // The review thread's comment, then the conversation's.
    const [review, conversation] = seen.clicks.get("Add to chat") ?? [];
    review?.();
    const update = seen.setText.mock.calls[0]?.[0];
    expect(update?.("Look at this")).toBe(
      "Look at this\n\n`src/parse.ts:12` — @ben:\n> This drops the tab width.",
    );
    expect(seen.dispatch).toHaveBeenCalledWith("composer.focus");
    conversation?.();
    expect(seen.setText.mock.calls[1]?.[0]("")).toBe(
      "Pull request #42 — @cy:\n> Thanks for picking this up.",
    );
  });

  it("Open in Changes shows the branch's diff at the thread's file", () => {
    renderToStaticMarkup(<Harness />);
    seen.clicks.get("Open in Changes")?.[0]?.();
    expect(seen.setChangesScope).toHaveBeenCalledWith("branch");
    const options = seen.navigate.mock.calls[0]?.[0] as {
      readonly params: unknown;
      readonly search: (previous: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(options.params).toEqual({ threadId });
    expect(options.search({ pane: "home", turn: "latest" })).toEqual({
      pane: "changes",
      turn: undefined,
      file: "src/parse.ts",
    });
  });
});
