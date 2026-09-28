/**
 * One piece of text written by Command Code outside any session: a commit
 * message, a pull request's title and body, a thread title.
 *
 * It is one print-mode process, `buildArgs` with the one-shot flags:
 *
 *     cmd -p "<prompt>" --output-format json --verbose -t --skip-onboarding
 *         --no-auto-update --no-session --model <id> [--effort <level>] --max-turns 1
 *
 * - `--no-session` keeps nothing on disk, and `--max-turns 1` stops the run
 *   after one answer.
 * - No `--yolo`: without it print mode refuses every write and shell call on
 *   its own (`fixtures/cmd/shell-allow/`), so the call is read-only whatever
 *   the model tries. No `--tools-enable`, no hook, no MCP config, no skills.
 * - It runs in a directory of its own under the system temp directory, made
 *   for the call and removed after it, so there is no project for it to read.
 * - Print mode has no system-prompt flag, so `system` goes in front of the
 *   prompt. It has no schema flag either: `jsonSchema` is not sent, and the
 *   caller parses the text.
 *
 * `--no-session` writes no transcript, but the CLI still leaves
 * `<id>.checkpoints.jsonl` and `<id>.meta.json` in a project directory named
 * after the temp directory (`projectDirListing` in the recording's manifest).
 * One of those per generated title would pile up in the user's
 * `~/.commandcode/projects`, so they are removed by the session id the run
 * reported, and the directory with them once it is empty.
 *
 * The answer is `finalText` on the `result` line. A process that exits
 * non-zero, a stream with no `result` line, and a `result` that is not a
 * success all fail with `GenerationFailed`, carrying the CLI's own error or
 * the tail of its stderr. `fixtures/cmd/generate-text/` is the recording of
 * exactly this argv.
 */

import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import {
  GenerationFailed,
  SpawnFailed,
  type ConnectorError,
  type GenerateTextInput,
} from "@poseidon/connector-sdk/definition";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ResolvedBinary } from "./binary";
import { EXIT_MESSAGES } from "./exitCodes";
import { makeLineSplitter, parseFrame, type CmdResultFrame } from "./ndjson";
import { buildArgs, envAllowlist, spawnProcess } from "./spawn";
import { projectsRootFor } from "./transcript";
import { cmdEffort } from "./turnArgs";

const KIND = "cmd";

/** How much of stderr a failure carries, from the end. */
const STDERR_TAIL_CHARS = 600;

/** The prompt the CLI gets: the instruction first, then the request. */
const promptOf = (input: GenerateTextInput): string =>
  input.system === undefined || input.system.trim() === ""
    ? input.prompt
    : `${input.system}\n\n${input.prompt}`;

/** The one-shot argv, in `buildArgs`'s order. */
export const generateTextArgs = (input: GenerateTextInput): Array<string> =>
  buildArgs({
    prompt: promptOf(input),
    noSession: true,
    model: input.model,
    ...(input.effort === undefined ? {} : { effort: cmdEffort(input.effort) }),
    maxTurns: 1,
  });

/** The last `result` line of a finished stdout, or null when there is none. */
const resultOf = (stdout: string): CmdResultFrame | null => {
  const splitter = makeLineSplitter();
  const { lines } = splitter.push(stdout);
  const tail = splitter.flush();
  let result: CmdResultFrame | null = null;
  for (const line of tail === null ? lines : [...lines, tail]) {
    const frame = parseFrame(line);
    if ("type" in frame && frame.type === "result") result = frame;
  }
  return result;
};

const tailOf = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= STDERR_TAIL_CHARS ? trimmed : `…${trimmed.slice(-STDERR_TAIL_CHARS)}`;
};

/** The answer's text, or why there is none. */
export const answerOf = (run: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}): { readonly text: string } | { readonly failure: string } => {
  const result = resultOf(run.stdout);
  const stderr = tailOf(run.stderr);
  const said = result?.error ?? (stderr === "" ? undefined : stderr);
  if (run.exitCode !== 0) {
    const meaning = EXIT_MESSAGES[run.exitCode]?.message ?? `cmd exited ${run.exitCode}`;
    return { failure: said === undefined ? meaning : `${meaning}: ${said}` };
  }
  if (result === null) {
    return { failure: `cmd gave no result line${stderr === "" ? "" : `: ${stderr}`}` };
  }
  if (result.subtype !== undefined && result.subtype !== "success") {
    return { failure: `cmd ended with ${result.subtype}${said === undefined ? "" : `: ${said}`}` };
  }
  const text = result.finalText ?? "";
  return text.trim() === "" ? { failure: "cmd answered with no text" } : { text };
};

/** The session id the run reported: its `result` line, else the stderr banner. */
const sessionIdOf = (stdout: string, stderr: string): string | null =>
  resultOf(stdout)?.sessionId ?? /session:\s*([0-9a-f-]{36})/i.exec(stderr)?.[1] ?? null;

/**
 * Removes the files a `--no-session` run left under `~/.commandcode/projects`:
 * only those named after its own session id, and their directory once nothing
 * else is in it.
 */
export const removeLeftovers = async (home: string, sessionId: string): Promise<void> => {
  const root = projectsRootFor(home);
  const dirs = await NodeFS.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const path = NodePath.join(root, dir.name);
    const names = await NodeFS.readdir(path).catch((): Array<string> => []);
    const ours = names.filter((name) => name.startsWith(`${sessionId}.`));
    if (ours.length === 0) continue;
    await Promise.all(ours.map((name) => NodeFS.rm(NodePath.join(path, name), { force: true })));
    if (ours.length === names.length) await NodeFS.rmdir(path).catch(() => undefined);
  }
};

export interface CmdGenerateTextOptions {
  readonly instanceId: ConnectorInstanceId;
  /** Resolved per call, so an install that appears later is found. */
  readonly binary: () => ResolvedBinary;
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/** The instance's `generateText`. */
export const makeCmdGenerateText =
  (options: CmdGenerateTextOptions) =>
  (input: GenerateTextInput): Effect.Effect<string, ConnectorError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const fail = (message: string) =>
          new GenerationFailed({ kind: KIND, instanceId: options.instanceId, message });
        const spawnFailed = (cause: unknown) =>
          new SpawnFailed({
            kind: KIND,
            instanceId: options.instanceId,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        // Made before the process and removed after it: the scope's finalizers
        // run in reverse, so the process group is gone before the directory is.
        const cwd = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "poseidon-generate-")),
            catch: spawnFailed,
          }),
          (dir) => Effect.promise(() => NodeFS.rm(dir, { recursive: true, force: true })),
        );
        const binary = options.binary();
        const proc = yield* spawnProcess({
          binaryPath: binary.command,
          args: [...binary.prefixArgs, ...generateTextArgs(input)],
          cwd,
          env: envAllowlist(process.env, { ...options.extraEnv }),
        }).pipe(Effect.mapError(spawnFailed));
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [Stream.runCollect(proc.stdout), Stream.runCollect(proc.stderr), proc.exitCode],
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError((error) => fail(error.message)));
        const run = { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
        const sessionId = sessionIdOf(run.stdout, run.stderr);
        if (sessionId !== null) {
          const home = options.extraEnv?.HOME ?? NodeOS.homedir();
          // Tidying is best-effort: it never costs the caller the answer.
          yield* Effect.promise(() => removeLeftovers(home, sessionId).catch(() => undefined));
        }
        const answer = answerOf(run);
        return "text" in answer ? answer.text : yield* fail(answer.failure);
      }),
    );
