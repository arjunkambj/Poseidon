/**
 * The git shapes a thread and the git RPCs share, and the branch, commit,
 * push, pull-request and worktree RPCs.
 *
 * Kept apart from `rpc.ts` so the branch, commit and worktree surface can grow
 * without pushing the RPC group past its size limit: the RPCs are defined
 * here, their method names are spread into `RPC_METHODS`, and `rpc.ts` lists
 * them in `PoseidonRpcGroup`. `orchestration` imports `ThreadWorktree` from
 * here because a thread records its worktree when it is created.
 */

import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { NonEmptyString } from "./base";
import { ProjectId, ThreadId } from "./ids";
import { PoseidonRpcError } from "./rpcError";

/**
 * The git worktree a thread works in instead of its project's folder.
 *
 * `path` is absolute (the decider refuses anything else) and is the thread's
 * workspace root: its session, its checkpoints, its diff and its `@` search
 * all run there. `branch` is the branch checked out in it, and `baseBranch`
 * the one it was cut from, when that is known. A thread without a worktree is
 * a local thread on the project's own root.
 */
export const ThreadWorktree = Schema.Struct({
  path: NonEmptyString,
  branch: NonEmptyString,
  baseBranch: Schema.optional(NonEmptyString),
});
export type ThreadWorktree = typeof ThreadWorktree.Type;

// ── Branches ───────────────────────────────────────────────────

/**
 * One branch. `name` is what `git switch` takes: `feature` for a local
 * branch, `origin/feature` for a remote-tracking one. `upstream` is the
 * branch a local one tracks. `worktreePath` is set when the branch is checked
 * out in a different worktree than the one the list was read in — git refuses
 * to check it out a second time, so a picker offers it disabled.
 */
export const GitBranch = Schema.Struct({
  name: NonEmptyString,
  kind: Schema.Literals(["local", "remote"]),
  isCurrent: Schema.Boolean,
  upstream: Schema.optional(NonEmptyString),
  worktreePath: Schema.optional(NonEmptyString),
});
export type GitBranch = typeof GitBranch.Type;

/**
 * Every branch of one workspace, local ones first. `current` is `null` on a
 * detached HEAD. `defaultBranch` is the branch new work is cut from: the
 * remote's HEAD when it is known — its local branch, or `<remote>/<name>`
 * when there is no local one — else a local `main` or `master`, else
 * `init.defaultBranch` when that branch exists, else the current branch.
 * `isRepository: false` carries the meaning it does on `GitStatus`.
 */
export const GitBranchList = Schema.Struct({
  isRepository: Schema.Boolean,
  current: Schema.NullOr(NonEmptyString),
  defaultBranch: Schema.NullOr(NonEmptyString),
  remotes: Schema.Array(NonEmptyString),
  branches: Schema.Array(GitBranch),
});
export type GitBranchList = typeof GitBranchList.Type;

// ── Commit, push, pull request ─────────────────────────────────

/**
 * The commit `git.commit` made. `subject` is its first line as git stored it;
 * `branch` is the branch it landed on, `null` on a detached HEAD.
 */
export const GitCommitResult = Schema.Struct({
  sha: NonEmptyString,
  subject: Schema.String,
  branch: Schema.NullOr(NonEmptyString),
});
export type GitCommitResult = typeof GitCommitResult.Type;

/**
 * Where `git.push` pushed the current branch. `setUpstream` is true when the
 * branch had no upstream yet and this push set one (`git push -u`).
 */
export const GitPushResult = Schema.Struct({
  remote: NonEmptyString,
  branch: NonEmptyString,
  setUpstream: Schema.Boolean,
});
export type GitPushResult = typeof GitPushResult.Type;

/**
 * The pull request for the current branch. `created: false` means one was
 * already open for it, and `url` is that one's.
 */
export const GitPullRequestResult = Schema.Struct({
  url: NonEmptyString,
  created: Schema.Boolean,
});
export type GitPullRequestResult = typeof GitPullRequestResult.Type;

