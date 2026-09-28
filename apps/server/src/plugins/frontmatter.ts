/**
 * The `---` frontmatter of a plugin's `SKILL.md`: `name` and `description`
 * only, which is all the plugins page and a connector need. A value may be a
 * YAML block scalar (`>`, `|`, with `-`/`+`) whose indented lines follow the
 * key, the way long descriptions are written.
 *
 * The same small reading the Command Code connector does for its own skills
 * folders, kept here rather than shared so neither side's behaviour moves when
 * the other changes.
 */

export interface SkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
}

export const parseSkillFrontmatter = (content: string): SkillFrontmatter => {
  const text = content.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---")) {
    return {};
  }
  const end = text.indexOf("\n---", 3);
  if (end < 0) {
    return {};
  }
  const out: { name?: string; description?: string } = {};
  const lines = text.slice(3, end).split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]!.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (match === null) {
      continue;
    }
    let value = match[2]!.trim();
    const block = value.match(/^([>|])[-+]?$/);
    if (block !== null) {
      const body: Array<string> = [];
      while (index + 1 < lines.length && /^(\s|$)/.test(lines[index + 1]!)) {
        index++;
        body.push(lines[index]!.trim());
      }
      value = body.join(block[1] === ">" ? " " : "\n").trim();
    } else if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    const key = match[1]!.toLowerCase();
    if (key === "name" && value !== "") {
      out.name = value;
    } else if (key === "description" && value !== "") {
      out.description = value;
    }
  }
  return out;
};
