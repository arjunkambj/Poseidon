/**
 * The skills extension on temp-dir trees laid out the way codex-cli 0.156.1
 * loads them: the project's `.codex/skills` and `.agents/skills`, the
 * instance's `CODEX_HOME/skills` (with the CLI's bundled `.system` skills
 * beside the user's) and the shared `~/.agents/skills`.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll } from "vitest";

import { makeCodexSkills } from "./skills";

const ROOT = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-skills-"));
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

const codexHome = NodePath.join(ROOT, "codex-home");
const agents = NodePath.join(ROOT, "agents-skills");
const workspace = NodePath.join(ROOT, "workspace");

const userSkill = skill(
  NodePath.join(codexHome, "skills"),
  "release-notes",
  "name: release-notes\ndescription: >\n  Writes the notes\n  for a release.",
);
skill(NodePath.join(codexHome, "skills", ".system"), "bundled", "name: bundled\ndescription: x");
const sharedSkill = skill(agents, "shared-one", 'name: shared-one\ndescription: "Quoted: yes"');
const shadowed = skill(agents, "review", "name: review\ndescription: from the agents folder");
const repoCodex = skill(
  NodePath.join(workspace, ".codex", "skills"),
  "review",
  "name: review\ndescription: from the repo",
);
const repoAgents = skill(
  NodePath.join(workspace, ".agents", "skills"),
  "no-name",
  "description: d",
);
// Not skills: a loose file, a directory without SKILL.md.
NodeFS.writeFileSync(NodePath.join(agents, "notes.md"), "# notes\n");
NodeFS.mkdirSync(NodePath.join(agents, "empty"), { recursive: true });

const skills = makeCodexSkills({ codexHome, agentsSkillsRoot: agents });

describe("the Codex skills extension", () => {
  it.effect("lists the user roots alone without a project, skipping the CLI's bundled skills", () =>
    Effect.gen(function* () {
      expect(yield* skills.list({ workspaceRoot: null })).toEqual([
        {
          name: "release-notes",
          path: userSkill,
          description: "Writes the notes for a release.",
          enabled: true,
        },
        { name: "review", path: shadowed, description: "from the agents folder", enabled: true },
        { name: "shared-one", path: sharedSkill, description: "Quoted: yes", enabled: true },
      ]);
    }),
  );

  it.effect("puts the project's skills first, and a project skill wins its name", () =>
    Effect.gen(function* () {
      const listed = yield* skills.list({ workspaceRoot: workspace });
      expect(listed.map((found) => [found.name, found.path])).toEqual([
        ["review", repoCodex],
        ["no-name", repoAgents],
        ["release-notes", userSkill],
        ["shared-one", sharedSkill],
      ]);
    }),
  );

  it.effect("lists nothing for roots that do not exist", () =>
    Effect.gen(function* () {
      const none = makeCodexSkills({
        codexHome: NodePath.join(ROOT, "nowhere"),
        agentsSkillsRoot: NodePath.join(ROOT, "nowhere-else"),
      });
      expect(yield* none.list({ workspaceRoot: NodePath.join(ROOT, "no-project") })).toEqual([]);
    }),
  );

  it("offers no agents-folder linking: Codex already loads that folder", () => {
    expect(skills.available).toBeUndefined();
    expect(skills.link).toBeUndefined();
  });
});