/**
 * Whether a pull request can be opened from here: `reason` says why not — the
 * GitHub CLI missing or not signed in — and is `null` when it can.
 */
export const GitPullRequestReadiness = Schema.Struct({
  reason: Schema.NullOr(NonEmptyString),
});
export type GitPullRequestReadiness = typeof GitPullRequestReadiness.Type;

// ── Worktrees ──────────────────────────────────────────────────

/**
 * One worktree of a repository, as `git worktree list` reports it. `isMain` is
 * the repository's main checkout — usually the project's root, unless the
 * project was added from a linked worktree — and neither is ever removed.
 * `branch` is `null` on a detached HEAD; `head` is the commit checked out.
 */
export const GitWorktreeInfo = Schema.Struct({
  path: NonEmptyString,
  branch: Schema.NullOr(NonEmptyString),
  head: NonEmptyString,
  isMain: Schema.Boolean,
});
export type GitWorktreeInfo = typeof GitWorktreeInfo.Type;

/**
 * One frame of a new worktree's setup script run. `skipped` is the only frame
 * when the project has no script. Otherwise `output` frames carry stdout and
 * stderr as they arrive, interleaved, and `exit` ends the stream: `exitCode`
 * is `null` when the script was killed, with the `signal` that did it.
 */
export const WorktreeSetupFrame = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("skipped") }),
  Schema.Struct({ kind: Schema.Literal("output"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("exit"),
    exitCode: Schema.NullOr(Schema.Int),
    signal: Schema.optional(NonEmptyString),
  }),
]);
export type WorktreeSetupFrame = typeof WorktreeSetupFrame.Type;

// ── Method names and RPCs ──────────────────────────────────────

/** Spread into `RPC_METHODS`, so the names stay in the one table. */
export const GIT_RPC_METHODS = {
  gitBranches: "git.branches",
  gitBranchCreate: "git.branch.create",
  gitCheckout: "git.checkout",
  gitCommit: "git.commit",
  gitPush: "git.push",
  gitPullRequestCreate: "git.pullRequest.create",
  gitPullRequestReadiness: "git.pullRequest.readiness",
  gitWorktreeCreate: "git.worktree.create",
  gitWorktreeList: "git.worktree.list",
  gitWorktreeRemove: "git.worktree.remove",
  gitWorktreeSetup: "git.worktree.setup",
} as const;

/** The branches of the thread's root when `threadId` is set, the project's otherwise. */
export const GitBranchesRpc = Rpc.make(GIT_RPC_METHODS.gitBranches, {
  payload: Schema.Struct({ projectId: ProjectId, threadId: Schema.optional(ThreadId) }),
  success: GitBranchList,
  error: PoseidonRpcError,
});

/**
 * Cuts `name` from `from` (default `HEAD`) without tracking it, so a branch
 * cut from `origin/main` never pushes onto main. `checkout` switches to it as
 * well, under the same guards `git.checkout` has. Answers the new list.
 */
export const GitBranchCreateRpc = Rpc.make(GIT_RPC_METHODS.gitBranchCreate, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    name: NonEmptyString,
    from: Schema.optional(NonEmptyString),
    checkout: Schema.Boolean,
  }),
  success: GitBranchList,
  error: PoseidonRpcError,
});

/**
 * Switches the workspace to `branch`; a remote branch becomes a local one
 * tracking it. Refused with `conflict` while a tracked file has uncommitted
 * changes or a turn is running in that workspace. Answers the new list.
 */
export const GitBranchCheckoutRpc = Rpc.make(GIT_RPC_METHODS.gitCheckout, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    branch: NonEmptyString,
  }),
  success: GitBranchList,
  error: PoseidonRpcError,
});

/**
 * Commits with the user's own git identity and hooks. Without `paths` every
 * change is staged (`git add -A`); with them the index is reset first and
 * only those paths are staged, so nothing else rides along. `conflict` when
 * nothing ends up staged, when a hook refuses (with its own output), or while
 * a turn is running in that workspace.
 */
