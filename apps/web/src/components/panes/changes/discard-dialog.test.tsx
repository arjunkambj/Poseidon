import { makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import * as Exit from "effect/Exit";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DiscardAllButton, DiscardDialog } from "@/components/panes/changes/discard-dialog";
import { ReviewScopeProvider, type ReviewScope } from "@/components/panes/changes/review-scope";

// The confirmation is portalled and clicked, which a static render cannot do:
// keep what the dialog was given, so the test can press its buttons itself.
interface ConfirmProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: React.ReactNode;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
}
const confirm: { props: ConfirmProps | null } = { props: null };
vi.mock("@/components/confirm-dialog", () => ({
  ConfirmDialog: (props: ConfirmProps) => {
    confirm.props = props;
    return props.open ? (
      <div data-dialog>
        {props.title}|{props.description}|{props.confirmLabel}
      </div>
    ) : null;
  },
}));

const discard = vi.fn((_input: unknown) => Promise.resolve(Exit.succeed(undefined)));
vi.mock("@/components/panes/changes/git-atoms", () => ({
  useGitReview: () => ({ discard, blameAtom: () => undefined }),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const projectId = makeProjectId();
const threadId = makeThreadId();
const scope: ReviewScope = {
  projectId,
  threadId,
  kind: "turn",
  base: { source: "refs/cp/1" },
  baseLabel: "before Turn 2",
  discardDisabledReason: null,
};

const render = (node: React.ReactNode, value: ReviewScope = scope) =>
  renderToStaticMarkup(<ReviewScopeProvider value={value}>{node}</ReviewScopeProvider>);

const rename = {
  path: "src/b.ts",
  oldPath: "src/a.ts",
  kind: "edit",
  additions: 1,
  deletions: 0,
  diff: "",
} as const;

beforeEach(() => {
  confirm.props = null;
  discard.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
});

describe("DiscardDialog", () => {
  it("says what is lost, and discards with the scope's base on confirm", async () => {
    const onOpenChange = vi.fn();
    const markup = render(
      <DiscardDialog open onOpenChange={onOpenChange} target={{ kind: "file", file: rename }} />,
    );
    expect(markup).toContain("Discard changes to b.ts?");
    expect(markup).toContain("src/a.ts comes back as it was before Turn 2");
    confirm.props?.onConfirm();
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(discard).toHaveBeenCalledWith({
      projectId,
      threadId,
      source: "refs/cp/1",
      paths: ["src/b.ts", "src/a.ts"],
    });
  });

  it("does not discard on cancel", () => {
    render(<DiscardDialog open onOpenChange={() => {}} target={{ kind: "file", file: rename }} />);
    confirm.props?.onOpenChange(false);
    expect(discard).not.toHaveBeenCalled();
  });

  it("shows the server's refusal as a toast", async () => {
    discard.mockResolvedValueOnce(Exit.fail({ message: "a turn is running" }) as never);
    render(<DiscardDialog open onOpenChange={() => {}} target={{ kind: "file", file: rename }} />);
    confirm.props?.onConfirm();
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Discard failed: a turn is running"),
    );
  });

  it("renders nothing outside a review scope", () => {
    expect(
      renderToStaticMarkup(
        <DiscardDialog open onOpenChange={() => {}} target={{ kind: "file", file: rename }} />,
      ),
    ).toBe("");
  });
});

describe("DiscardAllButton", () => {
  const uncommitted: ReviewScope = { ...scope, kind: "uncommitted", base: {}, baseLabel: "HEAD" };

  it("shows only in the Uncommitted scope", () => {
    expect(render(<DiscardAllButton files={[rename]} />)).toBe("");
    expect(render(<DiscardAllButton files={[rename]} />, uncommitted)).toContain(
      'aria-label="Discard all changes"',
    );
  });

  it("is disabled while discarding cannot start", () => {
    expect(
      render(<DiscardAllButton files={[rename]} />, {
        ...uncommitted,
        discardDisabledReason: "A turn is running.",
      }),
    ).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Discard all changes"|<button[^>]*aria-label="Discard all changes"[^>]*disabled=""/,
    );
  });

  it("discards everything, with no paths and no base", async () => {
    render(<DiscardAllButton files={[rename]} />, uncommitted);
    expect(confirm.props?.title).toBe("Discard all uncommitted changes?");
    confirm.props?.onConfirm();
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(discard).toHaveBeenCalledWith({ projectId, threadId });
  });
});
