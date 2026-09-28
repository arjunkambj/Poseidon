import { describe, expect, it } from "vitest";

import {
  implementPlanMessage,
  planFileName,
  planHeading,
  planPathProblem,
  planThreadTitle,
} from "@/components/approvals/plan-export";

describe("planHeading", () => {
  it("reads the first heading at any level, without its hashes or markup", () => {
    expect(planHeading("Intro line\n\n## Add **dark** mode ##\n# Later")).toBe("Add dark mode");
    expect(planHeading("# [Health check](https://x.test) for `api`")).toBe("Health check for api");
  });

  it("skips headings inside code fences and empty headings", () => {
    expect(planHeading("```sh\n# not a heading\n```\n#\n### Real one")).toBe("Real one");
  });

  it("is null for a plan without a heading", () => {
    expect(planHeading("1. Do this\n2. Then that")).toBeNull();
    expect(planHeading("#hashtag is not a heading")).toBeNull();
  });
});

describe("planThreadTitle", () => {
  it("takes the heading, else the source's title marked as a plan", () => {
    expect(planThreadTitle("# Ship the RPC\n- step", "Planning")).toBe("Ship the RPC");
    expect(planThreadTitle("- step one", "Planning")).toBe("Planning (plan)");
  });
});

describe("implementPlanMessage", () => {
  it("puts the whole plan under one instruction line", () => {
    expect(implementPlanMessage("\n# Plan\n- a\n")).toBe("Implement this plan:\n\n# Plan\n- a");
  });
});

describe("planFileName", () => {
  it("slugs the heading", () => {
    expect(planFileName("# Add dark mode (v2) — settings!")).toBe("add-dark-mode-v2-settings.md");
    expect(planFileName("# Café menu")).toBe("cafe-menu.md");
    expect(planFileName("# Add CHANGELOG.md")).toBe("add-changelog.md");
  });

  it("falls back to plan.md without a usable heading", () => {
    expect(planFileName("- just steps")).toBe("plan.md");
    expect(planFileName("# ✨✨")).toBe("plan.md");
  });

  it("keeps a long heading's name short", () => {
    const name = planFileName(`# ${"word ".repeat(40)}`);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^word(-word)*\.md$/);
  });
});

describe("planPathProblem", () => {
  it("accepts a relative .md path, nested or not", () => {
    expect(planPathProblem("plan.md")).toBeNull();
    expect(planPathProblem(" docs/plans/Plan.MD ")).toBeNull();
  });

  it("names what is wrong with anything else", () => {
    expect(planPathProblem("  ")).toBe("Enter a file name.");
    expect(planPathProblem("/tmp/plan.md")).toMatch(/inside the workspace/);
    expect(planPathProblem("~/plan.md")).toMatch(/inside the workspace/);
    expect(planPathProblem("../plan.md")).toBe("The file has to stay inside the workspace.");
    expect(planPathProblem("docs/../../plan.md")).toBe(
      "The file has to stay inside the workspace.",
    );
    expect(planPathProblem("plan.txt")).toBe("The file name has to end in .md.");
    expect(planPathProblem("docs/.md")).toBe("The file name has to end in .md.");
  });
});
