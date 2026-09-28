import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { ThreadMenuItems, type MenuParts } from "./thread-menu-items";

const seen = vi.hoisted(() => ({
  reason: null as string | null,
  regenerate: vi.fn<(threadId: string) => void>(),
  clicks: new Map<string, () => void>(),
}));

// Everything the list reads besides Regenerate title, stubbed: only the list
// itself is under test.
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/components/panes/pull-request/use-thread-pull-request", () => ({
  useThreadPullRequestMark: () => null,
}));
vi.mock("@/components/sidebar/thread-actions", () => ({
  threadCommandBase: () => ({}),
  useThreadCommand: () => vi.fn(),
}));
vi.mock("@/components/sidebar/thread-copy-targets", () => ({ threadCopyTargets: () => [] }));
vi.mock("@/components/sidebar/thread-done", () => ({ markDoneBlockedReason: () => null }));
vi.mock("@/components/sidebar/thread-pins", () => ({ useThreadPins: () => [[]] }));
vi.mock("@/components/sidebar/thread-pr-mark", () => ({ useOpenPullRequestTab: () => vi.fn() }));
vi.mock("@/components/sidebar/thread-rename", () => ({ useRenamingThread: () => [null, vi.fn()] }));
vi.mock("@/components/sidebar/thread-seen", () => ({ useThreadSeen: () => [{}] }));
vi.mock("@/components/sidebar/use-sidebar-actions", () => ({ useSidebarActions: () => ({}) }));
vi.mock("@/components/sidebar/use-thread-done", () => ({ useThreadIsDone: () => () => false }));
vi.mock("@/components/thread/branch-off", () => ({
  threadForkBlockedReason: () => null,
  threadTurnInFlight: () => false,
}));
vi.mock("@/components/thread/use-branch-off", () => ({ useRequestBranchOff: () => vi.fn() }));
vi.mock("@/lib/copy-path", () => ({ copyText: vi.fn() }));
vi.mock("@/lib/shortcuts", () => ({
  CommandKbd: ({ command }: { readonly command: string }) => <kbd>{command}</kbd>,
}));
vi.mock("@/lib/use-create-thread", () => ({
  useCreateThread: () => ({ create: vi.fn(), pending: false }),
}));
vi.mock("@/state/hooks", () => ({
  useConnectionState: () => ({ status: "connected" }),
  useProjects: () => [],
}));
vi.mock("@/state/terminal-ui", () => ({ useSetDrawerOpen: () => vi.fn() }));
vi.mock("@/components/thread/regenerate-title", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/thread/regenerate-title")>()),
  useRegenerateTitle: () => ({ reason: seen.reason, regenerate: seen.regenerate }),
}));

type Slot = { readonly children?: React.ReactNode };

/** One menu flavour's parts as plain elements, keeping each item's click by its text. */
const PARTS: MenuParts = {
  Item: (({
    children,
    disabled,
    onClick,
  }: Slot & { readonly disabled?: boolean; readonly onClick?: () => void }) => {
    const text = React.Children.toArray(children).filter((child) => typeof child === "string");
    if (onClick !== undefined && text.length > 0) {
      seen.clicks.set(text.join(""), onClick);
    }
    return (
      <div role="menuitem" aria-disabled={disabled === true ? "true" : undefined}>
        {children}
      </div>
    );
  }) as unknown as MenuParts["Item"],
  Separator: (() => <hr />) as unknown as MenuParts["Separator"],
  Shortcut: (({ children }: Slot) => <span>{children}</span>) as unknown as MenuParts["Shortcut"],
  Sub: (({ children }: Slot) => <div>{children}</div>) as unknown as MenuParts["Sub"],
  SubTrigger: (({ children }: Slot) => <div>{children}</div>) as unknown as MenuParts["SubTrigger"],
  SubContent: (({ children }: Slot) => <div>{children}</div>) as unknown as MenuParts["SubContent"],
};

const thread = {
  threadId: makeThreadId(),
  projectId: makeProjectId(),
  title: "Fix the login",
  status: "active",
} as unknown as ThreadSummary;

const render = (active = true) =>
  renderToStaticMarkup(
    <ThreadMenuItems parts={PARTS} thread={thread} active={active} onDelete={() => {}} />,
  );

/** The menu items' text, in order. */
const items = (markup: string) =>
  [...markup.matchAll(/<div role="menuitem"[^>]*>(.*?)<\/div>/g)].map((match) =>
    match[1]!.replace(/<[^>]+>/g, ""),
  );

beforeEach(() => {
  seen.reason = null;
  seen.regenerate.mockClear();
  seen.clicks.clear();
});

describe("ThreadMenuItems", () => {
  it("offers Regenerate title right after Rename, with its palette command", () => {
    const markup = render();
    const labels = items(markup);
    expect(labels[0]).toBe("Renamethread.rename");
    expect(labels[1]).toBe("Regenerate titlethread.regenerateTitle");
    seen.clicks.get("Regenerate title")?.();
    expect(seen.regenerate).toHaveBeenCalledWith(thread.threadId);
  });

  it("disables it with a short hint when nothing can write", () => {
    seen.reason = "No harness can write text — turn one on in Settings → Connectors.";
    const markup = render();
    expect(markup).toContain('<div role="menuitem" aria-disabled="true">');
    expect(items(markup)[1]).toBe("Regenerate titleUnavailable");
  });
});
