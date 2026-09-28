/**
 * `files.create` writes a new `.md` file inside the workspace root and
 * nothing else: never over an existing file, never outside the root —
 * lexically or through a linked folder — and never another extension. Real
 * directories in tmp; the last case goes through the real read models and
 * file service to check the write lands in the project's root.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { makeProjectId } from "@poseidon/contracts/ids";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { runMigrations } from "../persistence/Migrations";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { FileService } from "../rpc/services";
import { createWorkspaceFile } from "./create";
import { layer as fileLayer } from "./Files";

const tempDir = (prefix: string) => realpathSync(mkdtempSync(nodePath.join(tmpdir(), prefix)));

/** The refusal `createWorkspaceFile` rejected with, as `code: message`. */
const refusal = async (root: string, path: string): Promise<string> => {
  try {
    await createWorkspaceFile(root, path, "# no\n");
  } catch (error) {
    if (error instanceof PoseidonRpcError) return `${error.code}: ${error.message}`;
    throw error;
  }
  throw new Error(`${path} was written`);
};

describe("createWorkspaceFile", () => {
  it("writes a new file, making the folders on its way", async () => {
    const root = tempDir("poseidon-create-");
    const written = await createWorkspaceFile(root, "docs/plans/dark-mode.md", "# Dark mode\n");
    expect(written).toEqual({ path: "docs/plans/dark-mode.md" });
    expect(readFileSync(nodePath.join(root, "docs", "plans", "dark-mode.md"), "utf8")).toBe(
      "# Dark mode\n",
    );
  });

  it("answers a normalized path", async () => {
    const root = tempDir("poseidon-create-");
    expect(await createWorkspaceFile(root, "./notes/../plan.MD", "x")).toEqual({
      path: "plan.MD",
    });
  });

  it("refuses an existing file and leaves it as it was", async () => {
    const root = tempDir("poseidon-create-");
    writeFileSync(nodePath.join(root, "plan.md"), "mine\n");
    expect(await refusal(root, "plan.md")).toBe("conflict: plan.md already exists");
    expect(readFileSync(nodePath.join(root, "plan.md"), "utf8")).toBe("mine\n");
  });

  it("refuses a symlink at the name, even one that leads nowhere", async () => {
    const root = tempDir("poseidon-create-");
    const outside = tempDir("poseidon-create-outside-");
    symlinkSync(nodePath.join(outside, "target.md"), nodePath.join(root, "plan.md"));
    expect(await refusal(root, "plan.md")).toBe("conflict: plan.md already exists");
    expect(existsSync(nodePath.join(outside, "target.md"))).toBe(false);
  });

  it("refuses a path that climbs out of the root", async () => {
    const root = tempDir("poseidon-create-");
    expect(await refusal(root, "../plan.md")).toBe(
      "invalid: path escapes the workspace: ../plan.md",
    );
    expect(await refusal(root, "docs/../../plan.md")).toMatch(/^invalid: path escapes/);
    expect(existsSync(nodePath.join(nodePath.dirname(root), "plan.md"))).toBe(false);
  });

  it("refuses an absolute path, even one inside the root", async () => {
    const root = tempDir("poseidon-create-");
    const inside = nodePath.join(root, "plan.md");
    expect(await refusal(root, inside)).toBe(
      `invalid: the path must be relative to the workspace: ${inside}`,
    );
    expect(existsSync(inside)).toBe(false);
  });

  it("refuses any extension but .md", async () => {
    const root = tempDir("poseidon-create-");
    expect(await refusal(root, "plan.txt")).toBe(
      "invalid: only .md files can be created: plan.txt",
    );
    expect(await refusal(root, "script.md.sh")).toMatch(/^invalid: only \.md/);
    expect(await refusal(root, "README")).toMatch(/^invalid: only \.md/);
    expect(existsSync(nodePath.join(root, "plan.txt"))).toBe(false);
  });

  it("refuses to write through a linked folder that leads outside", async () => {
    const root = tempDir("poseidon-create-");
    const outside = tempDir("poseidon-create-outside-");
    symlinkSync(outside, nodePath.join(root, "linked"));
    expect(await refusal(root, "linked/plan.md")).toMatch(/^invalid: path escapes/);
    expect(await refusal(root, "linked/deeper/plan.md")).toMatch(/^invalid: path escapes/);
    expect(existsSync(nodePath.join(outside, "plan.md"))).toBe(false);
    expect(existsSync(nodePath.join(outside, "deeper"))).toBe(false);
  });

  it("writes through a linked folder that stays inside", async () => {
    const root = tempDir("poseidon-create-");
    mkdirSync(nodePath.join(root, "docs"));
    symlinkSync(nodePath.join(root, "docs"), nodePath.join(root, "d"));
    expect(await createWorkspaceFile(root, "d/plan.md", "x")).toEqual({ path: "d/plan.md" });
    expect(readFileSync(nodePath.join(root, "docs", "plan.md"), "utf8")).toBe("x");
  });
});

describe("files.create", () => {
  it.live("writes into the project's root, and refuses the same path again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = tempDir("poseidon-create-rpc-");
        const sqlite = Layer.succeedContext(yield* Layer.build(sqliteTestLayer()));
        yield* runMigrations.pipe(Effect.provide(sqlite));
        const rmContext = yield* Layer.build(ReadModelStore.layer.pipe(Layer.provide(sqlite)));
        const readModels = Context.get(rmContext, ReadModelStore);
        const projectId = makeProjectId();
        const now = new Date().toISOString();
        yield* readModels.putProject({
          projectId,
          name: "test",
          workspaceRoot: root,
          createdAt: now,
          updatedAt: now,
          removed: false,
        });
        const services = yield* Layer.build(
          fileLayer.pipe(Layer.provide(Layer.succeedContext(rmContext))),
        );
        const files = Context.get(services, FileService);

        const written = yield* files.create({ projectId }, "plan.md", "# Plan\n");
        expect(written).toEqual({ path: "plan.md" });
        expect(readFileSync(nodePath.join(root, "plan.md"), "utf8")).toBe("# Plan\n");

        const again = yield* Effect.exit(files.create({ projectId }, "plan.md", "other"));
        expect(Exit.isFailure(again)).toBe(true);
        expect(JSON.stringify(again)).toContain("already exists");
        expect(readFileSync(nodePath.join(root, "plan.md"), "utf8")).toBe("# Plan\n");

        const unknown = yield* Effect.exit(
          files.create({ projectId: makeProjectId() }, "a.md", ""),
        );
        expect(Exit.isFailure(unknown)).toBe(true);
      }),
    ),
  );
});
