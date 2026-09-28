import { Github } from "@honeyicons/react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { GIT_RUN_PENDING_REASON, GitPrimaryButton } from "@/components/git/git-primary-button";
import type { GitAction } from "@/lib/git-actions";
import type { GitNextStepView } from "@/lib/git-next-step";

// Each button's click handler by its accessible name, so a test can press one
// without a DOM.
const clicks = vi.hoisted(() => new Map<string, () => void>());

type Slot = { readonly children?: React.ReactNode; readonly render?: React.ReactElement };

// Tooltips and the menu are portalled, which a static render leaves out;
// render their parts in place so the tooltip text and the items can be read.
vi.mock("@poseidon/ui/components/tooltip", () => {
  const part = ({ children }: Slot) => <div>{children}</div>;
  return {
    Tooltip: part,
    TooltipContent: ({ children }: Slot) => <div data-tooltip="">{children}</div>,
    TooltipTrigger: ({ children, render }: Slot) =>
      render === undefined ? <>{children}</> : React.cloneElement(render, undefined, children),
  };
});
vi.mock("@poseidon/ui/components/dropdown-menu", () => {
  const part = ({ children }: Slot) => <div>{children}</div>;
  return {
    DropdownMenu: part,
    DropdownMenuContent: part,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: ({ children, render }: Slot) =>
      render === undefined ? <>{children}</> : React.cloneElement(render, undefined, children),
    DropdownMenuItem: ({
      children,
      disabled,
    }: {
      readonly children?: React.ReactNode;
      readonly disabled?: boolean;
    }) => <div data-item={disabled === true ? "disabled" : "enabled"}>{children}</div>,
  };
});
vi.mock("@poseidon/ui/components/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
    "aria-label": label,
  }: {
    readonly children?: React.ReactNode;
    readonly disabled?: boolean;
    readonly onClick?: () => void;
    readonly "aria-label"?: string;
  }) => {
    if (label !== undefined && onClick !== undefined) clicks.set(label, onClick);
    return (
      <button type="button" disabled={disabled} aria-label={label}>
        {children}
      </button>
    );
  },
}));

const PR_URL = "https://github.com/acme/app/pull/7";

const NONE: Record<GitAction, string | null> = {
  commit: null,
  "commit-push": null,
  "commit-push-pr": null,
};

const render = (
  next: GitNextStepView,
  options: {
    readonly pending?: boolean;
    readonly pullRequestUrl?: string | null;
    readonly reasons?: Record<GitAction, string | null>;
    readonly onStart?: (action: GitAction) => void;
    readonly onOpen?: (url: string) => void;
  } = {},
) => {
  clicks.clear();
  return renderToStaticMarkup(
    <GitPrimaryButton
      next={next}
      hint="Push 1 commit to origin/feature"
      pending={options.pending ?? false}
      pullRequestUrl={options.pullRequestUrl ?? null}
      reasons={options.reasons ?? NONE}
      onStart={options.onStart ?? (() => {})}
      onOpen={options.onOpen ?? (() => {})}
    />,
  );
};

/** The menu items, each as `enabled:` or `disabled:` and its text. */
const items = (markup: string) =>
  [...markup.matchAll(/<div data-item="(\w+)">(.*?)<\/div>/g)].map(
    ([, state, body]) =>
      `${state}: ${(body ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()}`,
  );

const primary = (markup: string, label: string) =>
  markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";

describe("GitPrimaryButton", () => {
  it("shows the step's label and badge, with what it does in the tooltip", () => {
    const onStart = vi.fn();
    const markup = render(
      { step: "push", action: "commit-push", label: "Push", badge: "↑1", reason: null },
      { onStart },
    );
    expect(markup).toContain(">Push</span>");
    expect(markup).toContain("↑1");
    expect(primary(markup, "Push")).not.toContain("disabled");
    expect(markup).toContain("Push 1 commit to origin/feature");
    clicks.get("Push")?.();
    expect(onStart).toHaveBeenCalledWith("commit-push");
  });

  it("is disabled with its reason in the tooltip", () => {
    const markup = render({
      step: "commit",
      action: "commit",
      label: "Commit",
      badge: "3",
      reason: "A turn is running — stop it before committing.",
    });
    expect(primary(markup, "Commit")).toContain('disabled=""');
    expect(markup).toContain(
      '<div data-tooltip="">A turn is running — stop it before committing.</div>',
    );
    expect(markup).not.toContain("Push 1 commit");
  });

  it("opens the pull request from View PR, even while a git run is going", () => {
    const onOpen = vi.fn();
    const onStart = vi.fn();
    const markup = render(
      { step: "view-pr", action: null, label: "View PR", badge: null, reason: null },
      { pending: true, pullRequestUrl: PR_URL, onOpen, onStart },
    );
    expect(primary(markup, "View PR")).not.toContain("disabled");
    expect(items(markup).at(-1)).toBe("enabled: View pull request");
    // Both open GitHub, so both lead with its mark.
    const drawing = (html: string) => (html.match(/ d="[^"]*"/g) ?? []).join("");
    const github = drawing(renderToStaticMarkup(<Github variant="bold" />));
    const firstIcon = (html: string) => drawing(html.match(/<svg.*?<\/svg>/)?.[0] ?? "");
    expect(firstIcon(markup.slice(markup.indexOf('aria-label="View PR"')))).toBe(github);
    const viewItem = markup.slice(markup.lastIndexOf('<div data-item="enabled">'));
    expect(viewItem).toContain("View pull request");
    expect(firstIcon(viewItem)).toBe(github);
    clicks.get("View PR")?.();
    expect(onOpen).toHaveBeenCalledWith(PR_URL);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("lists every action in the menu, a blocked one disabled with its reason", () => {
    const markup = render(
      { step: "commit", action: "commit", label: "Commit", badge: "1", reason: null },
      { reasons: { ...NONE, "commit-push-pr": "This is the default branch." } },
    );
    expect(markup).toContain('aria-label="More git actions"');
    expect(markup).toContain("More git actions</div>");
    expect(items(markup)).toEqual([
      "enabled: Commit",
      "enabled: Commit &amp; push",
      "disabled: Commit &amp; create PR This is the default branch.",
    ]);
    expect(markup).not.toContain("View pull request");
  });

  it("turns every action off while a git run is going", () => {
    const markup = render(
      { step: "commit", action: "commit", label: "Commit", badge: "1", reason: null },
      { pending: true },
    );
    expect(primary(markup, "Commit")).toContain('disabled=""');
    expect(markup).toContain(GIT_RUN_PENDING_REASON);
    expect(items(markup)).toEqual([
      `disabled: Commit ${GIT_RUN_PENDING_REASON}`,
      `disabled: Commit &amp; push ${GIT_RUN_PENDING_REASON}`,
      `disabled: Commit &amp; create PR ${GIT_RUN_PENDING_REASON}`,
    ]);
  });
});
