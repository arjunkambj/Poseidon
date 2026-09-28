import type { DetectedEditor } from "@poseidon/contracts/editors";
import { makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OpenInControl, OpenInSplitButton } from "@/components/open-in/open-in-control";
import { ClientRuntimeProvider } from "@/lib/client-runtime";
import { makeFixtureClient } from "@/lib/fixture-client";
import { installAppAtoms } from "@/state/app-runtime";

import {
  Code,
  Cursor,
  FolderOpen,
  type HoneyIcon,
  Terminal,
  Windsurf,
  ZedColor,
} from "@honeyicons/react";

type Slot = { readonly children?: React.ReactNode; readonly render?: React.ReactElement };

// The menu is portalled and closed, which a static render leaves out; render
// its parts in place, the content marked so the main half can be read apart.
vi.mock("@poseidon/ui/components/dropdown-menu", () => {
  const part = ({ children }: Slot) => <>{children}</>;
  return {
    DropdownMenu: part,
    DropdownMenuContent: ({ children }: Slot) => <div data-menu="">{children}</div>,
    DropdownMenuGroup: part,
    DropdownMenuLabel: part,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: ({ children, render }: Slot) =>
      render === undefined ? <>{children}</> : React.cloneElement(render, undefined, children),
    DropdownMenuItem: ({ children }: Slot) => <div data-item="">{children}</div>,
  };
});

// The favourite is read from the app's settings; offline they never load, so
// the first detected editor leads.
installAppAtoms(null);

const app = (id: DetectedEditor["id"], label: string, kind: DetectedEditor["kind"] = "editor") =>
  ({ id, label, kind, supportsLine: kind === "editor" }) satisfies DetectedEditor;

const vscode = app("vscode", "VS Code");
const cursor = app("cursor", "Cursor");
const windsurf = app("windsurf", "Windsurf");
const zed = app("zed", "Zed");
const finder = app("finder", "Finder", "file-manager");
const terminal = app("terminal", "Terminal", "terminal");

const noop = () => {};

// An icon's drawing: its path data, without the ids a colour logo scopes per
// instance or the classes a row adds.
const drawing = (markup: string): string => (markup.match(/ d="[^"]*"/g) ?? []).join("");
const firstIcon = (markup: string): string => drawing(markup.match(/<svg.*?<\/svg>/)?.[0] ?? "");
const iconOf = (Icon: HoneyIcon): string => drawing(renderToStaticMarkup(<Icon variant="bold" />));

const renderButton = (editors: ReadonlyArray<DetectedEditor>, favourite: DetectedEditor) => {
  const html = renderToStaticMarkup(
    <OpenInSplitButton editors={editors} favourite={favourite} onOpen={noop} onPick={noop} />,
  );
  const [main = "", menu = ""] = html.split('<div data-menu="">');
  // Each menu item's label → the drawing of the icon it leads with.
  const items = new Map(
    menu
      .split('<div data-item="">')
      .slice(1)
      .map((item) => [item.replace(/<[^>]+>/g, "").trim(), firstIcon(item)] as const),
  );
  return { main, items };
};

describe("OpenInSplitButton", () => {
  it("leads with the favourite, labelled for a wide header", () => {
    const { main } = renderButton([cursor, zed, finder], zed);
    expect(main).toContain('aria-label="Open in Zed"');
    expect(main).toContain('<span class="hidden @lg/header:inline">Zed</span>');
    expect(main).toContain('aria-label="Open in…"');
    expect(main).not.toContain("Cursor");
  });

  it("draws the favourite's logo on the main half", () => {
    expect(firstIcon(renderButton([zed, cursor], zed).main)).toBe(iconOf(ZedColor));
    expect(firstIcon(renderButton([cursor, zed], cursor).main)).toBe(iconOf(Cursor));
    expect(firstIcon(renderButton([vscode], vscode).main)).toBe(iconOf(Code));
  });

  it("lists each app with its logo, or the glyph for its kind when it has none", () => {
    const { items } = renderButton([vscode, cursor, windsurf, zed, finder, terminal], vscode);
    expect([...items.keys()]).toEqual([
      "VS Code",
      "Cursor",
      "Windsurf",
      "Zed",
      "Finder",
      "Terminal",
    ]);
    expect(items.get("VS Code")).toBe(iconOf(Code));
    expect(items.get("Cursor")).toBe(iconOf(Cursor));
    expect(items.get("Windsurf")).toBe(iconOf(Windsurf));
    expect(items.get("Zed")).toBe(iconOf(ZedColor));
    expect(items.get("Finder")).toBe(iconOf(FolderOpen));
    expect(items.get("Terminal")).toBe(iconOf(Terminal));
  });
});

describe("OpenInControl", () => {
  it("leads with the first editor the server lists until a favourite is stored", () => {
    const html = renderToStaticMarkup(
      <ClientRuntimeProvider layer={makeFixtureClient().layer}>
        <OpenInControl projectId={makeProjectId()} threadId={makeThreadId()} />
      </ClientRuntimeProvider>,
    );
    expect(html).toContain('aria-label="Open in VS Code"');
  });
});
