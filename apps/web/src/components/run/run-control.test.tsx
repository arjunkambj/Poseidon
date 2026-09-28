import type { TerminalId } from "@poseidon/contracts/ids";
import type { DetectedScript, ProjectScript } from "@poseidon/contracts/scripts";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RunSplitButton } from "@/components/run/run-control";
import { RunMenuItems } from "@/components/run/run-menu";

// Each clickable's handler by its accessible name or text, so a test can press
// one without a DOM.
const clicks = vi.hoisted(() => new Map<string, () => void>());

type Slot = { readonly children?: React.ReactNode; readonly render?: React.ReactElement };

const textOf = (node: React.ReactNode): string =>
  renderToStaticMarkup(<>{node}</>)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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
    DropdownMenuGroup: ({ children }: Slot) => <section>{children}</section>,
    DropdownMenuLabel: ({ children }: Slot) => <h3>{children}</h3>,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: ({ children, render }: Slot) =>
      render === undefined ? <>{children}</> : React.cloneElement(render, undefined, children),
    DropdownMenuItem: ({
      children,
      disabled,
      onClick,
    }: {
      readonly children?: React.ReactNode;
      readonly disabled?: boolean;
      readonly onClick?: () => void;
    }) => {
      if (onClick !== undefined) clicks.set(textOf(children), onClick);
      return <div data-item={disabled === true ? "disabled" : "enabled"}>{children}</div>;
    },
  };
});
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
    if (label !== undefined && onClick !== undefined) clicks.set(label, onClick);
    return (
      <button type="button" aria-label={label}>
        {children}
      </button>
    );
  },
}));

const dev: ProjectScript = { id: "dev", name: "Dev server", command: "pnpm dev", primary: true };
const test: ProjectScript = { id: "test", name: "Test", command: "pnpm test" };
const detectedWeb: DetectedScript = {
  id: "pkg:apps/web:build",
  name: "build",
  packageName: "web",
  packageDir: "apps/web",
  command: "cd 'apps/web' && pnpm run build",
  packageManager: "pnpm",
};
const running = "0199c0de-0012-7000-8000-000000000001" as TerminalId;

const noop = () => {};

const button = (options: { primary: ProjectScript | null; primaryRunning?: boolean }) => {
  clicks.clear();
  return renderToStaticMarkup(
    <RunSplitButton
      primary={options.primary}
      primaryRunning={options.primaryRunning ?? false}
      onRun={() => clicks.set("ran", noop)}
      onStop={() => clicks.set("stopped", noop)}
      onMenuOpen={noop}
      menu={null}
    />,
  );
};

const menu = (
  props: Partial<React.ComponentProps<typeof RunMenuItems>> = {},
): { markup: string; items: string[] } => {
  clicks.clear();
  const markup = renderToStaticMarkup(
    <RunMenuItems
      saved={[dev, test]}
      detected={[detectedWeb]}
      runningOf={() => null}
      onRun={noop}
      onStop={noop}
      onEdit={noop}
      {...props}
    />,
  );
  const items = [...markup.matchAll(/<(h3|div data-item="\w+")>(.*?)<\/(h3|div)>/g)].map(
    ([, tag, body]) =>
      `${tag === "h3" ? "# " : ""}${(body ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()}`,
  );
  return { markup, items };
};

describe("RunSplitButton", () => {
  it("runs the primary script from the main half, labelled for a wide header", () => {
    const markup = button({ primary: dev });
    expect(markup).toContain('aria-label="Run Dev server"');
    expect(markup).toContain('<span class="hidden @lg/header:inline">Dev server</span>');
    expect(markup).toContain('aria-label="Run a script…"');
    clicks.get("Run Dev server")?.();
    expect(clicks.has("ran")).toBe(true);
  });

  it("becomes Stop while the primary script runs", () => {
    const markup = button({ primary: dev, primaryRunning: true });
    expect(markup).toContain('aria-label="Stop Dev server"');
    expect(markup).toContain('<span class="hidden @lg/header:inline">Stop</span>');
    clicks.get("Stop Dev server")?.();
    expect(clicks.has("stopped")).toBe(true);
  });

  it("is only the menu's Run trigger with no saved script", () => {
    const markup = button({ primary: null });
    expect(markup).not.toContain('aria-label="Run Dev server"');
    expect(markup).toContain('aria-label="Run a script"');
    expect(markup).toContain('<span class="hidden @lg/header:inline">Run</span>');
  });
});

describe("RunMenuItems", () => {
  it("lists saved scripts, then package.json scripts, then Edit scripts…", () => {
    expect(menu().items).toEqual([
      "# Project scripts",
      "Dev server pnpm dev",
      "Test pnpm test",
      "# package.json",
      "build (apps/web) cd &#x27;apps/web&#x27; &amp;&amp; pnpm run build",
      "Edit scripts…",
    ]);
  });

  it("marks a running script and offers to stop it", () => {
    const onStop = vi.fn();
    const onRun = vi.fn();
    const { items } = menu({
      runningOf: (id) => (id === "dev" ? running : null),
      onStop,
      onRun,
    });
    expect(items.slice(1, 3)).toEqual(["Dev server running", "Stop Dev server"]);
    clicks.get("Stop Dev server")?.();
    expect(onStop).toHaveBeenCalledWith(running);
    clicks.get("Dev server running")?.();
    expect(onRun).toHaveBeenCalledWith({ id: "dev", name: "Dev server", command: "pnpm dev" });
  });

  it("shows a spinner while detecting and hides an empty package.json group", () => {
    const loading = menu({ detected: "loading" }).markup;
    expect(loading).toMatch(
      /<h3>package\.json<\/h3><div data-item="disabled">[\s\S]*Looking for scripts…/,
    );
    const { items } = menu({ saved: [], detected: [] });
    expect(items).toEqual(["Edit scripts…"]);
  });

  it("opens the editor from Edit scripts…", () => {
    const onEdit = vi.fn();
    menu({ onEdit });
    clicks.get("Edit scripts…")?.();
    expect(onEdit).toHaveBeenCalled();
  });
});
