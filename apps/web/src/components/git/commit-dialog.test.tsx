import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { GitFileChange } from "@poseidon/contracts/rpc";

import { CommitDialogView } from "@/components/git/commit-dialog";
import { commitPick, initialPicker, type CommitPickerState } from "@/components/git/commit-picker";
import {
  COMMIT_DRAFT_FAILED,
  generateCommitInto,
  makeOpenDraft,
  type CommitGeneration,
} from "@/components/git/use-generate-commit-message";
import type { GitAction } from "@/lib/git-actions";
import {
  GENERATION_UNAVAILABLE,
  makeGenerationRunner,
  type GenerationOutcome,
} from "@/lib/generation-run";

// The handlers the last render handed out, so a test can press a button,
// tick a box, type or press a key without a DOM.
const handlers = vi.hoisted(() => ({
  clicks: new Map<string, () => void>(),
  checks: new Map<string, (checked: boolean) => void>(),
  typing: null as ((text: string) => void) | null,
  keyDown: null as ((event: unknown) => void) | null,
}));

type Slot = { readonly children?: React.ReactNode; readonly render?: React.ReactElement };

// The popup and the tooltips are portalled, which a static render leaves out;
// render their parts in place so the body can be read.
vi.mock("@poseidon/ui/components/dialog", () => {
  const part = ({ children }: Slot) => <div>{children}</div>;
  return {
    Dialog: part,
    DialogContent: ({
      children,
      onKeyDown,
    }: {
      readonly children?: React.ReactNode;
      readonly onKeyDown?: (event: unknown) => void;
    }) => {
      handlers.keyDown = onKeyDown ?? null;
      return <div>{children}</div>;
    },
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
    // A labelled button by its label, else by its text.
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
vi.mock("@poseidon/ui/components/checkbox", () => ({
  Checkbox: ({
    checked,
    indeterminate,
    onCheckedChange,
    "aria-label": label,
  }: {
    readonly checked?: boolean;
    readonly indeterminate?: boolean;
    readonly onCheckedChange?: (checked: boolean) => void;
    readonly "aria-label"?: string;
  }) => {
    if (label !== undefined && onCheckedChange !== undefined) {
      handlers.checks.set(label, onCheckedChange);
    }
    return (
      <span
        data-checkbox={label}
        data-state={indeterminate === true ? "mixed" : checked === true ? "on" : "off"}
      />
    );
  },
}));
vi.mock("@poseidon/ui/components/textarea", () => ({
  Textarea: ({
    value,
    onChange,
  }: {
    readonly value?: string;
    readonly onChange?: (event: { readonly target: { readonly value: string } }) => void;
  }) => {
    handlers.typing = (text) => onChange?.({ target: { value: text } });
    return <textarea value={value} readOnly />;
  },
}));
vi.mock("@poseidon/client-runtime/keybindings", () => ({ detectModKey: () => "meta" }));

const file = (path: string, status: GitFileChange["status"] = "modified"): GitFileChange => ({
  path,
  status,
  staged: false,
});

const FILES = [file("src/a.ts"), file("src/b.ts", "added"), file("notes.md", "untracked")];

const NONE: Record<GitAction, string | null> = {
  commit: null,
  "commit-push": null,
  "commit-push-pr": null,
};

type Generated = GenerationOutcome<{ readonly subject: string; readonly body: string }>;

/**
 * Holds the pick the way `CommitDialog` does, re-rendering after each change,
 * and wires Generate the way `useGenerateCommitMessage` does, to `generate`.
 */
const mount = (
  options: {
    readonly initialAction?: GitAction;
    readonly reasons?: Record<GitAction, string | null>;
    readonly generate?: (
      paths: ReadonlyArray<string> | undefined,
      signal: AbortSignal,
    ) => Promise<Generated>;
    readonly generationReason?: string | null;
  } = {},
) => {
  let picker: CommitPickerState = initialPicker();
  const onSubmit = vi.fn();
  const onOpenChange = vi.fn();
  const toastError = vi.fn();
  let markup = "";
  let running = false;
  const runner = makeGenerationRunner((next) => {
    running = next;
    render();
  });
  const deps: CommitGeneration = {
    runner,
    generate:
      options.generate ??
      (async () => ({ ok: true, value: { subject: "Fix the login", body: "- Keep next" } })),
    update: (change) => {
      picker = change(picker);
      render();
    },
    toastError,
    notice: () => {},
  };
  const generate = (auto: boolean) =>
    generateCommitInto(deps, commitPick(picker, "Fix the bug", FILES).choice.paths, auto);
  const render = () => {
    handlers.clicks.clear();
    handlers.checks.clear();
    markup = renderToStaticMarkup(
      <CommitDialogView
        open
        onOpenChange={onOpenChange}
        initialAction={options.initialAction ?? "commit"}
        reasons={options.reasons ?? NONE}
        threadTitle="Fix the bug"
        branch="feature"
        files={FILES}
        onSubmit={onSubmit}
        picker={picker}
        onPickerChange={(next) => {
          picker = next;
          render();
        }}
        generation={{
          running,
          reason: options.generationReason ?? null,
          onGenerate: () => void generate(false),
          onCancel: runner.cancel,
        }}
      />,
    );
  };
  render();
  return { markup: () => markup, onSubmit, onOpenChange, toastError, generate };
};

const button = (markup: string, label: string) =>
  markup.match(new RegExp(`<button[^>]*>${label.replace(/&/g, "&amp;")}</button>`))?.[0] ?? "";

const textarea = (markup: string) =>
  markup.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? "";

describe("CommitDialog", () => {
  it("opens with every file ticked and commits them all without paths", () => {
    const dialog = mount();
    expect(dialog.markup()).toContain("3 of 3 files");
    expect(dialog.markup()).toContain('data-checkbox="Select all files" data-state="on"');
    expect(textarea(dialog.markup())).toMatch(/^Fix the bug/);
    handlers.clicks.get("Commit 3 files & push")?.();
    expect(dialog.onSubmit).toHaveBeenCalledWith("commit-push", {
      message: expect.stringMatching(/^Fix the bug\n/),
      generated: false,
    });
    expect(dialog.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("counts an unticked file out and sends exactly the ticked paths", () => {
    const dialog = mount();
    handlers.checks.get("notes.md")?.(false);
    const markup = dialog.markup();
    expect(markup).toContain("2 of 3 files");
    expect(markup).toContain('data-checkbox="Select all files" data-state="mixed"');
    expect(button(markup, "Commit 2 files")).not.toContain("disabled");
    expect(textarea(markup)).not.toContain("notes.md");
    handlers.clicks.get("Commit 2 files")?.();
    expect(dialog.onSubmit).toHaveBeenCalledWith("commit", {
      message: expect.any(String),
      paths: ["src/a.ts", "src/b.ts"],
      generated: false,
    });
  });

  it("disables every button with the reason when nothing is ticked", () => {
    const dialog = mount();
    handlers.checks.get("Select all files")?.(false);
    const markup = dialog.markup();
    expect(markup).toContain("0 of 3 files");
    for (const label of ["Commit 0 files", "Commit 0 files & push", "Commit 0 files & create PR"]) {
      expect(button(markup, label)).toContain('disabled=""');
    }
    expect(markup).toContain("Tick at least one file to commit.");
    handlers.clicks.get("Commit 0 files")?.();
    expect(dialog.onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the typed message as ticks change", () => {
    const dialog = mount();
    handlers.typing?.("My own message");
    handlers.checks.get("src/a.ts")?.(false);
    expect(textarea(dialog.markup())).toBe("My own message");
    handlers.clicks.get("Commit 2 files")?.();
    expect(dialog.onSubmit).toHaveBeenCalledWith("commit", {
      message: "My own message",
      paths: ["src/b.ts", "notes.md"],
      generated: false,
    });
  });

  it("disables the buttons on an empty message", () => {
    const dialog = mount();
    handlers.typing?.("   ");
    expect(button(dialog.markup(), "Commit 3 files")).toContain('disabled=""');
    expect(dialog.markup()).toContain("Write a commit message.");
  });

  it("shows an action's own reason on its button", () => {
    const dialog = mount({ reasons: { ...NONE, "commit-push-pr": "This is the default branch." } });
    expect(button(dialog.markup(), "Commit 3 files & create PR")).toContain('disabled=""');
    expect(dialog.markup()).toContain("This is the default branch.");
  });

  it("submits the action it was opened for on Mod+Enter", () => {
    const dialog = mount({ initialAction: "commit-push-pr" });
    handlers.checks.get("src/b.ts")?.(false);
    const preventDefault = vi.fn();
    handlers.keyDown?.({
      key: "Enter",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(dialog.onSubmit).toHaveBeenCalledWith("commit-push-pr", {
      message: expect.any(String),
      paths: ["src/a.ts", "notes.md"],
      generated: false,
    });
  });

  it("leaves a plain Enter to the focused control", () => {
    const dialog = mount();
    handlers.keyDown?.({
      key: "Enter",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault: vi.fn(),
    });
    expect(dialog.onSubmit).not.toHaveBeenCalled();
  });

  describe("Generate", () => {
    it("fills the message from the ticked files and marks it generated", async () => {
      const generate = vi.fn(async (): Promise<Generated> => ({
        ok: true,
        value: { subject: "Fix the login redirect", body: "- Keep the next param" },
      }));
      const dialog = mount({ generate });
      handlers.checks.get("notes.md")?.(false);
      await dialog.generate(false);

      expect(generate).toHaveBeenCalledWith(["src/a.ts", "src/b.ts"], expect.any(AbortSignal));
      expect(textarea(dialog.markup())).toBe("Fix the login redirect\n\n- Keep the next param");
      // A tick no longer redrafts it: it counts as edited.
      handlers.checks.get("notes.md")?.(true);
      expect(textarea(dialog.markup())).toBe("Fix the login redirect\n\n- Keep the next param");
      handlers.clicks.get("Commit 3 files")?.();
      expect(dialog.onSubmit).toHaveBeenCalledWith("commit", {
        message: "Fix the login redirect\n\n- Keep the next param",
        generated: true,
      });
    });

    it("shows a spinner while it runs, and Cancel stops it and drops the late answer", async () => {
      let answer: (outcome: Generated) => void = () => {};
      let seen: AbortSignal | null = null;
      const dialog = mount({
        generate: (_paths, signal) => {
          seen = signal;
          return new Promise((resolve) => {
            answer = resolve;
          });
        },
      });
      const template = textarea(dialog.markup());
      handlers.clicks.get("Generate message")?.();
      expect(dialog.markup()).toContain('aria-label="Cancel generating"');
      expect(dialog.markup()).toContain("animate-spin");

      handlers.clicks.get("Cancel generating")?.();
      expect(seen!.aborted).toBe(true);
      expect(dialog.markup()).toContain('aria-label="Generate message"');
      answer({ ok: true, value: { subject: "Too late", body: "" } });
      await Promise.resolve();
      expect(textarea(dialog.markup())).toBe(template);
    });

    it("drafts once as the dialog opens when the setting says Generate", async () => {
      const draft = vi.fn();
      const onOpen = makeOpenDraft(draft);
      onOpen("template", null);
      onOpen("generate", GENERATION_UNAVAILABLE);
      expect(draft).not.toHaveBeenCalled();
      onOpen("generate", null);
      onOpen("generate", null);
      expect(draft).toHaveBeenCalledOnce();

      const dialog = mount();
      await dialog.generate(true);
      expect(textarea(dialog.markup())).toBe("Fix the login\n\n- Keep next");
    });

    it("never replaces what the user typed while the on-open draft ran", async () => {
      let answer: (outcome: Generated) => void = () => {};
      const dialog = mount({
        generate: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      });
      const drafting = dialog.generate(true);
      handlers.typing?.("My own message");
      answer({ ok: true, value: { subject: "Generated", body: "" } });
      await drafting;
      expect(textarea(dialog.markup())).toBe("My own message");
    });

    it("keeps the template and says so when the on-open draft fails", async () => {
      const dialog = mount({
        generate: async () => ({ ok: false, message: "The harness timed out." }),
      });
      const template = textarea(dialog.markup());
      await dialog.generate(true);
      expect(textarea(dialog.markup())).toBe(template);
      expect(dialog.toastError).toHaveBeenCalledWith(COMMIT_DRAFT_FAILED);

      await dialog.generate(false);
      expect(dialog.toastError).toHaveBeenLastCalledWith(
        "Couldn't write a commit message: The harness timed out.",
      );
    });

    it("is disabled with the reason when nothing can write", () => {
      const dialog = mount({ generationReason: GENERATION_UNAVAILABLE });
      const markup = dialog.markup();
      expect(markup).toMatch(/<button type="button" disabled="" aria-label="Generate message">/);
      expect(markup).toContain(GENERATION_UNAVAILABLE);
      expect(GENERATION_UNAVAILABLE).toContain("Settings → Connectors");
    });
  });
});
