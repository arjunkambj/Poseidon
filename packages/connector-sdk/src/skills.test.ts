import { describe, expect, it } from "vitest";

import { parseSkillFrontmatter } from "./skills";

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
