/**
 * `git.discard` and `git.blame` against real repositories in tmp directories:
 * what a discard brings back and what it deletes in each scope, that it never
 * touches an ignored file or a path outside the repository, that it waits for
 * a running turn, and what blame reports for committed, edited and untracked
 * lines.
 */
import { describe, expect, it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import {
  makeEventId,
  makeProjectId,
  makeThreadId,
  makeTurnId,
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
import { make as checkpointStore } from "./CheckpointStore";
import { layer as gitLayer } from "./Git";
import { GhRunner } from "./GitHubCli";
import { parsePorcelainBlame } from "./Review";
import { WorktreesRoot } from "./Worktrees";

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A tmp directory by its real path: macOS hands out `/var`, git prints `/private/var`. */
const tempDir = (prefix: string) => realpathSync(mkdtempSync(nodePath.join(tmpdir(), prefix)));

/** A repository on `main` with `a.txt` and `b.txt` committed, and `*.log` ignored. */
const makeRepo = () => {
  const root = tempDir("poseidon-review-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@poseidon.local");
  git(root, "config", "user.name", "Poseidon Test");
  git(root, "config", "commit.gpgsign", "false");
  write(root, "a.txt", "one\ntwo\nthree\n");
  write(root, "b.txt", "beta\n");
  write(root, ".gitignore", "*.log\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
};

const write = (root: string, name: string, text: string) => {
  mkdirSync(nodePath.dirname(nodePath.join(root, name)), { recursive: true });
  writeFileSync(nodePath.join(root, name), text);
};
const read = (root: string, name: string) => readFileSync(nodePath.join(root, name), "utf8");
const exists = (root: string, name: string) => existsSync(nodePath.join(root, name));
/** A plain move on disk, the way an agent's shell `mv` leaves it. */
const moveOnDisk = (root: string, from: string, to: string) => {
  writeFileSync(nodePath.join(root, to), readFileSync(nodePath.join(root, from)));
  unlinkSync(nodePath.join(root, from));
};
const status = (root: string) => git(root, "status", "--porcelain").trim();

const createdEvent = (threadId: ThreadId, projectId: ProjectId) =>
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
    },
  }) as OrchestrationEvent;

/** Real sqlite + read models + the git layer, with a project on `root`. */
const stack = (root: string) =>
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
    /** A local thread with a turn in flight in the project's folder. */
    const addRunningThread = Effect.gen(function* () {
      const threadId = makeThreadId();
      const doc = foldThread([createdEvent(threadId, projectId)])!;
      yield* readModels.putThread({
        ...doc,
        status: "running",
        currentTurn: { turnId: makeTurnId(), input: { text: "go", attachments: [], mentions: [] } },
      });
    });
    const services = yield* Layer.build(
      gitLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeedContext(rmContext),
            GhRunner.layer,
            SettingsStore.layer.pipe(Layer.provide(sqlite)),
            Layer.succeed(WorktreesRoot, {
              path: nodePath.join(tmpdir(), "poseidon-no-worktrees"),
            }),
          ),
        ),
      ),
    );
    return { projectId, addRunningThread, git: Context.get(services, GitService) };
  });

// ── Discard ────────────────────────────────────────────────────

