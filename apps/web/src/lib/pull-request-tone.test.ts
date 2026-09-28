import { describe, expect, it } from "vitest";

import { GitMerge, GitPullRequest } from "@honeyicons/react";

import { pullRequestMarkLabel, pullRequestTone } from "./pull-request-tone";

describe("pullRequestTone", () => {
  it("tints each state with its own token", () => {
    expect(pullRequestTone({ state: "open", isDraft: false, failing: false })).toEqual({
      kind: "open",
      icon: GitPullRequest,
      state: "Open",
      label: "Open",
      tone: "text-added",
    });
    expect(pullRequestTone({ state: "open", isDraft: true, failing: false })).toMatchObject({
      kind: "draft",
      icon: GitPullRequest,
      label: "Draft",
      tone: "text-muted-foreground",
    });
    expect(pullRequestTone({ state: "merged", isDraft: false, failing: false })).toMatchObject({
      kind: "merged",
      icon: GitMerge,
      label: "Merged",
      tone: "text-primary",
    });
    expect(pullRequestTone({ state: "closed", isDraft: false, failing: false })).toMatchObject({
      kind: "closed",
      icon: GitPullRequest,
      label: "Closed",
      tone: "text-removed",
    });
  });

  it("lets a failing check outrank an open or draft state, but not a finished one", () => {
    expect(pullRequestTone({ state: "open", isDraft: false, failing: true })).toMatchObject({
      kind: "failing",
      state: "Open",
      label: "Checks failing",
      tone: "text-destructive",
    });
    expect(pullRequestTone({ state: "open", isDraft: true, failing: true })).toMatchObject({
      kind: "failing",
      state: "Draft",
    });
    expect(pullRequestTone({ state: "merged", isDraft: false, failing: true }).kind).toBe("merged");
    expect(pullRequestTone({ state: "closed", isDraft: false, failing: true }).kind).toBe("closed");
  });

  it("uses theme tokens only", () => {
    const tones = (["open", "closed", "merged"] as const).flatMap((state) =>
      [false, true].flatMap((isDraft) =>
        [false, true].map((failing) => pullRequestTone({ state, isDraft, failing }).tone),
      ),
    );
    for (const tone of tones) {
      expect(tone).toMatch(/^text-[a-z-]+$/);
    }
  });
});

describe("pullRequestMarkLabel", () => {
  it("names the number and the state, and adds failing checks", () => {
    expect(pullRequestMarkLabel({ number: 12, state: "open", isDraft: false, failing: true })).toBe(
      "PR #12 · Open · Checks failing",
    );
    expect(pullRequestMarkLabel({ number: 3, state: "open", isDraft: true, failing: false })).toBe(
      "PR #3 · Draft",
    );
    expect(
      pullRequestMarkLabel({ number: 9, state: "merged", isDraft: false, failing: true }),
    ).toBe("PR #9 · Merged");
  });
});
