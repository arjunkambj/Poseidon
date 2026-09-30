/**
 * What the connectors' `skills` extensions share: reading a SKILL.md's
 * frontmatter.
 */

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
