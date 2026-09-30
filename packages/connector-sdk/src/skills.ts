/**
 * What the connectors' `skills` extensions share: reading a SKILL.md's
 * frontmatter, and linking a skill from the shared agents folder
 * (`~/.agents/skills`) into a harness's user root.
 */

import { lstat, mkdir, readdir, realpath, stat, symlink, unlink } from "node:fs/promises";
import * as NodePath from "node:path";

export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

const unquote = (value: string): string =>
  value.length >= 2 &&
  ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;

/**
 * The `---` block at the top of a SKILL.md: `name` and `description`, each a
 * plain or quoted scalar, or a block scalar (`>` folds its indented lines into
 * one, `|` keeps them) — long descriptions are commonly written folded.
 */
export const parseSkillFrontmatter = (content: string): SkillFrontmatter => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (match === null) return {};
  const lines = match[1]!.split(/\r?\n/);
  const out: SkillFrontmatter = {};
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^(name|description)\s*:\s*(.*)$/i.exec(lines[index]!);
    if (field === null) continue;
    let value = field[2]!.trim();
    const block = /^([>|])[-+]?$/.exec(value);
    if (block !== null) {
      const body: Array<string> = [];
      while (index + 1 < lines.length && /^(\s|$)/.test(lines[index + 1]!)) {
        index += 1;
        body.push(lines[index]!.trim());
      }
      value = body.join(block[1] === ">" ? " " : "\n").trim();
    } else {
      value = unquote(value);
    }
    if (field[1]!.toLowerCase() === "name") out.name = value;
    else out.description = value;
  }
  return out;
};

const resolves = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * The entries of a user skills root that hold something, skill or not: a
 * file or a directory without SKILL.md takes the name as surely as a skill
 * does, and linking over it could only fail. A symlink whose target is gone
 * holds nothing, so a skill whose link broke is offered again, and linking it
 * replaces the link (`linkSkill`).
 */
export const occupiedSkillEntries = async (root: string): Promise<ReadonlySet<string>> => {
  const entries = await readdir(root).catch((): Array<string> => []);
  const out = new Set<string>();
  for (const entry of entries) {
    if (await resolves(NodePath.join(root, entry))) out.add(entry);
  }
  return out;
};

/**
 * Links `<agentsSkillsRoot>/<entry>` into `userSkillsRoot` as a relative
 * symlink, the shape the skills installer writes, and returns the link.
 *
 * The kernel resolves a relative target against the real directory the link
 * sits in, so the path is taken between real directories. Taken between the
 * paths as spelled, a `~/.claude` that is itself a symlink into a dotfiles
 * repo gets a link that points into the dotfiles tree, and dangles. The agents
 * entry itself is not resolved: the link goes through it, so the agents folder
 * stays the source. A link of the same name whose target is gone is replaced.
 */
export const linkSkill = async (
  userSkillsRoot: string,
  agentsSkillsRoot: string,
  entry: string,
): Promise<string> => {
  await mkdir(userSkillsRoot, { recursive: true });
  const linkPath = NodePath.join(userSkillsRoot, entry);
  const existing = await lstat(linkPath).catch(() => null);
  if (existing?.isSymbolicLink() === true && !(await resolves(linkPath))) {
    await unlink(linkPath);
  }
  const from = await realpath(userSkillsRoot);
  const to = NodePath.join(await realpath(agentsSkillsRoot), entry);
  await symlink(NodePath.relative(from, to), linkPath);
  return linkPath;
};
