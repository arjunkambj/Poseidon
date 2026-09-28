import { describe, expect, it, vi } from "vitest";

import type { PullRequestCheck, PullRequestDetail } from "@poseidon/contracts/pullRequest";

import {
  actionPayload,
  allowedMergeMethods,
  mergeBlock,
  mergeWarning,
  prActionCopy,
  prActions,
  runPrAction,
  type PrActionOutcome,
} from "./pr-actions";

const check = (name: string, bucket: PullRequestCheck["bucket"]): PullRequestCheck => ({
  name,
  workflow: "CI",
  bucket,
  startedAt: null,
  completedAt: null,
  url: null,
  jobId: null,
});

const base: PullRequestDetail = {
  number: 42,
  title: "Teach the parser about tabs",
  url: "https://github.com/o/r/pull/42",
  state: "open",
  isDraft: false,
  baseRefName: "main",
  headRefName: "tabs",
  headRefOid: "0123456789abcdef0123456789abcdef01234567",
  author: "ana",
  updatedAt: "2026-09-28T11:00:00Z",
  mergeable: "mergeable",
  reviewDecision: null,
  checks: [],
  reviews: [],
  reviewThreads: [],
  comments: [],
  mergeMethods: { merge: true, squash: true, rebase: true },
};

const kinds = (pullRequest: PullRequestDetail) =>
  prActions(pullRequest).map((offer) => [offer.kind, offer.disabledReason]);

describe("prActions", () => {
  it("offers nothing on a merged pull request and only Reopen on a closed one", () => {
    expect(prActions({ ...base, state: "merged" })).toEqual([]);
    expect(kinds({ ...base, state: "closed" })).toEqual([["reopen", null]]);
  });

  it("offers Ready for review and Close on a draft", () => {
    expect(kinds({ ...base, isDraft: true })).toEqual([
      ["ready", null],
      ["close", null],
    ]);
  });

  it("offers Merge first, then Convert to draft and Close, on a ready one", () => {
    expect(kinds(base)).toEqual([
      ["merge", null],
      ["draft", null],
      ["close", null],
    ]);
  });

  it("disables Merge with a reason while the branch conflicts or no method is allowed", () => {
    expect(kinds({ ...base, mergeable: "conflicting" })[0]).toEqual([
      "merge",
      "The branch conflicts with main. Resolve the conflicts first.",
    ]);
    expect(
      mergeBlock({ ...base, mergeMethods: { merge: false, squash: false, rebase: false } }),
    ).toBe("The repository allows no merge method.");
    // GitHub still computing is not a block.
    expect(mergeBlock({ ...base, mergeable: "unknown" })).toBeNull();
  });

  it("warns about failing checks without blocking the merge", () => {
    expect(mergeWarning(base)).toBeNull();
    expect(mergeWarning({ ...base, checks: [check("lint", "fail"), check("unit", "pass")] })).toBe(
      "1 check is failing.",
    );
    expect(mergeWarning({ ...base, checks: [check("a", "fail"), check("b", "fail")] })).toBe(
      "2 checks are failing.",
    );
    expect(kinds({ ...base, checks: [check("lint", "fail")] })[0]).toEqual(["merge", null]);
  });

  it("lists the allowed methods squash first", () => {
    expect(allowedMergeMethods(base)).toEqual(["squash", "merge", "rebase"]);
    expect(
      allowedMergeMethods({ ...base, mergeMethods: { merge: true, squash: false, rebase: true } }),
    ).toEqual(["merge", "rebase"]);
  });

  it("sends the method with a merge only", () => {
    expect(actionPayload("merge", "rebase")).toEqual({ kind: "merge", method: "rebase" });
    expect(actionPayload("draft", "rebase")).toEqual({ kind: "draft" });
  });

  it("names the pinned head in Merge's confirm", () => {
    const copy = prActionCopy("merge", base);
    expect(copy.title).toBe("Merge #42 into main?");
    expect(copy.description).toContain("tabs at 0123456");
  });
});

describe("runPrAction", () => {
  const toasts = () => ({ loading: vi.fn(), success: vi.fn(), error: vi.fn() });

  it("turns the pending toast into the success in place, pinning the head on a merge", async () => {
    const toast = toasts();
    const run = vi.fn(async (): Promise<PrActionOutcome> => ({
      ok: true,
      view: { state: "none", branch: "tabs" },
    }));
    await runPrAction(run, toast, base, "merge", "squash");
    expect(run).toHaveBeenCalledWith({ kind: "merge", method: "squash" }, base.headRefOid);
    const id = toast.loading.mock.calls[0]?.[1];
    expect(toast.loading).toHaveBeenCalledWith("Merging #42…", id);
    expect(toast.success).toHaveBeenCalledWith("Merged #42", id);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("says why it failed in the server's words, and pins nothing but a merge", async () => {
    const toast = toasts();
    const run = vi.fn(async (): Promise<PrActionOutcome> => ({
      ok: false,
      message: "gh not available: install the GitHub CLI and run gh auth login",
    }));
    await runPrAction(run, toast, base, "close", "squash");
    expect(run).toHaveBeenCalledWith({ kind: "close" }, undefined);
    const id = toast.loading.mock.calls[0]?.[1];
    expect(toast.error).toHaveBeenCalledWith(
      "Close failed: gh not available: install the GitHub CLI and run gh auth login",
      id,
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});
