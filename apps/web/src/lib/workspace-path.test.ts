import { describe, expect, it } from "vitest";

import { nameAfterPick, projectNameFromPath, workspacePathProblem } from "./workspace-path";

describe("workspacePathProblem", () => {
  it("accepts an absolute posix or windows path", () => {
    expect(workspacePathProblem("/Users/you/code/my-app")).toBeNull();
    expect(workspacePathProblem("  /srv/work  ")).toBeNull();
    expect(workspacePathProblem("C:\\Users\\you\\my-app")).toBeNull();
  });

  it("says nothing about an empty field, which the form already disables", () => {
    expect(workspacePathProblem("")).toBeNull();
    expect(workspacePathProblem("   ")).toBeNull();
  });

  it("rejects a relative path", () => {
    expect(workspacePathProblem("code/my-app")).toMatch(/absolute/);
    expect(workspacePathProblem("./my-app")).toMatch(/absolute/);
  });

  it("rejects a tilde nothing will expand", () => {
    expect(workspacePathProblem("~/code/my-app")).toMatch(/not expanded/);
  });
});

describe("projectNameFromPath", () => {
  it("takes the last segment", () => {
    expect(projectNameFromPath("/Users/you/code/my-app")).toBe("my-app");
    expect(projectNameFromPath("C:\\Users\\you\\my-app")).toBe("my-app");
  });

  it("ignores trailing separators", () => {
    expect(projectNameFromPath("/Users/you/code/my-app//")).toBe("my-app");
  });

  it("is empty for a path with no segments", () => {
    expect(projectNameFromPath("/")).toBe("");
    expect(projectNameFromPath("")).toBe("");
  });
});

describe("nameAfterPick", () => {
  it("names the project after the picked folder while no name was typed", () => {
    expect(nameAfterPick("", "", "/Users/you/code/my-app")).toBe("my-app");
    expect(nameAfterPick("  ", "", "/Users/you/code/my-app")).toBe("my-app");
  });

  it("follows a change of folder while the name is still the old folder's", () => {
    expect(nameAfterPick("old-app", "/Users/you/old-app", "/Users/you/new-app")).toBe("new-app");
  });

  it("keeps a name the user typed", () => {
    expect(nameAfterPick("Website", "/Users/you/old-app", "/Users/you/new-app")).toBe("Website");
  });
});
