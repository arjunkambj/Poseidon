import { describe, expect, it } from "vitest";

import type { GitFileChange } from "@poseidon/contracts/rpc";

import {
  commitBlockedReason,
  commitButtonLabel,
  commitPick,
  editMessage,
  fillGenerated,
  generatedCommitMessage,
  initialPicker,
  isSubmitChord,
  middleTruncate,
  selectAllState,
  statusLetter,
  toggleAll,
  togglePath,
} from "@/components/git/commit-picker";

const file = (path: string, status: GitFileChange["status"] = "modified"): GitFileChange => ({
  path,
  status,
  staged: false,
});

const FILES = [file("src/a.ts"), file("src/b.ts", "added"), file("notes.md", "untracked")];

describe("statusLetter", () => {
  it("gives one letter per status", () => {
    expect(
      (["added", "modified", "deleted", "renamed", "untracked"] as const).map(statusLetter),
    ).toEqual(["A", "M", "D", "R", "U"]);
  });
});

describe("middleTruncate", () => {
  it("leaves a short path alone", () => {
    expect(middleTruncate("src/a.ts", 20)).toBe("src/a.ts");
  });

  it("cuts the middle of a long path and keeps the file name", () => {
    const path = "apps/web/src/components/git/deeply/nested/commit-dialog.tsx";
    const cut = middleTruncate(path, 30);
    expect(cut.length).toBeLessThanOrEqual(30);
    expect(cut.endsWith("/commit-dialog.tsx")).toBe(true);
    expect(cut.startsWith("apps/web")).toBe(true);
    expect(cut).toContain("…");
  });

  it("keeps the end of a file name too long on its own", () => {
    const cut = middleTruncate("src/a-very-long-generated-file-name.ts", 12);
    expect(cut.length).toBeLessThanOrEqual(12);
    expect(cut).toBe("…ile-name.ts");
  });
});

describe("commitButtonLabel", () => {
  it("counts the files, singular and plural, with the action's suffix", () => {
    expect(commitButtonLabel("commit", 1)).toBe("Commit 1 file");
    expect(commitButtonLabel("commit", 3)).toBe("Commit 3 files");
    expect(commitButtonLabel("commit-push", 1)).toBe("Commit 1 file & push");
    expect(commitButtonLabel("commit-push", 2)).toBe("Commit 2 files & push");
    expect(commitButtonLabel("commit-push-pr", 1)).toBe("Commit 1 file & create PR");
    expect(commitButtonLabel("commit-push-pr", 4)).toBe("Commit 4 files & create PR");
  });
});

describe("commitBlockedReason", () => {
  it("asks for a file first, then a message", () => {
    expect(commitBlockedReason({ ticked: 0, message: "" })).toBe(
      "Tick at least one file to commit.",
    );
    expect(commitBlockedReason({ ticked: 2, message: "  \n" })).toBe("Write a commit message.");
    expect(commitBlockedReason({ ticked: 2, message: "Fix it" })).toBeNull();
  });
});

describe("selectAllState", () => {
  it("is checked, unchecked or mixed", () => {
    expect(selectAllState(3, 3)).toBe("checked");
    expect(selectAllState(0, 3)).toBe("unchecked");
    expect(selectAllState(0, 0)).toBe("unchecked");
    expect(selectAllState(1, 3)).toBe("indeterminate");
  });
});

describe("the picker", () => {
  it("starts with every file ticked, the draft as message and no paths", () => {
    const pick = commitPick(initialPicker(), "Fix the bug", FILES);
    expect(pick.ticked).toBe(3);
    expect(pick.message.split("\n")[0]).toBe("Fix the bug");
    expect(pick.choice.paths).toBeUndefined();
  });

  it("drafts for the ticked files only and sends exactly those", () => {
    const state = togglePath(initialPicker(), "notes.md", false);
    const pick = commitPick(state, "", FILES);
    expect(pick.ticked).toBe(2);
    expect(pick.message).not.toContain("notes.md");
    expect(pick.message.split("\n")[0]).toBe("Update 2 files");
    expect(pick.choice.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(commitPick(togglePath(state, "notes.md", true), "", FILES).choice.paths).toBeUndefined();
  });

  it("ticks and unticks everything at once", () => {
    const none = toggleAll(initialPicker(), FILES, false);
    expect(commitPick(none, "t", FILES).ticked).toBe(0);
    expect(commitPick(toggleAll(none, FILES, true), "t", FILES).ticked).toBe(3);
  });

  it("keeps the user's message as ticks change", () => {
    const edited = editMessage(initialPicker(), "  My message\n");
    const pick = commitPick(togglePath(edited, "src/a.ts", false), "t", FILES);
    expect(pick.message).toBe("  My message\n");
    expect(pick.choice.message).toBe("My message");
    expect(pick.choice.generated).toBe(false);
  });

  it("marks a generated message until the user changes it", () => {
    const message = generatedCommitMessage({ subject: " Fix login ", body: "- Keep next\n" });
    expect(message).toBe("Fix login\n\n- Keep next");
    expect(generatedCommitMessage({ subject: "Fix login", body: "  " })).toBe("Fix login");

    const filled = fillGenerated(initialPicker(), message);
    const pick = commitPick(filled, "t", FILES);
    expect(pick.message).toBe(message);
    expect(pick.choice).toEqual({ message, generated: true });
    // Ticks keep it; a keystroke makes it the user's own.
    expect(commitPick(togglePath(filled, "notes.md", false), "t", FILES).choice.generated).toBe(
      true,
    );
    expect(commitPick(editMessage(filled, `${message}!`), "t", FILES).choice.generated).toBe(false);
  });
});

describe("isSubmitChord", () => {
  const key = (init: Partial<Parameters<typeof isSubmitChord>[0]>) => ({
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  });

  it("is Meta+Enter on macOS and Ctrl+Enter elsewhere", () => {
    expect(isSubmitChord(key({ metaKey: true }), "meta")).toBe(true);
    expect(isSubmitChord(key({ ctrlKey: true }), "meta")).toBe(false);
    expect(isSubmitChord(key({ ctrlKey: true }), "ctrl")).toBe(true);
    expect(isSubmitChord(key({ metaKey: true }), "ctrl")).toBe(false);
  });

  it("ignores a plain Enter and other modifiers", () => {
    expect(isSubmitChord(key({}), "meta")).toBe(false);
    expect(isSubmitChord(key({ metaKey: true, shiftKey: true }), "meta")).toBe(false);
    expect(isSubmitChord(key({ key: "a", metaKey: true }), "meta")).toBe(false);
  });
});
