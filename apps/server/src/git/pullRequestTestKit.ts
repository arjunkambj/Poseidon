/**
 * The pieces the pull request tests share: real repositories and worktrees in
 * tmp directories, the git layer over real sqlite read models with a fake
 * `GhRunner`, and the gh output captured under `fixtures/`. Imported by the
 * test files only.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import type { ThreadWorktree } from "@poseidon/contracts/git";
import {
  makeEventId,
  makeProjectId,
  makeThreadId,
  type ProjectId,
  type ThreadId,
} from "@poseidon/contracts/ids";
import type { OrchestrationEvent } from "@poseidon/contracts/orchestration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { foldThread } from "../orchestration/state";
import { runMigrations } from "../persistence/Migrations";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { GitService, SettingsStore } from "../rpc/services";
import { layer as gitLayer } from "./Git";
import { GhRunner, type GhOutput } from "./GitHubCli";
import { WorktreesRoot } from "./Worktrees";

export const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export const tempDir = (prefix: string) =>
  realpathSync(mkdtempSync(nodePath.join(tmpdir(), prefix)));

/** A repository with one commit on `main`, checked out on `branch` when given. */
export const makeRepo = (branch?: string) => {
  const root = tempDir("poseidon-pr-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@poseidon.local");
  git(root, "config", "user.name", "Poseidon Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(nodePath.join(root, "a.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  if (branch !== undefined) git(root, "switch", "-q", "-c", branch);
  return root;
};

/** A linked worktree of `root` on `branch`, created when it does not exist yet. */
export const addWorktree = (root: string, branch: string, create = true): ThreadWorktree => {
  const path = nodePath.join(tempDir("poseidon-pr-wt-"), "tree");
  if (create) git(root, "worktree", "add", "-q", "-b", branch, path);
  else git(root, "worktree", "add", "-q", path, branch);
  return { path, branch, baseBranch: "main" };
};

const createdEvent = (
  threadId: ThreadId,
  projectId: ProjectId,
  worktree: ThreadWorktree | undefined,
): OrchestrationEvent =>
  ({
    sequence: 1,
    eventId: makeEventId(),
    streamKind: "thread",
    streamId: threadId,
    streamVersion: 1,
    occurredAt: new Date().toISOString(),
    actor: "user",
    type: "thread.created",
    payload: {
      threadId,
      projectId,
      title: "Thread",
      settings: { model: "fake/model", runtimeMode: "full-access", interactionMode: "default" },
      ...(worktree === undefined ? {} : { worktree }),
    },
  }) as OrchestrationEvent;

/** Real sqlite + read models + the git layer over `gh`, with a project on `root`. */
export const stack = (root: string, gh: GhRunner["Service"]) =>
  Effect.gen(function* () {
    const sqlite = Layer.succeedContext(yield* Layer.build(sqliteTestLayer()));
    yield* runMigrations.pipe(Effect.provide(sqlite));
    const rmContext = yield* Layer.build(ReadModelStore.layer.pipe(Layer.provide(sqlite)));
    const readModels = Context.get(rmContext, ReadModelStore);
    const now = new Date().toISOString();
    const projectId = makeProjectId();
    yield* readModels.putProject({
      projectId,
      name: "test",
      workspaceRoot: root,
      createdAt: now,
      updatedAt: now,
      removed: false,
    });
    const addThread = (options: { worktree?: ThreadWorktree; deleted?: boolean } = {}) =>
      Effect.gen(function* () {
        const threadId = makeThreadId();
        const doc = foldThread([createdEvent(threadId, projectId, options.worktree)])!;
        yield* readModels.putThread({ ...doc, deleted: options.deleted === true });
        return threadId;
      });
    const services = yield* Layer.build(
      gitLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeedContext(rmContext),
            Layer.succeed(GhRunner, gh),
            SettingsStore.layer.pipe(Layer.provide(sqlite)),
            Layer.succeed(WorktreesRoot, {
              path: nodePath.join(tmpdir(), "poseidon-no-worktrees"),
            }),
          ),
        ),
      ),
    );
    return { projectId, addThread, git: Context.get(services, GitService) };
  });

export const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

export const ok = (stdout: string): GhOutput => ({ stdout, stderr: "", exitCode: 0 });
