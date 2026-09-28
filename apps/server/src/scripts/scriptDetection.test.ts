/**
 * `scripts.detect` over a monorepo laid out in a tmp directory and the real
 * read models: the root's and the workspace packages' scripts, a thread's
 * worktree used as the root, nothing for a folder without package.json, a
 * symlinked package outside the root left out, and an unknown project
 * refused.
 */
import { describe, expect, it } from "@effect/vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { makeEventId, makeProjectId, makeThreadId, type ProjectId } from "@poseidon/contracts/ids";
import type { ThreadWorktree } from "@poseidon/contracts/git";
import type { OrchestrationEvent } from "@poseidon/contracts/orchestration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { foldThread } from "../orchestration/state";
import { runMigrations } from "../persistence/Migrations";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { layer as scriptDetectionLayer, ScriptDetection } from "./ScriptDetection";

const tempDir = (prefix: string) => realpathSync(mkdtempSync(nodePath.join(tmpdir(), prefix)));

const writeJson = (path: string, value: unknown) => {
  mkdirSync(nodePath.dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

/** A pnpm monorepo: the root, apps/web, packages/ui, and a symlink out of the root. */
const makeMonorepo = () => {
  const root = tempDir("poseidon-scripts-");
  writeJson(nodePath.join(root, "package.json"), {
    name: "acme",
    packageManager: "pnpm@10.0.0",
    scripts: { dev: "turbo dev", check: "turbo check" },
  });
  writeFileSync(
    nodePath.join(root, "pnpm-workspace.yaml"),
    "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
  );
  writeJson(nodePath.join(root, "apps/web/package.json"), {
    name: "@acme/web",
    scripts: { dev: "vite" },
  });
  writeJson(nodePath.join(root, "packages/ui/package.json"), {
    name: "@acme/ui",
    scripts: { build: "tsc" },
  });
  const outside = tempDir("poseidon-scripts-outside-");
  writeJson(nodePath.join(outside, "package.json"), { scripts: { leak: "cat /etc/passwd" } });
  symlinkSync(outside, nodePath.join(root, "apps/linked"));
  return root;
};

const createdEvent = (
  threadId: ReturnType<typeof makeThreadId>,
  projectId: ProjectId,
  worktree: ThreadWorktree,
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
      worktree,
    },
  }) as OrchestrationEvent;

const stack = (root: string) =>
  Effect.gen(function* () {
    const sqlite = Layer.succeedContext(yield* Layer.build(sqliteTestLayer()));
    yield* runMigrations.pipe(Effect.provide(sqlite));
    const rmContext = yield* Layer.build(ReadModelStore.layer.pipe(Layer.provide(sqlite)));
    const readModels = Context.get(rmContext, ReadModelStore);
    const projectId = makeProjectId();
    const now = new Date().toISOString();
    yield* readModels.putProject({
      projectId,
      name: "acme",
      workspaceRoot: root,
      createdAt: now,
      updatedAt: now,
      removed: false,
    });
    const addWorktreeThread = (path: string) =>
      Effect.gen(function* () {
        const threadId = makeThreadId();
        const worktree = { path, branch: "poseidon/fix", baseBranch: "main" };
        yield* readModels.putThread(foldThread([createdEvent(threadId, projectId, worktree)])!);
        return threadId;
      });
    const services = yield* Layer.build(
      scriptDetectionLayer.pipe(Layer.provide(Layer.succeedContext(rmContext))),
    );
    return { projectId, addWorktreeThread, scripts: Context.get(services, ScriptDetection) };
  });

describe("ScriptDetection", () => {
  it.live("lists the root's scripts, then each workspace package's, never one outside", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { projectId, scripts } = yield* stack(makeMonorepo());
        const found = yield* scripts.detect({ projectId });
        expect(found.map((script) => [script.id, script.command])).toEqual([
          ["pkg::dev", "pnpm run dev"],
          ["pkg::check", "pnpm run check"],
          ["pkg:apps/web:dev", "cd 'apps/web' && pnpm run dev"],
          ["pkg:packages/ui:build", "cd 'packages/ui' && pnpm run build"],
        ]);
        expect(found[2]?.packageName).toBe("@acme/web");
      }),
    ),
  );

  it.live("reads a thread's worktree, and lists nothing where there is no package.json", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { projectId, addWorktreeThread, scripts } = yield* stack(tempDir("poseidon-empty-"));
        expect(yield* scripts.detect({ projectId })).toEqual([]);
        const worktree = tempDir("poseidon-scripts-wt-");
        writeJson(nodePath.join(worktree, "package.json"), { scripts: { test: "vitest" } });
        writeFileSync(nodePath.join(worktree, "yarn.lock"), "");
        const threadId = yield* addWorktreeThread(worktree);
        const found = yield* scripts.detect({ projectId, threadId });
        expect(found.map((script) => script.command)).toEqual(["yarn run test"]);
      }),
    ),
  );

  it.live("refuses an unknown project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scripts } = yield* stack(tempDir("poseidon-empty-"));
        const error = yield* Effect.flip(scripts.detect({ projectId: makeProjectId() }));
        expect(error.code).toBe("not-found");
      }),
    ),
  );
});
