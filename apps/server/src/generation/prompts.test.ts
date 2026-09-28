/**
 * The prompts and the reading of answers: each writing style's instruction,
 * finding the repository's pull request template, the input caps, and the
 * lenient parse of what a harness wrote back.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";

import { parseCommitMessage, parsePullRequest, parseTitle } from "./parse";
import {
  DEFAULT_PR_LAYOUT,
  PATCH_CAP,
  SUMMARY_CAP,
  capText,
  commitPrompt,
  findPullRequestTemplate,
  pullRequestPrompt,
  styleInstruction,
  titlePrompt,
  type StyleContext,
} from "./prompts";

const style = (overrides: Partial<StyleContext> = {}): StyleContext => ({
  style: "repository",
  customInstructions: "",
  recentSubjects: ["fix(web): keep the draft", "feat(server): add the index"],
  agentNotes: "Commits use lowercase subjects.",
  ...overrides,
});

describe("styleInstruction", () => {
  it("repository conventions pass the recent subjects and the agent notes as text", () => {
    const text = styleInstruction(style());
    expect(text).toContain("- fix(web): keep the draft");
    expect(text).toContain("- feat(server): add the index");
    expect(text).toContain("Commits use lowercase subjects.");
  });

  it("a repository with no history gets a plain imperative instruction", () => {
    const text = styleInstruction(style({ recentSubjects: [], agentNotes: null }));
    expect(text).toMatch(/imperative/);
    expect(text).not.toContain("recent commit subjects");
  });

  it("conventional asks for Conventional Commits", () => {
    const text = styleInstruction(style({ style: "conventional" }));
    expect(text).toContain("Conventional Commits");
    expect(text).not.toContain("keep the draft");
  });

  it("custom passes the user's instructions, and empty custom reads the repository", () => {
    const custom = styleInstruction(style({ style: "custom", customInstructions: "Use emoji." }));
    expect(custom).toContain("Use emoji.");
    expect(custom).not.toContain("keep the draft");
    expect(styleInstruction(style({ style: "custom", customInstructions: "  " }))).toBe(
      styleInstruction(style()),
    );
  });
});

describe("the prompts", () => {
  it("a commit prompt asks for a short imperative subject as JSON", () => {
    const prompt = commitPrompt({ style: style(), files: ["M\ta.txt"], patch: "+one" });
    expect(prompt.system).toContain("at most 72 characters");
    expect(prompt.system).toContain('{"subject": string, "body": string}');
    expect(prompt.prompt).toContain("M\ta.txt");
    expect(prompt.prompt).toContain("+one");
    expect(prompt.jsonSchema).toEqual({
      type: "object",
      properties: { subject: { type: "string" }, body: { type: "string" } },
      required: ["subject", "body"],
      additionalProperties: false,
    });
  });

  it("a pull request prompt follows the template, else Summary and Testing", () => {
    const input = {
      style: style(),
      base: "main",
      branch: "poseidon/parser",
      commits: "- Add the parser",
      patch: "+parse",
    };
    const plain = pullRequestPrompt({ ...input, template: null });
    expect(plain.system).toContain(DEFAULT_PR_LAYOUT);
    expect(plain.prompt).toContain("poseidon/parser into main");
    const templated = pullRequestPrompt({ ...input, template: "## Why\n\n## Risk" });
    expect(templated.system).toContain("## Why\n\n## Risk");
    expect(templated.system).not.toContain(DEFAULT_PR_LAYOUT);
  });

  it("a title prompt asks for 3 to 8 words under 40 characters", () => {
    const prompt = titlePrompt("User: fix the login redirect");
    expect(prompt.system).toContain("3 to 8 words and under 40 characters");
    expect(prompt.prompt).toContain("fix the login redirect");
    expect(Object.keys(prompt.jsonSchema["properties"] as object)).toEqual(["title"]);
  });
});

describe("the caps", () => {
  it("capText keeps the head or the tail and says what it left out", () => {
    expect(capText("short", 10)).toBe("short");
    expect(capText("abcdefghij", 4)).toBe("abcd\n[… 6 more characters left out]");
    expect(capText("abcdefghij", 4, "tail")).toBe("[… 6 more characters left out]\nghij");
  });

  it("a patch is cut at 50k characters and a conversation keeps its last 8k", () => {
    const patch = "x".repeat(PATCH_CAP + 1_000);
    const commit = commitPrompt({ style: style(), files: [], patch });
    expect(commit.prompt).toContain("[… 1000 more characters left out]");
    expect(commit.prompt.length).toBeLessThan(PATCH_CAP + 2_000);

    const conversation = `${"a".repeat(SUMMARY_CAP)}THE END`;
    const title = titlePrompt(conversation);
    expect(title.prompt).toContain("THE END");
    expect(title.prompt).toContain("[… 7 more characters left out]");
  });
});

describe("findPullRequestTemplate", () => {
  const repo = () => mkdtempSync(nodePath.join(tmpdir(), "poseidon-pr-template-"));
  const put = (root: string, path: string, text: string) => {
    mkdirSync(nodePath.dirname(nodePath.join(root, path)), { recursive: true });
    writeFileSync(nodePath.join(root, path), text);
  };

  it("finds the template in .github, the root or docs, in any case", () => {
    const github = repo();
    put(github, ".github/pull_request_template.md", "github");
    put(github, "PULL_REQUEST_TEMPLATE.md", "root");
    expect(findPullRequestTemplate(github)).toBe("github");

    const upper = repo();
    put(upper, ".github/PULL_REQUEST_TEMPLATE.md", "upper");
    expect(findPullRequestTemplate(upper)).toBe("upper");

    const root = repo();
    put(root, "PULL_REQUEST_TEMPLATE.md", "root");
    expect(findPullRequestTemplate(root)).toBe("root");

    const docs = repo();
    put(docs, "docs/pull_request_template.md", "docs");
    expect(findPullRequestTemplate(docs)).toBe("docs");
  });

  it("falls back to the first file of .github/PULL_REQUEST_TEMPLATE/", () => {
    const root = repo();
    put(root, ".github/PULL_REQUEST_TEMPLATE/b_feature.md", "feature");
    put(root, ".github/PULL_REQUEST_TEMPLATE/a_bug.md", "bug");
    expect(findPullRequestTemplate(root)).toBe("bug");
  });

  it("answers null with no template, or an empty one", () => {
    expect(findPullRequestTemplate(repo())).toBeNull();
    const empty = repo();
    put(empty, ".github/pull_request_template.md", "  \n");
    expect(findPullRequestTemplate(empty)).toBeNull();
  });
});

describe("the lenient parse", () => {
  it("reads a bare object, a fenced one and one after a sentence", () => {
    expect(parseCommitMessage('{"subject":"Fix the typo","body":""}')).toEqual({
      subject: "Fix the typo",
      body: "",
    });
    expect(parseCommitMessage('```json\n{"subject":"Fix it.","body":"- why"}\n```')).toEqual({
      subject: "Fix it",
      body: "- why",
    });
    expect(parsePullRequest('Here you go: {"title":"Add retries","body":"## Summary"}')).toEqual({
      title: "Add retries",
      body: "## Summary",
    });
  });

  it("falls back to plain text: the first line is the subject, the rest the body", () => {
    expect(parseCommitMessage("Subject: Add the parser\n\n- parses input\n")).toEqual({
      subject: "Add the parser",
      body: "- parses input",
    });
    expect(parsePullRequest("# Add retries\n\nBody text")).toEqual({
      title: "Add retries",
      body: "Body text",
    });
  });

  it("a title is one clean line, cut at a word", () => {
    expect(parseTitle('{"title":"  \\"Fix the login page\\".  "}')).toBe("Fix the login page");
    expect(parseTitle("Title: Tidy the sidebar!")).toBe("Tidy the sidebar");
    const long = parseTitle(`${"word ".repeat(30)}end`);
    expect(long?.length).toBeLessThanOrEqual(80);
    expect(long?.endsWith("word")).toBe(true);
  });

  it("nothing usable is null", () => {
    expect(parseCommitMessage("   ")).toBeNull();
    expect(parseTitle('{"title":""}')).toBeNull();
    expect(parsePullRequest("```\n\n```")).toBeNull();
  });
});