describe("git.discard", () => {
  it.live("brings a modified tracked file back to HEAD, in the worktree and the index", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        write(root, "a.txt", "staged\n");
        git(root, "add", "a.txt");
        write(root, "a.txt", "staged\nand more\n");
        write(root, "b.txt", "left alone\n");
        const { projectId, git: service } = yield* stack(root);

        yield* service.discard({ projectId }, { paths: ["a.txt"] });
        expect(read(root, "a.txt")).toBe("one\ntwo\nthree\n");
        expect(status(root)).toBe("M b.txt");
      }),
    ),
  );

  it.live("removes a staged new file, deletes an untracked one and restores a deleted one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        write(root, "staged.txt", "new\n");
        git(root, "add", "staged.txt");
        write(root, "fresh/deep/untracked.txt", "new\n");
        unlinkSync(nodePath.join(root, "b.txt"));
        const { projectId, git: service } = yield* stack(root);

        yield* service.discard(
          { projectId },
          { paths: ["staged.txt", "fresh/deep/untracked.txt", "b.txt"] },
        );
        expect(exists(root, "staged.txt")).toBe(false);
        // The directories the deletion emptied go with it.
        expect(exists(root, "fresh")).toBe(false);
        expect(read(root, "b.txt")).toBe("beta\n");
        expect(status(root)).toBe("");
      }),
    ),
  );

  it.live("discards a rename when both of its paths are named", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        git(root, "mv", "a.txt", "moved.txt");
        const { projectId, git: service } = yield* stack(root);

        yield* service.discard({ projectId }, { paths: ["moved.txt", "a.txt"] });
        expect(exists(root, "moved.txt")).toBe(false);
        expect(read(root, "a.txt")).toBe("one\ntwo\nthree\n");
        expect(status(root)).toBe("");

        // An unstaged rename too: the new path is untracked, the old one deleted.
        moveOnDisk(root, "b.txt", "renamed.txt");
        yield* service.discard({ projectId }, { paths: ["renamed.txt", "b.txt"] });
        expect(exists(root, "renamed.txt")).toBe(false);
        expect(read(root, "b.txt")).toBe("beta\n");
        expect(status(root)).toBe("");
      }),
    ),
  );

  it.live("in the branch scope brings a file back to the fork point", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        git(root, "switch", "-q", "-c", "feature");
        write(root, "a.txt", "branch edit\n");
        write(root, "added.txt", "only on the branch\n");
        git(root, "add", "-A");
        git(root, "commit", "-qm", "branch work");
        write(root, "a.txt", "branch edit\nand uncommitted\n");
        const { projectId, git: service } = yield* stack(root);

        yield* service.discard({ projectId }, { paths: ["a.txt", "added.txt"], mergeBase: "main" });
        expect(read(root, "a.txt")).toBe("one\ntwo\nthree\n");
        expect(exists(root, "added.txt")).toBe(false);
        // The branch's commits stay; only the working tree matches the base.
        expect(git(root, "diff", "--name-only", "main").trim()).toBe("");
        expect(git(root, "rev-list", "--count", "main..HEAD").trim()).toBe("1");
      }),
    ),
  );

  it.live("in the turn scope brings a file back to the turn's checkpoint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        write(root, "a.txt", "after turn one\n");
        const checkpoint = yield* checkpointStore.capture({
          threadId: makeThreadId(),
          turnId: makeTurnId(),
          workspaceRoot: root,
        });
        write(root, "a.txt", "after turn two\n");
        write(root, "c.txt", "new in turn two\n");
        const { projectId, git: service } = yield* stack(root);

        yield* service.discard(
          { projectId },
          { paths: ["a.txt", "c.txt"], source: checkpoint.ref },
        );
        expect(read(root, "a.txt")).toBe("after turn one\n");
        expect(exists(root, "c.txt")).toBe(false);
      }),
    ),
  );

  it.live("discards everything uncommitted but never an ignored file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        write(root, "a.txt", "edited\n");
        write(root, "staged.txt", "new\n");
        git(root, "add", "staged.txt");
        write(root, "loose/untracked.txt", "new\n");
        write(root, "debug.log", "keep me\n");
        write(root, "loose/trace.log", "keep me too\n");
        const { projectId, git: service } = yield* stack(root);

        yield* service.discard({ projectId }, {});
        expect(read(root, "a.txt")).toBe("one\ntwo\nthree\n");
        expect(exists(root, "staged.txt")).toBe(false);
        expect(exists(root, "loose/untracked.txt")).toBe(false);
        expect(read(root, "debug.log")).toBe("keep me\n");
        expect(read(root, "loose/trace.log")).toBe("keep me too\n");
        expect(status(root)).toBe("");
      }),
    ),
  );

  it.live("refuses an ignored path instead of deleting it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        write(root, "debug.log", "keep me\n");
        const { projectId, git: service } = yield* stack(root);
        const error = yield* service
          .discard({ projectId }, { paths: ["debug.log"] })
          .pipe(Effect.flip);
        expect(error.code).toBe("invalid");
        expect(read(root, "debug.log")).toBe("keep me\n");
      }),
    ),
  );

  it.live("refuses a folder instead of restoring everything under it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        write(root, "src/a.txt", "a\n");
        write(root, "src/b.txt", "b\n");
        git(root, "add", "-A");
        git(root, "commit", "-qm", "src");
        write(root, "src/a.txt", "a edited\n");
        write(root, "src/b.txt", "b edited\n");
        const { projectId, git: service } = yield* stack(root);

        const error = yield* service.discard({ projectId }, { paths: ["src"] }).pipe(Effect.flip);
        expect(error.code).toBe("invalid");
        expect(read(root, "src/a.txt")).toBe("a edited\n");
        expect(read(root, "src/b.txt")).toBe("b edited\n");
      }),
    ),
  );

  it.live("deletes a new file that replaced a base folder, leaving the folder's files alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        write(root, "foo/x.txt", "x\n");
        git(root, "add", "-A");
        git(root, "commit", "-qm", "foo");
        git(root, "rm", "-q", "-r", "foo");
        write(root, "foo", "now a file\n");
        const { projectId, git: service } = yield* stack(root);

        yield* service.discard({ projectId }, { paths: ["foo"] });
        expect(exists(root, "foo")).toBe(false);
        // The folder's own rows bring it back, one file at a time.
        yield* service.discard({ projectId }, { paths: ["foo/x.txt"] });
        expect(read(root, "foo/x.txt")).toBe("x\n");
        expect(status(root)).toBe("");
      }),
    ),
  );

  it.live("rejects paths that could leave the repository, touching nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const outside = tempDir("poseidon-review-outside-");
        write(outside, "x", "outside\n");
        const root = makeRepo();
        write(root, "a.txt", "edited\n");
        const { projectId, git: service } = yield* stack(root);

        for (const path of [
          "../x",
          `${outside}/x`,
          "/etc/passwd",
          "-x",
          "a/../../b",
          "./a.txt",
          ".git/config",
          "a\\..\\x",
        ]) {
          const error = yield* service
            .discard({ projectId }, { paths: ["a.txt", path] })
            .pipe(Effect.flip);
          expect(error.code, path).toBe("invalid");
        }
        // Validated before anything ran: even the good path is untouched.
        expect(read(root, "a.txt")).toBe("edited\n");
        expect(read(outside, "x")).toBe("outside\n");
      }),
    ),
  );

  it.live("refuses a whole discard in any scope but uncommitted, and a flag-shaped ref", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        write(root, "a.txt", "edited\n");
        const { projectId, git: service } = yield* stack(root);

        const withSource = yield* service
          .discard({ projectId }, { source: "HEAD" })
          .pipe(Effect.flip);
        expect(withSource.code).toBe("invalid");
        const withBase = yield* service
          .discard({ projectId }, { mergeBase: "main" })
          .pipe(Effect.flip);
        expect(withBase.code).toBe("invalid");
        const flagRef = yield* service
          .discard({ projectId }, { paths: ["a.txt"], source: "--output=/tmp/x" })
          .pipe(Effect.flip);
        expect(flagRef.code).toBe("invalid");
        expect(read(root, "a.txt")).toBe("edited\n");
      }),
    ),
  );

  it.live("answers conflict while a turn runs in the workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        write(root, "a.txt", "edited\n");
        const { projectId, addRunningThread, git: service } = yield* stack(root);
        yield* addRunningThread;

        const error = yield* service.discard({ projectId }, { paths: ["a.txt"] }).pipe(Effect.flip);
        expect(error.code).toBe("conflict");
        expect(read(root, "a.txt")).toBe("edited\n");
      }),
    ),
  );

  it.live("runs from the repository's top for a project in a subfolder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        write(root, "app/src.txt", "committed\n");
        git(root, "add", "-A");
        git(root, "commit", "-qm", "app");
        write(root, "app/src.txt", "edited\n");
        const { projectId, git: service } = yield* stack(nodePath.join(root, "app"));

        yield* service.discard({ projectId }, { paths: ["app/src.txt"] });
        expect(read(root, "app/src.txt")).toBe("committed\n");
      }),
    ),
  );
});

