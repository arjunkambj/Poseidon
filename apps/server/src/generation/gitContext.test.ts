/**
 * What the model reads about a change, against real repositories in tmp
 * directories: a commit's diff (untracked files included, narrowed to the
 * ticked paths, the index untouched), a branch's commits and diff against its
 * base, and the repository's style.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { commitContext, pullRequestBase, pullRequestContext, styleContext } from "./gitContext";

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const emptyRepo = () => {
  const root = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "poseidon-gen-context-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@poseidon.local");
  git(root, "config", "user.name", "Poseidon Test");
  return root;
};

const commitAll = (root: string, message: string) => {
  git(root, "add", "-A");
  git(root, "commit", "-qm", message);
};

/** A secret file outside any repository, for links that lead out of one. */
const outsideSecret = () => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "poseidon-gen-outside-"));
  const path = nodePath.join(dir, "secret.txt");
  writeFileSync(path, "TOP SECRET KEY\n");
  return path;
};

const makeRepo = () => {
  const root = emptyRepo();
  writeFileSync(nodePath.join(root, "a.txt"), "one\n");
  writeFileSync(nodePath.join(root, "b.txt"), "two\n");
  commitAll(root, "Add the first files");
  return root;
};

describe("commitContext", () => {
  it.effect("reads tracked edits and untracked files, and leaves the index alone", () =>
    Effect.gen(function* () {
      const root = makeRepo();
      writeFileSync(nodePath.join(root, "a.txt"), "one\nmore\n");
      writeFileSync(nodePath.join(root, "b.txt"), "two\nstaged\n");
      git(root, "add", "b.txt");
      writeFileSync(nodePath.join(root, "new.txt"), "brand new\n");
      const before = git(root, "status", "--porcelain");

      const all = yield* commitContext(root, undefined);
      expect(all.files).toEqual(["M\ta.txt", "M\tb.txt", "A\tnew.txt"]);
      expect(all.patch).toContain("+more");
      expect(all.patch).toContain("+staged");
      expect(all.patch).toContain("+++ b/new.txt\nbrand new");
      expect(git(root, "status", "--porcelain")).toBe(before);

      const picked = yield* commitContext(root, ["a.txt"]);
      expect(picked.files).toEqual(["M\ta.txt"]);
      expect(picked.patch).not.toContain("staged");

      const none = yield* Effect.flip(commitContext(root, []));
      expect(none).toMatchObject({ code: "invalid" });
    }),
  );

  it.effect("shows an untracked symlink as its target and never reads what it points at", () =>
    Effect.gen(function* () {
      const root = makeRepo();
      const secret = outsideSecret();
      symlinkSync(secret, nodePath.join(root, "notes"));

      const context = yield* commitContext(root, undefined);
      expect(context.files).toEqual(["A\tnotes"]);
      expect(context.patch).toContain(`+++ b/notes\n(symlink -> ${secret})`);
      expect(context.patch).not.toContain("TOP SECRET");
    }),
  );

  it.effect("works before the first commit, and refuses when nothing changed", () =>
    Effect.gen(function* () {
      const fresh = emptyRepo();
      writeFileSync(nodePath.join(fresh, "readme.md"), "# hello\n");
      const first = yield* commitContext(fresh, undefined);
      expect(first.files).toEqual(["A\treadme.md"]);

      const clean = makeRepo();
      const error = yield* Effect.flip(commitContext(clean, undefined));
      expect(error).toMatchObject({ code: "invalid" });
    }),
  );
});

describe("pullRequestContext", () => {
  it.effect("reads the branch's commits and its diff against the base", () =>
    Effect.gen(function* () {
      const root = makeRepo();
      git(root, "checkout", "-qb", "feature");
      writeFileSync(nodePath.join(root, "parser.ts"), "export const parse = 1;\n");
      commitAll(root, "Add the parser");

      const base = yield* pullRequestBase(root, undefined, undefined);
      expect(base).toBe("main");
      expect(yield* pullRequestBase(root, undefined, "origin/main")).toBe("origin/main");

      const change = yield* pullRequestContext(root, base);
      expect(change.branch).toBe("feature");
      expect(change.commits).toContain("- Add the parser");
      expect(change.commits).not.toContain("Add the first files");
      expect(change.patch).toContain("+export const parse = 1;");
    }),
  );

  it.effect("refuses an unknown base and a branch with nothing on top of it", () =>
    Effect.gen(function* () {
      const root = makeRepo();
      expect(yield* Effect.flip(pullRequestContext(root, "nope"))).toMatchObject({
        code: "invalid",
      });
      expect(yield* Effect.flip(pullRequestContext(root, "main"))).toMatchObject({
        code: "invalid",
      });
      expect(yield* Effect.flip(pullRequestBase(root, "-x", undefined))).toMatchObject({
        code: "invalid",
      });
    }),
  );
});

describe("styleContext", () => {
  it.effect("repository conventions read recent subjects and the agent notes", () =>
    Effect.gen(function* () {
      const root = makeRepo();
      writeFileSync(nodePath.join(root, "AGENTS.md"), "Subjects are lowercase.\n");
      commitAll(root, "fix: keep the draft");

      const context = yield* styleContext(root, {
        writingStyle: "repository",
        customInstructions: "",
      });
      expect(context.recentSubjects).toEqual(["fix: keep the draft", "Add the first files"]);
      expect(context.agentNotes).toBe("Subjects are lowercase.");

      const conventional = yield* styleContext(root, {
        writingStyle: "conventional",
        customInstructions: "",
      });
      expect(conventional.recentSubjects).toEqual([]);
      expect(conventional.agentNotes).toBeNull();

      const noHistory = yield* styleContext(emptyRepo(), {
        writingStyle: "custom",
        customInstructions: " ",
      });
      expect(noHistory.recentSubjects).toEqual([]);
    }),
  );

  it.effect("skips agent notes that link out of the repository", () =>
    Effect.gen(function* () {
      const root = makeRepo();
      symlinkSync(outsideSecret(), nodePath.join(root, "AGENTS.md"));
      writeFileSync(nodePath.join(root, "CLAUDE.md"), "Keep it short.\n");

      const context = yield* styleContext(root, {
        writingStyle: "repository",
        customInstructions: "",
      });
      expect(context.agentNotes).toBe("Keep it short.");
    }),
  );
});
