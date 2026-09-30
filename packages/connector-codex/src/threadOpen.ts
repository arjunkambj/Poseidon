/**
 * Opening the session's thread on a fresh app-server: `thread/start`,
 * `thread/resume` for a thread the CLI already has, or `thread/fork` for a
 * new thread that carries one of those on.
 *
 * All three name the working directory, the approval policy and the sandbox
 * the thread's modes call for (`modes.ts`), and the model unless the thread
 * runs on the CLI's default. A resume or a fork is asked for without the
 * thread's turns (`excludeTurns`): Poseidon has its own timeline, and the full
 * history is a payload the CLI itself calls deprecated.
 *
 * A resume the CLI refuses because it has no rollout for the id — the thread
 * was made under another `CODEX_HOME`, or its files were cleaned up — starts
 * a new thread instead, and says so with the warning the session passes on.
 * A fork never does: the CLI copies the source's rollout into a thread of its
 * own and leaves the source as it was (`fork`), and a fork it refuses fails
 * the start, so the server can start the thread its own way and carry the
 * conversation over as text. Any other refusal fails the start too.
 */

import type { Effort } from "@poseidon/contracts/enums";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import * as Effect from "effect/Effect";

import { call } from "./handshake";
import { codexModelFor, toEffort } from "./models";
import { APPROVAL_POLICY, sandboxModeFor } from "./modes";
import { ThreadOpenResponse } from "./protocol";
import type { RpcClient, RpcFailed } from "./rpc";

/** What the CLI says when `thread/resume` names a thread it has no rollout for. */
const NO_ROLLOUT = /no rollout found/i;

export const MISSING_THREAD_WARNING =
  "Codex no longer has this thread's conversation, so it starts a new one.";

export interface OpenedThread {
  readonly threadId: string;
  /** The model the CLI resolved the thread to. */
  readonly model: string;
  /** The effort the CLI resolved the thread to, when Poseidon names it. */
  readonly effort?: Effort;
  /** Why a resume became a fresh start, when it did. */
  readonly warning?: string;
}

const baseParams = (cwd: string, settings: ThreadSettings) => {
  const model = codexModelFor(settings.model);
  return {
    cwd,
    approvalPolicy: APPROVAL_POLICY,
    sandbox: sandboxModeFor(settings.runtimeMode),
    ...(model === undefined ? {} : { model }),
  };
};

/** What the CLI opened, from its answer to `thread/start`, `thread/resume` or `thread/fork`. */
export const openedFrom = (response: ThreadOpenResponse): OpenedThread => {
  const effort = toEffort(response.reasoningEffort);
  return {
    threadId: response.thread.id,
    model: response.model,
    ...(effort === undefined ? {} : { effort }),
  };
};

const start = (
  rpc: RpcClient,
  cwd: string,
  settings: ThreadSettings,
): Effect.Effect<OpenedThread, RpcFailed> =>
  call(rpc, "thread/start", baseParams(cwd, settings), ThreadOpenResponse).pipe(
    Effect.map(openedFrom),
  );

export const openThread = (input: {
  readonly rpc: RpcClient;
  readonly cwd: string;
  readonly settings: ThreadSettings;
  /** The CLI's thread to resume; absent for a fresh one. */
  readonly resume?: string;
  /** Fork `resume` into a new thread of the CLI's instead of carrying it on. */
  readonly fork?: boolean;
}): Effect.Effect<OpenedThread, RpcFailed> => {
  const { rpc, cwd, settings } = input;
  if (input.resume === undefined) return start(rpc, cwd, settings);
  if (input.fork === true) {
    return call(
      rpc,
      "thread/fork",
      { threadId: input.resume, excludeTurns: true, ...baseParams(cwd, settings) },
      ThreadOpenResponse,
    ).pipe(Effect.map(openedFrom));
  }
  return call(
    rpc,
    "thread/resume",
    { threadId: input.resume, excludeTurns: true, ...baseParams(cwd, settings) },
    ThreadOpenResponse,
  ).pipe(
    Effect.map(openedFrom),
    Effect.catchIf(
      (error) => NO_ROLLOUT.test(error.message),
      () =>
        start(rpc, cwd, settings).pipe(
          Effect.map((opened) => ({ ...opened, warning: MISSING_THREAD_WARNING })),
        ),
    ),
  );
};
