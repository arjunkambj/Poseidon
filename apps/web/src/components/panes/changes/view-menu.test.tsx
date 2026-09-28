/**
 * The Changes toolbar's View menu: one checkbox per option, showing the
 * stored value, and each toggle writes only its own option.
 */

import { DEFAULT_DIFF_VIEW_SETTINGS } from "@poseidon/contracts/settings";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ViewMenu } from "./view-menu";

interface Slot {
  readonly children?: React.ReactNode;
  readonly render?: React.ReactElement;
}

interface CheckboxProps {
  readonly children?: React.ReactNode;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}

// The menu is portalled and opened by a click, which a static render cannot
// do: keep what each checkbox was given so the test can toggle it itself.
const items: Array<CheckboxProps> = [];

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
    DropdownMenuTrigger: ({ children, render }: Slot) =>
      render === undefined ? <>{children}</> : React.cloneElement(render, undefined, children),
    DropdownMenuCheckboxItem: (props: CheckboxProps) => {
      items.push(props);
      return <div data-checked={String(props.checked)}>{props.children}</div>;
    },
  };
});

const render = (diffView = DEFAULT_DIFF_VIEW_SETTINGS) => {
  items.length = 0;
  const onDiffViewChange = vi.fn();
  const html = renderToStaticMarkup(
    <ViewMenu diffView={diffView} onDiffViewChange={onDiffViewChange} />,
  );
  return { html, onDiffViewChange };
};

describe("view menu", () => {
  it("offers both options, off by default, behind a labelled button", () => {
    const { html } = render();
    expect(html).toContain('aria-label="View options"');
    expect(html).toContain("View options</div>");
    expect(items.map((item) => [item.children, item.checked])).toEqual([
      ["Ignore whitespace", false],
      ["Wrap lines", false],
    ]);
  });

  it("shows the stored options", () => {
    render({ ignoreWhitespace: true, wrapLines: false });
    expect(items.map((item) => item.checked)).toEqual([true, false]);
  });

  it("writes only the option that was toggled", () => {
    const { onDiffViewChange } = render();
    items[0]?.onCheckedChange(true);
    expect(onDiffViewChange).toHaveBeenLastCalledWith({ ignoreWhitespace: true });
    items[1]?.onCheckedChange(true);
    expect(onDiffViewChange).toHaveBeenLastCalledWith({ wrapLines: true });
  });
});