// ── Blame ──────────────────────────────────────────────────────

describe("git.blame", () => {
  it.live("names the commit of committed lines and marks edited ones uncommitted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        write(root, "a.txt", "one\nTWO\nthree\n");
        const { projectId, git: service } = yield* stack(root);
        const sha = git(root, "rev-parse", "HEAD").trim();

        const answer = yield* service.blame({ projectId }, { path: "a.txt" });
        expect(answer.untracked).toBe(false);
        expect(
          answer.entries.map(({ sha, author, summary, uncommitted, startLine, lineCount }) => ({
            sha,
            author,
            summary,
            uncommitted,
            startLine,
            lineCount,
          })),
        ).toEqual([
          {
            sha,
            author: "Poseidon Test",
            summary: "init",
            uncommitted: false,
            startLine: 1,
            lineCount: 1,
          },
          {
            sha: "0".repeat(40),
            author: "Not committed yet",
            summary: "",
            uncommitted: true,
            startLine: 2,
            lineCount: 1,
          },
          {
            sha,
            author: "Poseidon Test",
            summary: "init",
            uncommitted: false,
            startLine: 3,
            lineCount: 1,
          },
        ]);
        expect(Number.isNaN(Date.parse(answer.entries[0]!.time))).toBe(false);
      }),
    ),
  );

  it.live("blames only the asked range, cut to the end of the file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { projectId, git: service } = yield* stack(root);

        const answer = yield* service.blame(
          { projectId },
          { path: "a.txt", startLine: 2, endLine: 99 },
        );
        expect(answer.entries.map((entry) => [entry.startLine, entry.lineCount])).toEqual([[2, 2]]);
        const past = yield* service.blame({ projectId }, { path: "a.txt", startLine: 10 });
        expect(past.entries).toEqual([]);
        const backwards = yield* service
          .blame({ projectId }, { path: "a.txt", startLine: 3, endLine: 2 })
          .pipe(Effect.flip);
        expect(backwards.code).toBe("invalid");
      }),
    ),
  );

  it.live("answers untracked for a file with no history, and refuses an escaping path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        write(root, "new.txt", "fresh\n");
        const { projectId, git: service } = yield* stack(root);

        expect(yield* service.blame({ projectId }, { path: "new.txt" })).toEqual({
          path: "new.txt",
          untracked: true,
          entries: [],
        });
        const escape = yield* service.blame({ projectId }, { path: "../a.txt" }).pipe(Effect.flip);
        expect(escape.code).toBe("invalid");
      }),
    ),
  );
});

describe("parsePorcelainBlame", () => {
  it("folds consecutive lines of one commit and splits interleaved ones", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const porcelain = [
      `${a} 1 1 2`,
      "author Ada",
      "author-time 1700000000",
      "summary First",
      "filename x",
      "\tline one",
      `${a} 2 2`,
      "\tline two",
      `${b} 1 3 1`,
      "author Bea",
      "author-time 1700000100",
      "summary Second",
      "filename x",
      "\tline three",
      `${a} 3 4 1`,
      "\tline four",
      "",
    ].join("\n");
    expect(parsePorcelainBlame(porcelain)).toEqual([
      {
        sha: a,
        author: "Ada",
        time: "2023-11-14T22:13:20.000Z",
        summary: "First",
        uncommitted: false,
        startLine: 1,
        lineCount: 2,
      },
      {
        sha: b,
        author: "Bea",
        time: "2023-11-14T22:15:00.000Z",
        summary: "Second",
        uncommitted: false,
        startLine: 3,
        lineCount: 1,
      },
      {
        sha: a,
        author: "Ada",
        time: "2023-11-14T22:13:20.000Z",
        summary: "First",
        uncommitted: false,
        startLine: 4,
        lineCount: 1,
      },
    ]);
  });
});
