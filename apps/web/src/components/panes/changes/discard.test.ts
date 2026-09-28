import { makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "vitest";

import {
  canDiscardAll,
  discardAllDescription,
  discardBlockedReason,
  discardDescription,
  discardInput,
  discardPaths,
  reviewScopeFields,
  type ReviewScopeFields,
} from "./discard";

const UNCOMMITTED = reviewScopeFields({ scope: "uncommitted" }, "");
const BRANCH = reviewScopeFields({ scope: "branch", mergeBase: "main" }, "");
const TURN = reviewScopeFields({ scope: "turn", from: "refs/cp/1", to: "refs/cp/2" }, "Turn 2");
const FIRST_TURN = reviewScopeFields({ scope: "turn", from: null, to: "refs/cp/1" }, "Turn 1");

const edit = { path: "src/a.ts", kind: "edit" } as const;
const create = { path: "src/new.ts", kind: "create" } as const;
const removed = { path: "src/gone.ts", kind: "delete" } as const;
const rename = { path: "src/b.ts", oldPath: "src/a.ts", kind: "edit" } as const;

describe("reviewScopeFields", () => {
  it("names each scope's base and what a discard sends for it", () => {
    expect(UNCOMMITTED).toEqual({ kind: "uncommitted", base: {}, baseLabel: "HEAD" });
    expect(BRANCH).toEqual({ kind: "branch", base: { mergeBase: "main" }, baseLabel: "main" });
    expect(TURN).toEqual({
      kind: "turn",
      base: { source: "refs/cp/1" },
      baseLabel: "before Turn 2",
    });
  });

  it("sends no base for the first turn, which starts from HEAD", () => {
    expect(FIRST_TURN).toEqual({ kind: "turn", base: {}, baseLabel: "before Turn 1" });
  });
});

describe("discardDescription", () => {
  const says = (file: Parameters<typeof discardDescription>[0], scope: ReviewScopeFields) =>
    discardDescription(file, scope);

  it("an edit loses its uncommitted edits and goes back to HEAD", () => {
    expect(says(edit, UNCOMMITTED)).toBe(
      "Your uncommitted edits to src/a.ts are lost; it goes back to how it is in HEAD.",
    );
  });

  it("an edit on the branch goes back to the fork point, undoing edits and the branch's changes", () => {
    const text = says(edit, BRANCH);
    expect(text).toContain("src/a.ts goes back to how it was where the branch forked from main");
    expect(text).toContain("uncommitted edits and the branch's changes to it are undone");
    expect(text).toContain("commits are not changed");
  });

  it("an edit in a turn goes back to before that turn, losing what was written since", () => {
    expect(says(edit, TURN)).toBe(
      "src/a.ts goes back to how it was before Turn 2; anything written to it since is lost.",
    );
  });

  it("a created file is deleted, for good when it was never committed", () => {
    expect(says(create, UNCOMMITTED)).toBe("src/new.ts is deleted and cannot be recovered.");
    expect(says(create, BRANCH)).toContain("src/new.ts is deleted from the working copy");
    expect(says(create, TURN)).toContain("did not exist before Turn 2");
  });

  it("a deleted file comes back", () => {
    expect(says(removed, UNCOMMITTED)).toBe("src/gone.ts comes back as it is in HEAD.");
    expect(says(removed, TURN)).toBe("src/gone.ts comes back as it was before Turn 2.");
  });

  it("a rename names both paths", () => {
    const text = says(rename, UNCOMMITTED);
    expect(text).toContain("src/a.ts comes back");
    expect(text).toContain("src/b.ts is deleted");
  });
});

describe("discardAllDescription", () => {
  it("counts the new files it deletes", () => {
    expect(discardAllDescription([edit, create, create])).toContain(
      "and the 2 new files are deleted",
    );
    expect(discardAllDescription([create])).toContain("and the 1 new file is deleted");
  });

  it("says every uncommitted change is lost, with no new files", () => {
    const text = discardAllDescription([edit]);
    expect(text).toContain("Every uncommitted change in the repository is lost");
    expect(text).not.toContain("new file");
  });
});

describe("canDiscardAll", () => {
  it("is the Uncommitted scope's alone", () => {
    expect(canDiscardAll("uncommitted")).toBe(true);
    expect(canDiscardAll("branch")).toBe(false);
    expect(canDiscardAll("turn")).toBe(false);
  });
});

describe("discardBlockedReason", () => {
  const idle = { connected: true, restoring: false, turnRunning: false };

  it("is null when nothing is in the way", () => {
    expect(discardBlockedReason(idle)).toBeNull();
  });

  it("says why offline, during a restore and during a turn", () => {
    expect(discardBlockedReason({ ...idle, connected: false })).toBe(
      "Not connected to the server.",
    );
    expect(discardBlockedReason({ ...idle, restoring: true })).toBe("A restore is running.");
    expect(discardBlockedReason({ ...idle, turnRunning: true })).toContain("A turn is running");
  });
});

describe("discardInput", () => {
  const projectId = makeProjectId();
  const threadId = makeThreadId();

  it("names the file, a rename's old path too", () => {
    expect(discardPaths(edit)).toEqual(["src/a.ts"]);
    expect(discardPaths(rename)).toEqual(["src/b.ts", "src/a.ts"]);
  });

  it("sends the scope's base with the paths", () => {
    expect(
      discardInput({ projectId, threadId }, TURN.base, { kind: "file", file: rename }),
    ).toEqual({ projectId, threadId, source: "refs/cp/1", paths: ["src/b.ts", "src/a.ts"] });
    expect(discardInput({ projectId }, BRANCH.base, { kind: "file", file: edit })).toEqual({
      projectId,
      mergeBase: "main",
      paths: ["src/a.ts"],
    });
  });

  it("sends no paths and no base for Discard all", () => {
    expect(discardInput({ projectId, threadId }, {}, { kind: "all", files: [edit] })).toEqual({
      projectId,
      threadId,
    });
  });
});
