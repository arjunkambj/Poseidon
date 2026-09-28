/**
 * The Pull request tab's actions and Fix menu, rendered statically with their
 * popups in place: which actions and fixes show, that a pick opens its
 * confirm, Merge's method picker, the fix's preview, and a confirmed action
 * run through a stubbed one-shot to its toast.
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PullRequestCheck, PullRequestDetail } from "@poseidon/contracts/pullRequest";

import { runPrAction, type PrActionOutcome } from "./pr-actions";
import { PrActionsMenuView, type PrActionsMenuViewProps } from "./pr-actions-menu";
import { PrFixMenuView } from "./pr-fix-menu";

// What the last render handed out, so a test can press a button without a DOM.
const seen = vi.hoisted(() => ({
  clicks: new Map<string, () => void>(),
  selectValue: null as ((value: string | null) => void) | null,
}));

type Slot = {
  readonly children?: React.ReactNode;
  readonly render?: React.ReactElement;
  readonly open?: boolean;
};

const textOf = (node: React.ReactNode): string =>
  React.Children.toArray(node)
    .map((child) =>
      typeof child === "string"
        ? child
        : React.isValidElement<{ children?: React.ReactNode }>(child)
          ? textOf(child.props.children)
          : "",
    )
    .join("");

vi.mock("@poseidon/ui/components/dialog", () => {
  const part = ({ children }: Slot) => <div>{children}</div>;
  return {
    Dialog: ({ children, open }: Slot) =>
      open === true ? <div data-dialog="">{children}</div> : null,
    DialogContent: part,
    DialogDescription: part,
    DialogFooter: part,
    DialogHeader: part,
    DialogTitle: part,
  };
});
vi.mock("@poseidon/ui/components/dropdown-menu", () => {
  const part = ({ children }: Slot) => <div>{children}</div>;
  return {
    DropdownMenu: part,
    DropdownMenuContent: part,
    DropdownMenuTrigger: ({ children, render }: Slot) =>
      render === undefined ? <>{children}</> : React.cloneElement(render, undefined, children),
    DropdownMenuItem: ({
      children,
      disabled,
      onClick,
    }: Slot & { readonly disabled?: boolean; readonly onClick?: () => void }) => {
      if (onClick !== undefined && disabled !== true) {
        seen.clicks.set(`item:${textOf(children)}`, onClick);
      }
      return <div data-item={disabled === true ? "disabled" : "enabled"}>{children}</div>;
    },
  };
});
vi.mock("@poseidon/ui/components/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: Slot & { readonly value?: string; readonly onValueChange?: (v: string | null) => void }) => {
    seen.selectValue = onValueChange ?? null;
    return <div data-select={value}>{children}</div>;
  },
  SelectTrigger: ({ children }: Slot) => <div>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }: Slot) => <div>{children}</div>,
  SelectItem: ({ children, value }: Slot & { readonly value: string }) => (
    <div data-option={value}>{children}</div>
  ),
}));
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
    const name = label ?? textOf(children);
    if (onClick !== undefined) {
      seen.clicks.set(name, onClick);
    }
    return (
      <button type="button" aria-label={label}>
        {children}
      </button>
    );
  },
}));

const check = (name: string, bucket: PullRequestCheck["bucket"]): PullRequestCheck => ({
  name,
  workflow: "CI",
  bucket,
  startedAt: null,
  completedAt: null,
  url: null,
  jobId: null,
});

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
  reviewDecision: null,
  checks: [check("lint", "fail")],
  reviews: [],
  reviewThreads: [],
  comments: [],
  mergeMethods: { merge: true, squash: false, rebase: true },
};

const renderMenu = (props: Partial<PrActionsMenuViewProps> = {}) => {
  const handlers = {
    onConfirming: vi.fn(),
    onMethod: vi.fn(),
    onConfirm: vi.fn(),
  };
  const html = renderToStaticMarkup(
    <PrActionsMenuView
      pullRequest={pullRequest}
      confirming={null}
      method="merge"
      {...handlers}
      {...props}
    />,
  );
  return { html, ...handlers };
};

beforeEach(() => {
  seen.clicks.clear();
  seen.selectValue = null;
});

describe("PrActionsMenuView", () => {
  it("leads with Merge and keeps the rest behind the menu, the confirm closed", () => {
    const { html, onConfirming } = renderMenu();
    expect(html).not.toContain("data-dialog");
    expect(html).toContain("More actions");
    seen.clicks.get("Merge")?.();
    expect(onConfirming).toHaveBeenCalledWith("merge");
    seen.clicks.get("item:Close")?.();
    expect(onConfirming).toHaveBeenLastCalledWith("close");
    expect(seen.clicks.has("item:Convert to draft")).toBe(true);
  });

  it("lists a blocked merge disabled with its reason and leads with the next action", () => {
    const { html } = renderMenu({ pullRequest: { ...pullRequest, mergeable: "conflicting" } });
    expect(html).toContain("The branch conflicts with main. Resolve the conflicts first.");
    expect(seen.clicks.has("item:Merge")).toBe(false);
    expect(seen.clicks.has("Convert to draft")).toBe(true);
  });

  it("renders nothing for a merged pull request", () => {
    expect(renderMenu({ pullRequest: { ...pullRequest, state: "merged" } }).html).toBe("");
  });

  it("opens Merge's confirm with the allowed methods and the failing-checks warning", () => {
    const { html, onMethod, onConfirm } = renderMenu({ confirming: "merge" });
    expect(html).toContain("Merge #42 into main?");
    expect(html).toContain('data-select="merge"');
    expect(html).toContain('data-option="merge"');
    expect(html).toContain('data-option="rebase"');
    expect(html).not.toContain('data-option="squash"');
    expect(html).toContain("1 check is failing.");
    seen.selectValue?.("rebase");
    expect(onMethod).toHaveBeenCalledWith("rebase");
    seen.clicks.get("Merge")?.();
    // The dialog's own button — the header's Merge was registered first and replaced.
    expect(onConfirm).toHaveBeenCalledWith("merge", "merge");
  });

  it("opens one confirm with no picker for the other actions", () => {
    const { html, onConfirm } = renderMenu({ confirming: "close" });
    expect(html).toContain("Close #42?");
    expect(html).not.toContain("data-select");
    seen.clicks.get("Close pull request")?.();
    expect(onConfirm).toHaveBeenCalledWith("close", "merge");
  });
});

describe("a confirmed action through a stubbed one-shot", () => {
  it("shows the pending toast, then the failure in gh's words in its place", async () => {
    const toasts: Array<[string, string, string]> = [];
    const toast = {
      loading: (message: string, { id }: { id: string }) => toasts.push(["loading", message, id]),
      success: (message: string, { id }: { id: string }) => toasts.push(["success", message, id]),
      error: (message: string, { id }: { id: string }) => toasts.push(["error", message, id]),
    };
    let settle: (outcome: PrActionOutcome) => void = () => {};
    const oneShot = vi.fn(
      () =>
        new Promise<PrActionOutcome>((resolve) => {
          settle = resolve;
        }),
    );
    const { onConfirm } = renderMenu({ confirming: "merge" });
    seen.clicks.get("Merge")?.();
    const [kind, method] = onConfirm.mock.calls[0] ?? [];
    const running = runPrAction(oneShot, toast, pullRequest, kind, method);
    expect(toasts).toEqual([["loading", "Merging #42…", expect.any(String)]]);
    expect(oneShot).toHaveBeenCalledWith(
      { kind: "merge", method: "merge" },
      pullRequest.headRefOid,
    );
    settle({
      ok: false,
      message: "Pull request #42 is not mergeable: the merge commit cannot be cleanly created.",
    });
    await running;
    expect(toasts[1]).toEqual([
      "error",
      "Merge failed: Pull request #42 is not mergeable: the merge commit cannot be cleanly created.",
      toasts[0]?.[2],
    ]);
  });
});

describe("PrFixMenuView", () => {
  const renderFix = (overrides: Partial<PullRequestDetail>, confirming: null | "checks" = null) => {
    const onConfirming = vi.fn();
    const onFix = vi.fn();
    const html = renderToStaticMarkup(
      <PrFixMenuView
        pullRequest={{ ...pullRequest, ...overrides }}
        target="the worktree at /w/tabs"
        confirming={confirming}
        onConfirming={onConfirming}
        onFix={onFix}
      />,
    );
    return { html, onConfirming, onFix };
  };

  it("lists only the fixes that apply", () => {
    const { html, onConfirming } = renderFix({ mergeable: "conflicting" });
    expect(html).toContain("Fix failing checks");
    expect(html).toContain("Resolve conflicts");
    expect(html).not.toContain("Address review comments");
    seen.clicks.get("item:Resolve conflicts")?.();
    expect(onConfirming).toHaveBeenCalledWith("conflicts");
    expect(renderFix({ checks: [check("unit", "pass")] }).html).toBe("");
  });

  it("confirms with where the thread goes and a preview of its first message", () => {
    const { html, onFix } = renderFix({}, "checks");
    expect(html).toContain("Fix failing checks in a new thread?");
    expect(html).toContain("A new thread starts on tabs in the worktree at /w/tabs");
    expect(html).toContain("Fix the failing checks on pull request #42");
    expect(html).toContain("- lint");
    seen.clicks.get("Start thread")?.();
    expect(onFix).toHaveBeenCalledWith("checks");
  });
});
