/**
 * The shared skills helpers on temp-dir trees, including a user root reached
 * through a symlinked config directory, the way a dotfiles setup keeps one.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { linkSkill, occupiedSkillEntries, parseSkillFrontmatter } from "./skills";

const ROOT = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sdk-skills-"));
afterAll(() => {
  NodeFS.rmSync(ROOT, { recursive: true, force: true });
});

const skill = (root: string, entry: string): string => {
  const dir = NodePath.join(root, entry);
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "SKILL.md"), `---\nname: ${entry}\n---\n`);
  return dir;
};

describe("parseSkillFrontmatter", () => {
  it("reads plain, quoted and block values", () => {
    expect(parseSkillFrontmatter("---\nname: a\ndescription: 'b'\n---\n")).toEqual({
      name: "a",
      description: "b",
    });
    expect(parseSkillFrontmatter("---\ndescription: |\n  one\n  two\nname: c\n---\n")).toEqual({
      name: "c",
      description: "one\ntwo",
    });
    expect(parseSkillFrontmatter("no frontmatter")).toEqual({});
  });
});

describe("linkSkill", () => {
  it("links through a config directory that is itself a symlink", async () => {
    const base = NodePath.join(ROOT, "dotfiles-case");
    const home = NodePath.join(base, "home");
    const agents = NodePath.join(home, ".agents", "skills");
    const dotfiles = NodePath.join(base, "dotfiles", "claude");
    skill(agents, "lint");
    NodeFS.mkdirSync(dotfiles, { recursive: true });
    NodeFS.symlinkSync(dotfiles, NodePath.join(home, ".claude"));
    const userRoot = NodePath.join(home, ".claude", "skills");

    const link = await linkSkill(userRoot, agents, "lint");
    expect(NodePath.isAbsolute(NodeFS.readlinkSync(link))).toBe(false);
    // Resolves to the agents entry, which a path taken between the spelled
    // directories would not: it would point into the dotfiles tree.
    expect(NodeFS.realpathSync(link)).toBe(NodeFS.realpathSync(NodePath.join(agents, "lint")));
    expect(NodeFS.existsSync(NodePath.join(link, "SKILL.md"))).toBe(true);
  });

  it("replaces a link of the same name whose target is gone", async () => {
    const base = NodePath.join(ROOT, "broken-case");
    const agents = NodePath.join(base, "agents");
    const userRoot = NodePath.join(base, "user");
    skill(agents, "lint");
    NodeFS.mkdirSync(userRoot, { recursive: true });
    NodeFS.symlinkSync(NodePath.join(base, "gone"), NodePath.join(userRoot, "lint"));
    expect(await occupiedSkillEntries(userRoot)).toEqual(new Set());

    const link = await linkSkill(userRoot, agents, "lint");
    expect(NodeFS.existsSync(NodePath.join(link, "SKILL.md"))).toBe(true);
    expect(await occupiedSkillEntries(userRoot)).toEqual(new Set(["lint"]));
  });
});

describe("occupiedSkillEntries", () => {
  it("counts every entry that resolves, skill or not", async () => {
    const root = NodePath.join(ROOT, "occupied");
    skill(root, "real");
    NodeFS.mkdirSync(NodePath.join(root, "no-skill-md"));
    NodeFS.writeFileSync(NodePath.join(root, "loose"), "");
    NodeFS.symlinkSync(NodePath.join(ROOT, "nowhere"), NodePath.join(root, "dangling"));
    expect(await occupiedSkillEntries(root)).toEqual(new Set(["real", "no-skill-md", "loose"]));
    expect(await occupiedSkillEntries(NodePath.join(ROOT, "missing"))).toEqual(new Set());
  });
});
