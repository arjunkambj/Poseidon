import { DEFAULT_GIT_SETTINGS, type GitSettings } from "@poseidon/contracts/settings";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CommitTextSection, WorktreeFromOriginRow } from "./commit-text-section";

const render = (git: GitSettings) =>
  renderToStaticMarkup(<CommitTextSection git={git} disabled={false} onChange={() => {}} />);

describe("CommitTextSection", () => {
  it("shows every row, and no instructions field for Repository conventions", () => {
    const markup = render(DEFAULT_GIT_SETTINGS);
    expect(markup).toContain("Commit and PR text");
    expect(markup).toContain("Writing style");
    expect(markup).toContain("Repository conventions");
    expect(markup).toContain("Follow the repository&#x27;s PR template");
    expect(markup).toContain("Draft commit messages");
    expect(markup).toContain("Template");
    expect(markup).not.toContain("<textarea");
  });

  it("shows the instructions field, with its counter, only for Custom", () => {
    const markup = render({
      ...DEFAULT_GIT_SETTINGS,
      writingStyle: "custom",
      customInstructions: "Use the past tense.",
    });
    expect(markup).toMatch(/<textarea[^>]*id="git-custom-instructions"/u);
    expect(markup).toContain("Use the past tense.");
    expect(markup).toContain("19 / 20,000");
    expect(render({ ...DEFAULT_GIT_SETTINGS, writingStyle: "conventional" })).not.toContain(
      "<textarea",
    );
  });

  it("reads the draft mode by its label", () => {
    const markup = render({ ...DEFAULT_GIT_SETTINGS, draftCommitMessages: "generate" });
    expect(markup).toContain("Generate when the dialog opens");
  });
});

describe("WorktreeFromOriginRow", () => {
  it("shows the switch in its saved state", () => {
    const on = renderToStaticMarkup(
      <WorktreeFromOriginRow git={DEFAULT_GIT_SETTINGS} disabled={false} onChange={() => {}} />,
    );
    expect(on).toContain("Start new worktrees from origin");
    expect(on).toMatch(/data-checked/u);
    const off = renderToStaticMarkup(
      <WorktreeFromOriginRow
        git={{ ...DEFAULT_GIT_SETTINGS, worktreeFromOrigin: false }}
        disabled={false}
        onChange={() => {}}
      />,
    );
    expect(off).toMatch(/data-unchecked/u);
  });
});
