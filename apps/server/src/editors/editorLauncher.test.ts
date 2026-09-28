/**
 * The launcher's refusals over the real read models: an unknown project, a
 * path out of the root and a missing one all fail before anything is
 * started, whatever this machine has installed. Nothing here launches an app.
 */
import { describe, expect, it } from "@effect/vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { makeProjectId } from "@poseidon/contracts/ids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runMigrations } from "../persistence/Migrations";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { EditorLauncher } from "../rpc/services";
import { launchEnv, layer as editorLauncherLayer } from "./EditorLauncher";

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
      name: "test",
      workspaceRoot: root,
      createdAt: now,
      updatedAt: now,
      removed: false,
    });
    const services = yield* Layer.build(
      editorLauncherLayer.pipe(Layer.provide(Layer.succeedContext(rmContext))),
    );
    return { projectId, editors: Context.get(services, EditorLauncher) };
  });

const codeOf = <A, E extends { readonly code: string }>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.code),
  );

describe("EditorLauncher", () => {
  it.live("refuses an unknown project, a path out of the root and a missing path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "poseidon-launch-")));
        const { projectId, editors } = yield* stack(root);
        expect(
          yield* codeOf(editors.open({ projectId: makeProjectId() }, { editor: "finder" })),
        ).toBe("not-found");
        expect(yield* codeOf(editors.open({ projectId }, { editor: "finder", path: "../x" }))).toBe(
          "invalid",
        );
        expect(yield* codeOf(editors.open({ projectId }, { editor: "finder", path: "/etc" }))).toBe(
          "invalid",
        );
        expect(yield* codeOf(editors.open({ projectId }, { editor: "finder", path: "nope" }))).toBe(
          "not-found",
        );
      }),
    ),
  );

  it.live("lists what detection finds, without failing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "poseidon-launch-")));
        const { editors } = yield* stack(root);
        const found = yield* editors.list;
        if (process.platform === "darwin") {
          expect(found.map((editor) => editor.id).slice(-2)).toEqual(["finder", "terminal"]);
        }
      }),
    ),
  );
});

describe("launchEnv", () => {
  it("drops ELECTRON_RUN_AS_NODE and keeps everything else", () => {
    expect(launchEnv({ PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1", HOME: "/h" })).toEqual({
      PATH: "/usr/bin",
      HOME: "/h",
    });
  });
});
