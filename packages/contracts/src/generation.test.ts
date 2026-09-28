import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  DEFAULT_GENERATION_SETTINGS,
  GENERATION_RPC_METHODS,
  GenerationSettings,
  GitGenerateCommitMessageRpc,
  GitGeneratePullRequestRpc,
  ThreadRegenerateTitleRpc,
} from "./generation";
import { GitWorktreeCreated, ThreadWorktree } from "./git";
import { PoseidonRpcGroup, RPC_METHODS } from "./rpc";

const PROJECT_ID = "018f2b6e-1c2d-7a3b-8c4d-5e6f7a8b9c0e";
const THREAD_ID = "018f2b6e-1c2d-7a3b-8c4d-5e6f7a8b9c0d";
const NOTICE = "Your Writing model is off, so Same as the thread wrote this.";

describe("generation RPC names", () => {
  it("name each RPC after the method it is made with", () => {
    expect(GENERATION_RPC_METHODS).toEqual({
      gitGenerateCommitMessage: "git.generateCommitMessage",
      gitGeneratePullRequest: "git.generatePullRequest",
      threadRegenerateTitle: "thread.regenerateTitle",
    });
    expect(GitGenerateCommitMessageRpc._tag).toBe("git.generateCommitMessage");
    expect(GitGeneratePullRequestRpc._tag).toBe("git.generatePullRequest");
    expect(ThreadRegenerateTitleRpc._tag).toBe("thread.regenerateTitle");
  });

  it("are in the method table and the group, so the server must answer them", () => {
    for (const method of Object.values(GENERATION_RPC_METHODS)) {
      expect(Object.values(RPC_METHODS)).toContain(method);
      expect(PoseidonRpcGroup.requests.has(method)).toBe(true);
    }
  });
});

describe("git.worktree.create's answer", () => {
  const worktree = { path: "/w/fix", branch: "poseidon/fix", baseBranch: "origin/main" };

  it("carries a notice beside the worktree, and the worktree alone still decodes", () => {
    const decode = Schema.decodeUnknownSync(GitWorktreeCreated);
    expect(decode(worktree)).toEqual(worktree);
    expect(decode({ ...worktree, notice: "Couldn't fetch main." })).toEqual({
      ...worktree,
      notice: "Couldn't fetch main.",
    });
    expect(() => decode({ ...worktree, notice: "" })).toThrow();
  });

  it("leaves the stored ThreadWorktree without a notice", () => {
    expect(Object.keys(ThreadWorktree.fields).sort()).toEqual(["baseBranch", "branch", "path"]);
  });
});

describe("git.generateCommitMessage", () => {
  const payload = Schema.decodeUnknownSync(GitGenerateCommitMessageRpc.payloadSchema);
  const success = Schema.decodeUnknownSync(GitGenerateCommitMessageRpc.successSchema);

  it("takes a project, and optionally a thread and the ticked paths", () => {
    expect(payload({ projectId: PROJECT_ID })).toEqual({ projectId: PROJECT_ID });
    const full = { projectId: PROJECT_ID, threadId: THREAD_ID, paths: ["src/a.ts"] };
    expect(payload(full)).toEqual(full);
    expect(() => payload({ projectId: PROJECT_ID, paths: [""] })).toThrow();
  });

  it("answers a subject and a body, with a notice only when something fell back", () => {
    expect(success({ subject: "Fix the lantern", body: "" })).toEqual({
      subject: "Fix the lantern",
      body: "",
    });
    expect(
      success({ subject: "Fix the lantern", body: "- trim wick", notice: NOTICE }).notice,
    ).toBe(NOTICE);
    expect(() => success({ subject: "", body: "" })).toThrow();
  });
});

describe("git.generatePullRequest", () => {
  const payload = Schema.decodeUnknownSync(GitGeneratePullRequestRpc.payloadSchema);
  const success = Schema.decodeUnknownSync(GitGeneratePullRequestRpc.successSchema);

  it("takes a project, and optionally a thread and a base branch", () => {
    expect(payload({ projectId: PROJECT_ID })).toEqual({ projectId: PROJECT_ID });
    const full = { projectId: PROJECT_ID, threadId: THREAD_ID, base: "main" };
    expect(payload(full)).toEqual(full);
    expect(() => payload({ projectId: PROJECT_ID, base: "" })).toThrow();
  });

  it("answers a title and a body", () => {
    const answer = { title: "Fix the lantern", body: "## Summary\n\n- trim wick" };
    expect(success(answer)).toEqual(answer);
    expect(() => success({ title: "", body: "" })).toThrow();
  });
});

describe("thread.regenerateTitle", () => {
  const payload = Schema.decodeUnknownSync(ThreadRegenerateTitleRpc.payloadSchema);
  const success = Schema.decodeUnknownSync(ThreadRegenerateTitleRpc.successSchema);

  it("takes a thread and answers its new title", () => {
    expect(payload({ threadId: THREAD_ID })).toEqual({ threadId: THREAD_ID });
    expect(() => payload({})).toThrow();
    expect(success({ title: "Lantern flicker fix", notice: NOTICE })).toEqual({
      title: "Lantern flicker fix",
      notice: NOTICE,
    });
    expect(() => success({ title: "" })).toThrow();
  });
});

describe("GenerationSettings", () => {
  const decode = Schema.decodeUnknownSync(GenerationSettings);

  it("decodes an empty struct to the defaults", () => {
    expect(decode({})).toEqual(DEFAULT_GENERATION_SETTINGS);
    expect(DEFAULT_GENERATION_SETTINGS).toEqual({
      writingModel: null,
      writingEffort: "low",
      autoTitle: true,
    });
  });

  it("refuses an effort the Writing model select does not offer", () => {
    expect(() => decode({ writingEffort: "xhigh" })).toThrow();
  });
});
