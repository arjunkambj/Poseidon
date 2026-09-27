import * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "vitest";

import { workspaceKey } from "@/lib/workspace-key";

import {
  emptyComposerDraft,
  parseChangesScope,
  parseCollapsedProjects,
  dockWidthBounds,
  parseDiffStyle,
  parsePullRequestLinks,
  parseWorkspaceModes,
  pullRequestLinkKey,
  rememberedAtom,
  withComposerDraft,
  withDockMemory,
  withPullRequestLink,
  withWorkspaceMode,
  type ComposerDraft,
} from "./ui";

describe("dockWidthBounds", () => {
  it("caps the dock at its share of the row and the thread column's room", () => {
    expect(dockWidthBounds(2000)).toEqual({ min: 280, max: 1600 });
    expect(dockWidthBounds(1000)).toEqual({ min: 280, max: 640 });
  });

  it("keeps the floor when the row is too narrow for both", () => {
    expect(dockWidthBounds(500)).toEqual({ min: 280, max: 280 });
  });
});

describe("withDockMemory", () => {
  const thread = "0199c0de-0002-7000-8000-000000000001";

  it("stores a thread's memory", () => {
    expect(withDockMemory({}, thread, { shown: "home" })).toEqual({ [thread]: { shown: "home" } });
  });

  it("drops a thread whose memory is empty", () => {
    const memories = { [thread]: { shown: "files" as const } };
    expect(withDockMemory(memories, thread, {})).toEqual({});
    expect(withDockMemory(memories, thread, undefined)).toEqual({});
  });

  it("returns the same map when nothing changed", () => {
    const memory = { lastTab: "browser" as const };
    const memories = { [thread]: memory };
    expect(withDockMemory(memories, thread, memory)).toBe(memories);
    expect(withDockMemory({}, thread, undefined)).toEqual({});
  });
});

describe("withComposerDraft", () => {
  const file = { name: "shot.png" } as unknown as File;
  const draft = (over: Partial<ComposerDraft> = {}): ComposerDraft => ({
    ...emptyComposerDraft,
    ...over,
  });

  it("keeps each thread's draft under its own key", () => {
    // The regression: the draft was component state and the composer unmounts
    // on every thread switch, so leaving thread A to glance at thread B threw
    // A's unsent message and its staged attachments away.
    const one = withComposerDraft({}, "a", draft({ text: "half a message" }));
    const both = withComposerDraft(one, "b", draft({ text: "another" }));
    expect(both.a?.text).toBe("half a message");
    expect(both.b?.text).toBe("another");
  });

  it("remembers mentions and staged files, not just text", () => {
    const drafts = withComposerDraft({}, "a", draft({ mentions: ["src/main.ts"], files: [file] }));
    expect(drafts.a).toEqual({
      text: "",
      mentions: ["src/main.ts"],
      references: [],
      files: [file],
    });
  });

  it("remembers picked skill and plugin references", () => {
    const references = [
      { kind: "skill", name: "health-checks" },
      { kind: "plugin", name: "formatter" },
    ] as const;
    const drafts = withComposerDraft({}, "a", draft({ references }));
    expect(drafts.a?.references).toEqual(references);
  });

  it("keeps a draft that holds only a reference, and drops it once that goes", () => {
    const drafts = withComposerDraft(
      {},
      "a",
      draft({ references: [{ kind: "skill", name: "health-checks" }] }),
    );
    expect(Object.keys(drafts)).toEqual(["a"]);
    expect(withComposerDraft(drafts, "a", draft({ references: [] }))).toEqual({});
  });

  it("drops the key once a draft is empty again, so the map does not grow", () => {
    const drafts = withComposerDraft({}, "a", draft({ text: "typed" }));
    expect(withComposerDraft(drafts, "a", emptyComposerDraft)).toEqual({});
  });

  it("returns the same map when clearing a thread that never had one", () => {
    const drafts = withComposerDraft({}, "a", draft({ text: "typed" }));
    expect(withComposerDraft(drafts, "b", emptyComposerDraft)).toBe(drafts);
  });

  it("never mutates the map it was given", () => {
    const before = withComposerDraft({}, "a", draft({ text: "typed" }));
    const snapshot = { ...before };
    withComposerDraft(before, "a", draft({ text: "more" }));
    withComposerDraft(before, "a", emptyComposerDraft);
    expect(before).toEqual(snapshot);
  });
});

describe("parseCollapsedProjects", () => {
  it("reads the folded project ids back", () => {
    expect([...parseCollapsedProjects('["p1","p2"]')]).toEqual(["p1", "p2"]);
  });

  it("is empty when nothing was ever stored, so every project starts open", () => {
    expect(parseCollapsedProjects(null).size).toBe(0);
    expect(parseCollapsedProjects(undefined).size).toBe(0);
  });

  it("survives storage written by something else", () => {
    expect(parseCollapsedProjects("not json").size).toBe(0);
    expect(parseCollapsedProjects('{"p1":true}').size).toBe(0);
    expect([...parseCollapsedProjects('["p1",7,null]')]).toEqual(["p1"]);
  });
});