export const GitCommitRpc = Rpc.make(GIT_RPC_METHODS.gitCommit, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    message: NonEmptyString,
    paths: Schema.optional(Schema.Array(NonEmptyString)),
  }),
  success: GitCommitResult,
  error: PoseidonRpcError,
});

/**
 * Pushes the current branch: plainly when it has an upstream, with `-u` to
 * its remote (`branch.<name>.remote`, else `origin`, else the only remote)
 * when it has none. `unavailable` when the repository has no remote.
 */
export const GitPushRpc = Rpc.make(GIT_RPC_METHODS.gitPush, {
  payload: Schema.Struct({ projectId: ProjectId, threadId: Schema.optional(ThreadId) }),
  success: GitPushResult,
  error: PoseidonRpcError,
});

/**
 * Opens a pull request for the current branch with the GitHub CLI, into
 * `base` — else the branch the thread's worktree was cut from, else the
 * default branch. `unavailable` when `gh` is missing or not signed in.
 */
export const GitPullRequestCreateRpc = Rpc.make(GIT_RPC_METHODS.gitPullRequestCreate, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    title: NonEmptyString,
    body: Schema.String,
    base: Schema.optional(NonEmptyString),
  }),
  success: GitPullRequestResult,
  error: PoseidonRpcError,
});

/**
 * Asks `gh` whether it is installed and signed in, so the header can offer
 * Create PR only when it can run. Reads nothing of the repository; the scope
 * says where `gh` runs.
 */
export const GitPullRequestReadinessRpc = Rpc.make(GIT_RPC_METHODS.gitPullRequestReadiness, {
  payload: Schema.Struct({ projectId: ProjectId, threadId: Schema.optional(ThreadId) }),
  success: GitPullRequestReadiness,
  error: PoseidonRpcError,
});

/**
 * Creates a worktree for a new thread: branch `<branchPrefix><slug of name>`
 * cut `--no-track` from `baseBranch` (default: the default branch), in
 * `<Poseidon home>/worktrees/<project>/<slug>`, with `-2`, `-3`… appended when
 * the branch or the directory is taken. `name` is free text — the thread's
 * first message will do. Answers what `thread.create` records as its
 * `worktree`.
 */
export const GitWorktreeCreateRpc = Rpc.make(GIT_RPC_METHODS.gitWorktreeCreate, {
  payload: Schema.Struct({
    projectId: ProjectId,
    name: NonEmptyString,
    baseBranch: Schema.optional(NonEmptyString),
  }),
  success: ThreadWorktree,
  error: PoseidonRpcError,
});

/** Every worktree of the project's repository, its own checkout first. */
export const GitWorktreeListRpc = Rpc.make(GIT_RPC_METHODS.gitWorktreeList, {
  payload: Schema.Struct({ projectId: ProjectId }),
  success: Schema.Array(GitWorktreeInfo),
  error: PoseidonRpcError,
});

/**
 * Removes one of the project's worktrees; its branch is kept, so committed
 * work survives. `invalid` for a path that is not one of them (or is the
 * project's own checkout, or the repository's main one), `conflict` while a
 * thread still works in it or another project was added from it, and
 * `conflict` when it holds uncommitted or untracked work — `force` removes it
 * anyway.
 */
export const GitWorktreeRemoveRpc = Rpc.make(GIT_RPC_METHODS.gitWorktreeRemove, {
  payload: Schema.Struct({
    projectId: ProjectId,
    path: NonEmptyString,
    force: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({}),
  error: PoseidonRpcError,
});

/**
 * Runs the project's setup script (from the settings document, never from the
 * client) in one of its worktrees, streaming the output. Ending the stream
 * early kills the script and everything it started.
 */
export const GitWorktreeSetupRpc = Rpc.make(GIT_RPC_METHODS.gitWorktreeSetup, {
  payload: Schema.Struct({ projectId: ProjectId, path: NonEmptyString }),
  success: WorktreeSetupFrame,
  error: PoseidonRpcError,
  stream: true,
});
