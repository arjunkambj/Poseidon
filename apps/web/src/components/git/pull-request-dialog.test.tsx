import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PullRequestDialogView } from "@/components/git/pull-request-dialog";
import {
  generatePullRequestInto,
  type PullRequestGeneration,
  type PullRequestText,
} from "@/components/git/use-generate-pull-request";
import {
  GENERATION_UNAVAILABLE,
  makeGenerationRunner,
  type GenerationOutcome,
} from "@/lib/generation-run";

// The handlers the last render handed out, so a test can press a button
// without a DOM.
const handlers = vi.hoisted(() => ({
  clicks: new Map<string, () => void>(),
}));

type Slot = { readonly children?: React.ReactNode; readonly render?: React.ReactElement };

// The popup and the tooltips are portalled, which a static render leaves out;
// render their parts in place so the body can be read.
vi.mock("@poseidon/ui/components/dialog", () => {
  const part = ({ children }: Slot) => <div>{children}</div>;
  return {
    Dialog: part,
    DialogContent: part,
    DialogDescription: part,
    DialogFooter: part,
    DialogHeader: part,
    DialogTitle: part,
  };
});
vi.mock("@poseidon/ui/components/tooltip", () => ({
  Tooltip: ({ children }: Slot) => <div>{children}</div>,
  TooltipContent: ({ children }: Slot) => <div data-tooltip="">{children}</div>,
  TooltipTrigger: ({ children, render }: Slot) =>
    render === undefined ? <>{children}</> : React.cloneElement(render, undefined, children),
}));
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
    const name = label ?? (typeof children === "string" ? children : undefined);
    if (name !== undefined && onClick !== undefined) {
      handlers.clicks.set(name, onClick);
    }
    return (
      <button type="button" disabled={disabled} aria-label={label}>
        {children}
      </button>
    );
  },
}));

type Generated = GenerationOutcome<PullRequestText & { readonly notice?: string }>;

/** Holds the text the way `PullRequestDialog` does, with Generate wired to `generate`. */
const mount = (
  options: {
    readonly generate?: (signal: AbortSignal) => Promise<Generated>;
    readonly generationReason?: string | null;
  } = {},
) => {
  let text: PullRequestText = { title: "feature/login", body: "" };
  let running = false;
  let markup = "";
  const onSubmit = vi.fn();
  const toastError = vi.fn();
  const notice = vi.fn();
  const runner = makeGenerationRunner((next) => {
    running = next;
    render();
  });
  const fill = (next: PullRequestText) => {
    text = next;
    render();
  };
  const deps: PullRequestGeneration = {
    runner,
    generate:
      options.generate ??
      (async () => ({
        ok: true,
        value: { title: "Fix the login redirect", body: "## Summary\n- Keep next" },
      })),
    fill,
    toastError,
    notice,
  };
  let pending: Promise<void> = Promise.resolve();
  const render = () => {
    handlers.clicks.clear();
    markup = renderToStaticMarkup(
      <PullRequestDialogView
        open
        onOpenChange={() => {}}
        actionLabel="Create PR"
        initialTitle="feature/login"
        branch="feature/login"
        onSubmit={onSubmit}
        text={text}
        onTextChange={fill}
        generation={{
          running,
          reason: options.generationReason ?? null,
          onGenerate: () => {
            pending = generatePullRequestInto(deps);
          },
          onCancel: runner.cancel,
        }}
      />,
    );
  };
  render();
  return {
    markup: () => markup,
    text: () => text,
    settled: () => pending,
    toastError,
    notice,
  };
};

describe("PullRequestDialog Generate", () => {
  it("fills the title and the description", async () => {
    const dialog = mount({
      generate: async () => ({
        ok: true,
        value: { title: " Fix the login redirect ", body: "## Summary\n", notice: "Fell back." },
      }),
    });
    handlers.clicks.get("Generate title and description")?.();
    await dialog.settled();
    expect(dialog.text()).toEqual({ title: "Fix the login redirect", body: "## Summary" });
    expect(dialog.markup()).toContain('value="Fix the login redirect"');
    expect(dialog.notice).toHaveBeenCalledWith("Fell back.");
  });

  it("keeps both fields and toasts the reason when it fails", async () => {
    const dialog = mount({
      generate: async () => ({ ok: false, message: "This branch has no changes." }),
    });
    handlers.clicks.get("Generate title and description")?.();
    await dialog.settled();
    expect(dialog.text()).toEqual({ title: "feature/login", body: "" });
    expect(dialog.toastError).toHaveBeenCalledWith(
      "Couldn't write the pull request: This branch has no changes.",
    );
  });

  it("turns into Cancel while it runs, and a cancelled run fills nothing", async () => {
    let answer: (outcome: Generated) => void = () => {};
    const dialog = mount({
      generate: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    handlers.clicks.get("Generate title and description")?.();
    expect(dialog.markup()).toContain('aria-label="Cancel generating"');
    handlers.clicks.get("Cancel generating")?.();
    answer({ ok: true, value: { title: "Too late", body: "" } });
    await dialog.settled();
    expect(dialog.text().title).toBe("feature/login");
  });

  it("is disabled with the reason when nothing can write", () => {
    const markup = mount({ generationReason: GENERATION_UNAVAILABLE }).markup();
    expect(markup).toMatch(
      /<button type="button" disabled="" aria-label="Generate title and description">/,
    );
    expect(markup).toContain(GENERATION_UNAVAILABLE);
  });
});