describe("workspace mode memory", () => {
  it("reads each project's remembered mode back", () => {
    expect(parseWorkspaceModes('{"p1":"worktree"}')).toEqual({ p1: "worktree" });
  });

  it("is local everywhere when nothing was stored or storage is foreign", () => {
    expect(parseWorkspaceModes(null)).toEqual({});
    expect(parseWorkspaceModes("not json")).toEqual({});
    expect(parseWorkspaceModes('["worktree"]')).toEqual({});
    expect(parseWorkspaceModes('{"p1":"cloud","p2":7}')).toEqual({});
  });

  it("remembers a project's mode without touching the others", () => {
    const one = withWorkspaceMode({}, "p1", "worktree");
    const both = withWorkspaceMode(one, "p2", "worktree");
    expect(both).toEqual({ p1: "worktree", p2: "worktree" });
    expect(one).toEqual({ p1: "worktree" });
  });

  it("drops a project that goes back to local, and round-trips through storage", () => {
    const modes = withWorkspaceMode({ p1: "worktree", p2: "worktree" }, "p1", "local");
    expect(modes).toEqual({ p2: "worktree" });
    expect(parseWorkspaceModes(JSON.stringify(modes))).toEqual(modes);
  });

  it("returns the same map when nothing changes, so nothing is written", () => {
    const modes = { p1: "worktree" as const };
    expect(withWorkspaceMode(modes, "p1", "worktree")).toBe(modes);
    expect(withWorkspaceMode(modes, "p2", "local")).toBe(modes);
  });
});

describe("pull request link memory", () => {
  const URL_7 = "https://github.com/acme/app/pull/7";

  it("remembers each thread's link and round-trips through storage", () => {
    const one = withPullRequestLink({}, "t1", URL_7);
    const both = withPullRequestLink(one, "t2", "https://github.com/acme/app/pull/8");
    expect(both).toEqual({ t1: URL_7, t2: "https://github.com/acme/app/pull/8" });
    expect(one).toEqual({ t1: URL_7 });
    expect(parsePullRequestLinks(JSON.stringify(both))).toEqual(both);
  });

  it("replaces a thread's older link", () => {
    expect(withPullRequestLink({ t1: URL_7 }, "t1", "https://github.com/acme/app/pull/9")).toEqual({
      t1: "https://github.com/acme/app/pull/9",
    });
  });

  it("returns the same map for the same link or one that is not a web URL", () => {
    const links = { t1: URL_7 };
    expect(withPullRequestLink(links, "t1", URL_7)).toBe(links);
    expect(withPullRequestLink(links, "t2", "javascript:alert(1)")).toBe(links);
    expect(withPullRequestLink(links, "t2", "not a url")).toBe(links);
  });

  it("keys each branch of a workspace apart, and keeps nothing on a detached HEAD", () => {
    const thread = workspaceKey({ projectId: "p1" as ProjectId, threadId: "t1" as ThreadId });
    const project = workspaceKey({ projectId: "p1" as ProjectId });
    expect(pullRequestLinkKey(thread, "feature/a")).not.toBe(
      pullRequestLinkKey(thread, "feature/b"),
    );
    expect(pullRequestLinkKey(thread, "main")).not.toBe(pullRequestLinkKey(project, "main"));
    expect(pullRequestLinkKey(thread, null)).toBeNull();
    expect(pullRequestLinkKey(project, null)).toBeNull();
  });

  it("reads unreadable storage as empty, and drops entries that are not web links", () => {
    expect(parsePullRequestLinks(null)).toEqual({});
    expect(parsePullRequestLinks("not json")).toEqual({});
    expect(parsePullRequestLinks(`["${URL_7}"]`)).toEqual({});
    expect(
      parsePullRequestLinks(
        JSON.stringify({ t1: URL_7, t2: 7, t3: "file:///etc/passwd", t4: "javascript:alert(1)" }),
      ),
    ).toEqual({ t1: URL_7 });
  });
});

describe("parseChangesScope", () => {
  it("reads each scope back", () => {
    expect(parseChangesScope("turn")).toBe("turn");
    expect(parseChangesScope("branch")).toBe("branch");
    expect(parseChangesScope("uncommitted")).toBe("uncommitted");
  });

  it("opens on This turn when nothing, or something unknown, was stored", () => {
    expect(parseChangesScope(null)).toBe("turn");
    expect(parseChangesScope(undefined)).toBe("turn");
    expect(parseChangesScope("")).toBe("turn");
    expect(parseChangesScope('"branch"')).toBe("turn");
    expect(parseChangesScope("Branch")).toBe("turn");
  });
});

describe("parseDiffStyle", () => {
  it("reads both styles back", () => {
    expect(parseDiffStyle("split")).toBe("split");
    expect(parseDiffStyle("unified")).toBe("unified");
  });

  it("falls back to unified for anything else", () => {
    expect(parseDiffStyle(null)).toBe("unified");
    expect(parseDiffStyle(undefined)).toBe("unified");
    expect(parseDiffStyle("side-by-side")).toBe("unified");
    expect(parseDiffStyle("{}")).toBe("unified");
  });
});

describe("rememberedAtom", () => {
  /** Subscribes, picks "branch", lets the last subscriber go, then reads it back. */
  const pickAndLeave = (atom: Atom.Writable<string>) => {
    // The registry drops an unobserved node in a scheduled task; run those by hand.
    const tasks: Array<() => void> = [];
    const registry = AtomRegistry.make({
      scheduleTask: (task) => {
        tasks.push(task);
        return () => {
          const index = tasks.indexOf(task);
          if (index !== -1) {
            tasks.splice(index, 1);
          }
        };
      },
    });
    const release = registry.subscribe(atom, () => {});
    registry.set(atom, "branch");
    release();
    for (const task of tasks.splice(0)) {
      task();
    }
    return registry.get(atom);
  };

  it("keeps a choice after its last subscriber unmounts", () => {
    expect(pickAndLeave(rememberedAtom("turn"))).toBe("branch");
  });

  it("is needed: a plain atom falls back to its initial value", () => {
    expect(pickAndLeave(Atom.make("turn"))).toBe("turn");
  });
});
