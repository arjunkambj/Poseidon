import { describe, expect, it } from "vitest";

import { BRANCH_SLUG_MAX, branchSlug } from "./branchSlug";

describe("branchSlug", () => {
  it("lowercases and joins words with single dashes", () => {
    expect(branchSlug("Fix the Login Page")).toBe("fix-the-login-page");
    expect(branchSlug("  add   --  retries!!  ")).toBe("add-retries");
    expect(branchSlug("v2.1_release/notes")).toBe("v2-1-release-notes");
  });

  it("keeps only ascii letters, digits and dashes, folding accents", () => {
    expect(branchSlug("Café au lait — naïve")).toBe("cafe-au-lait-naive");
    expect(branchSlug("修复 bug 🐛 now")).toBe("bug-now");
    expect(branchSlug("@src/app.ts: why?")).toBe("src-app-ts-why");
  });

  it("never starts or ends with a dash", () => {
    expect(branchSlug("-rf /")).toBe("rf");
    expect(branchSlug("--output=x")).toBe("output-x");
  });

  it("falls back to `thread` when nothing usable is left", () => {
    expect(branchSlug("")).toBe("thread");
    expect(branchSlug("   ")).toBe("thread");
    expect(branchSlug("!!! ??? 🐛")).toBe("thread");
  });

  it("caps the length at a word boundary", () => {
    const slug = branchSlug(
      "Refactor the connector registry so every harness registers itself at boot",
    );
    expect(slug.length).toBeLessThanOrEqual(BRANCH_SLUG_MAX);
    expect(slug).toBe("refactor-the-connector-registry-so-every");
    expect(slug.endsWith("-")).toBe(false);
  });

  it("keeps a word that ends exactly on the limit", () => {
    const exact = `${"a".repeat(BRANCH_SLUG_MAX - 5)} bbbb ccc`;
    expect(branchSlug(exact)).toBe(`${"a".repeat(BRANCH_SLUG_MAX - 5)}-bbbb`);
  });

  it("cuts one long word hard at the limit", () => {
    expect(branchSlug("x".repeat(100))).toBe("x".repeat(BRANCH_SLUG_MAX));
  });
});
