/**
 * The skills extension on temp-dir trees laid out the way Claude Code keeps
 * skills: the project's `.claude/skills`, the instance's `<config>/skills`
 * (`CLAUDE_CONFIG_DIR`, else `~/.claude`), and the shared `~/.agents/skills`
 * the CLI does not load, whose skills can be linked into the user root.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { afterAll } from "vitest";

import { makeClaudeSkills } from "./skills";

const ROOT = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skills-"));
afterAll(() => {
  NodeFS.rmSync(ROOT, { recursive: true, force: true });
});

const skill = (root: string, entry: string, frontmatter: string): string => {
  const dir = NodePath.join(root, entry);
  NodeFS.mkdirSync(dir, { recursive: true });
  const path = NodePath.join(dir, "SKILL.md");
  NodeFS.writeFileSync(path, `---\n${frontmatter}\n---\n\nBody.\n`);
  return path;
};

const home = NodePath.join(ROOT, "home");
const configDir = NodePath.join(ROOT, "second-account");
const agents = NodePath.join(ROOT, "agents-skills");
const workspace = NodePath.join(ROOT, "workspace");

const userSkill = skill(
  NodePath.join(home, ".claude", "skills"),
  "release-notes",
  "name: release-notes\ndescription: >\n  Writes the notes\n  for a release.",
);
const accountSkill = skill(NodePath.join(configDir, "skills"), "triage", "name: triage");
const userReview = skill(
  NodePath.join(home, ".claude", "skills"),
  "review",
  "name: review\ndescription: from the user",
);
const shadowed = skill(
  NodePath.join(workspace, ".claude", "skills"),
  "review",
  'name: review\ndescription: "from the repo"',
);
const unnamed = skill(NodePath.join(workspace, ".claude", "skills"), "no-name", "description: d");
// Not skills: a dot entry, a loose file, a directory without SKILL.md.
skill(NodePath.join(home, ".claude", "skills"), ".hidden", "name: hidden");
NodeFS.writeFileSync(NodePath.join(home, ".claude", "skills", "notes.md"), "# notes\n");
NodeFS.mkdirSync(NodePath.join(home, ".claude", "skills", "empty"), { recursive: true });

const skillsFor = (env: Record<string, string>, agentsSkillsRoot = agents) =>
  makeClaudeSkills({ env, agentsSkillsRoot, writeMutex: Semaphore.makeUnsafe(1) });

describe("the Claude Code skills extension", () => {
  it.effect("lists the user root alone without a project", () =>
    Effect.gen(function* () {
      expect(yield* skillsFor({ HOME: home }).list({ workspaceRoot: null })).toEqual([
        {
          name: "release-notes",
          path: userSkill,
          description: "Writes the notes for a release.",
          enabled: true,
        },
        { name: "review", path: userReview, description: "from the user", enabled: true },
      ]);
    }),
  );

  it.effect("puts the user's skills first, and a user skill wins its name, as in the CLI", () =>
    Effect.gen(function* () {
      const listed = yield* skillsFor({ HOME: home }).list({ workspaceRoot: workspace });
      expect(listed.map((found) => [found.name, found.path])).toEqual([
        ["release-notes", userSkill],
        ["review", userReview],
        ["no-name", unnamed],
      ]);
      expect(listed.map((found) => found.path)).not.toContain(shadowed);
    }),
  );

  it.effect("reads the account the instance's config directory names", () =>
    Effect.gen(function* () {
      const listed = yield* skillsFor({ HOME: home, CLAUDE_CONFIG_DIR: configDir }).list({
        workspaceRoot: null,
      });
      expect(listed).toEqual([{ name: "triage", path: accountSkill, enabled: true }]);
    }),
  );

  it.effect("lists nothing for roots that do not exist", () =>
    Effect.gen(function* () {
      const none = skillsFor({ HOME: NodePath.join(ROOT, "nowhere") });
      expect(yield* none.list({ workspaceRoot: NodePath.join(ROOT, "no-project") })).toEqual([]);
    }),
  );

  it.effect("offers an agents-folder skill until it is linked into the user root", () =>
    Effect.gen(function* () {
      const linkHome = NodePath.join(ROOT, "link-home");
      const linkAgents = NodePath.join(ROOT, "link-agents");
      const userRoot = NodePath.join(linkHome, ".claude", "skills");
      skill(linkAgents, "lint", "name: lint\ndescription: Lints.");
      skill(linkAgents, "already", "name: already");
      skill(linkAgents, "same-name", "name: taken");
      skill(userRoot, "taken", "name: taken");
      NodeFS.symlinkSync(NodePath.join(linkAgents, "already"), NodePath.join(userRoot, "already"));
      const skills = skillsFor({ HOME: linkHome }, linkAgents);

      // Linked by entry, or shadowed by a skill of the same name: not offered.
      expect((yield* skills.available!).map((found) => found.entry)).toEqual(["lint"]);

      expect(yield* skills.link!("lint")).toEqual([]);
      const link = NodePath.join(userRoot, "lint");
      expect(NodeFS.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(NodePath.isAbsolute(NodeFS.readlinkSync(link))).toBe(false);
      expect((yield* skills.list({ workspaceRoot: null })).map((found) => found.name)).toContain(
        "lint",
      );

      // Only an entry the list offers can be linked, which also keeps a path
      // from reaching the filesystem.
      expect((yield* Effect.flip(skills.link!("lint"))).code).toBe("not-found");
      expect((yield* Effect.flip(skills.link!("../lint"))).code).toBe("not-found");
    }),
  );

  it.effect("links into a config directory that is a symlink, and mends a broken link", () =>
    Effect.gen(function* () {
      const base = NodePath.join(ROOT, "dotfiles");
      const linkHome = NodePath.join(base, "home");
      const linkAgents = NodePath.join(linkHome, ".agents", "skills");
      const claudeDir = NodePath.join(base, "dotfiles", "claude");
      skill(linkAgents, "lint", "name: lint");
      skill(linkAgents, "broken", "name: broken");
      skill(linkAgents, "notes", "name: notes");
      NodeFS.mkdirSync(NodePath.join(claudeDir, "skills"), { recursive: true });
      NodeFS.symlinkSync(claudeDir, NodePath.join(linkHome, ".claude"));
      const userRoot = NodePath.join(linkHome, ".claude", "skills");
      // Not a skill, but it takes the name: linking over it could only fail.
      NodeFS.writeFileSync(NodePath.join(userRoot, "notes"), "");
      NodeFS.symlinkSync(NodePath.join(base, "gone"), NodePath.join(userRoot, "broken"));
      const skills = skillsFor({ HOME: linkHome }, linkAgents);

      expect((yield* skills.available!).map((found) => found.entry)).toEqual(["broken", "lint"]);
      expect((yield* skills.link!("lint")).map((found) => found.entry)).toEqual(["broken"]);
      expect(yield* skills.link!("broken")).toEqual([]);
      const names = (yield* skills.list({ workspaceRoot: null })).map((found) => found.name);
      expect(names).toEqual(["broken", "lint"]);
    }),
  );
});
