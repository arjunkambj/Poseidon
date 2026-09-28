/**
 * `editors.list` and `editors.open` behind the `EditorLauncher` Tag.
 *
 * Detection is a handful of `existsSync` calls, cheap enough to run on every
 * call, so an app installed while Poseidon is open shows up without a restart.
 * A launch is a detached child in argv form, never a shell: the command comes
 * from the detected recipe, the one argument a caller shapes is the target,
 * and that is an absolute path already held inside the workspace root. The
 * child is not waited on — an editor outlives the call, and the server.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as NodeOS from "node:os";
import * as nodePath from "node:path";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveWorkspaceRoot } from "../orchestration/workspaceRoot";
import { ReadModelStore } from "../persistence/ReadModels";
import { EditorLauncher } from "../rpc/services";
import { detectEditors, editorLabel, toDetectedEditor } from "./detect";
import { buildLaunch, type Launch } from "./launch";
import { resolveTarget } from "./target";

const detect = () =>
  detectEditors({
    platform: process.platform,
    home: NodeOS.homedir(),
    pathDirs: (process.env.PATH ?? "").split(nodePath.delimiter),
    exists: existsSync,
  });

/**
 * The server's environment minus `ELECTRON_RUN_AS_NODE`: the packaged server
 * runs under it, and an Electron editor started from its CLI with it set
 * comes up as a bare node process instead of the app.
 */
export const launchEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const { ELECTRON_RUN_AS_NODE: _, ...rest } = env;
  return rest;
};

const failure = (code: PoseidonRpcError["code"], message: string) =>
  new PoseidonRpcError({ code, message });

/** Starts `launch` detached and succeeds once the process exists. */
const start = (launch: Launch, label: string) =>
  Effect.callback<void, PoseidonRpcError>((resume) => {
    const child = spawn(launch.command, [...launch.args], {
      shell: false,
      detached: true,
      stdio: "ignore",
      env: launchEnv(process.env),
      windowsVerbatimArguments: launch.verbatim === true,
    });
    child.once("spawn", () => {
      child.unref();
      resume(Effect.void);
    });
    child.once("error", () =>
      resume(Effect.fail(failure("unavailable", `${label} did not start`))),
    );
  });

/**
 * Opens a folder the server owns (not one inside a workspace) in the
 * platform's file manager, through the same detected recipe and detached
 * launch as `editors.open`. `folder` must be absolute.
 */
export const openInFileManager = (folder: string) =>
  Effect.gen(function* () {
    const recipe = detect().find((candidate) => candidate.kind === "file-manager");
    const launch =
      recipe === undefined
        ? null
        : buildLaunch({ platform: process.platform, recipe, target: folder, isDirectory: true });
    if (recipe === undefined || launch === null) {
      return yield* failure("unavailable", "no file manager is available");
    }
    yield* start(launch, recipe.label);
  });

export const layer = Layer.effect(
  EditorLauncher,
  Effect.gen(function* () {
    const readModels = yield* ReadModelStore;

    return EditorLauncher.of({
      list: Effect.sync(() => detect().map(toDetectedEditor)),
      open: (scope, request) =>
        Effect.gen(function* () {
          const root = yield* resolveWorkspaceRoot(
            readModels,
            scope.projectId,
            scope.threadId,
          ).pipe(Effect.mapError(() => failure("internal", "project lookup failed")));
          if (root === null) return yield* failure("not-found", "unknown project");
          const target = yield* Effect.promise(() => resolveTarget(root, request.path));
          if (!target.ok) {
            return yield* target.reason === "invalid"
              ? failure("invalid", "path is outside the workspace")
              : failure("not-found", "path does not exist");
          }
          const recipe = detect().find((candidate) => candidate.id === request.editor);
          if (recipe === undefined) {
            const label = editorLabel(request.editor, process.platform);
            return yield* failure("unavailable", `${label} is not installed`);
          }
          const launch = buildLaunch({
            platform: process.platform,
            recipe,
            target: target.path,
            isDirectory: target.isDirectory,
            line: request.line,
            reveal: request.reveal,
          });
          if (launch === null) {
            return yield* failure("unavailable", `${recipe.label} cannot be opened here`);
          }
          yield* start(launch, recipe.label);
        }),
    });
  }),
);
