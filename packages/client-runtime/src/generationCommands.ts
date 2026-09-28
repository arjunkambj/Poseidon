/**
 * The generated-text calls the commit and pull request dialogs, the combined
 * "Commit, push & create PR" run and the thread menus make.
 *
 * - `generateCommitMessage` — `git.generateCommitMessage`: a subject and body
 *   written from the diff of `paths` (every change when absent) in the
 *   thread's workspace, or the project's own folder without a thread.
 * - `generatePullRequest` — `git.generatePullRequest`: a title and body
 *   written from the branch's commits and its diff against the base the
 *   server picks (the thread's worktree base, else the default branch).
 * - `regenerateTitle` — `thread.regenerateTitle`: a new title written from the
 *   end of the conversation. The server applies it with `thread.rename`
 *   before it answers, so the thread list follows on its own.
 *
 * Each call is a one-shot (`./oneShot`) on the app's registry, so a second
 * generation never cuts a first one short. Each takes a `signal`: aborting it
 * interrupts the call, which Effect RPC forwards to the server, and the server
 * stops the harness process writing the text. Every call fails with code
 * `unavailable` when no harness can write text; the answer's optional
 * `notice` says the chosen Writing model was passed over.
 */

import type { ThreadId } from "@poseidon/contracts/ids";
import * as Effect from "effect/Effect";
import type * as Atom from "effect/unstable/reactivity/Atom";
import type * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";

import { Connection, type ConnectionStateRef } from "./connection";
import type { GitScope } from "./gitAtoms";
import { runOneShot } from "./oneShot";

/** A commit message for the ticked `paths`; absent means every change. */
export interface GenerateCommitMessage extends GitScope {
  readonly paths?: ReadonlyArray<string> | undefined;
}

/** A regenerated title for one thread. */
export interface RegenerateTitle {
  readonly threadId: ThreadId;
}

/** Lets a caller stop the call: aborting interrupts it on the server too. */
export interface GenerationCallOptions {
  readonly signal?: AbortSignal;
}

/** The scope half of a payload, without an absent `threadId` on the wire. */
const scopePayload = (scope: GitScope) => ({
  projectId: scope.projectId,
  ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
});

export const makeGenerationCommands = (
  runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>,
) => {
  const client = Effect.flatMap(Connection, (connection) => connection.client);

  const generateCommitMessage = (
    registry: AtomRegistry.AtomRegistry,
    input: GenerateCommitMessage,
    options?: GenerationCallOptions,
  ) =>
    runOneShot(
      runtime,
      registry,
      () =>
        Effect.flatMap(client, (c) =>
          c["git.generateCommitMessage"]({
            ...scopePayload(input),
            ...(input.paths === undefined ? {} : { paths: input.paths }),
          }),
        ),
      options,
    );

  const generatePullRequest = (
    registry: AtomRegistry.AtomRegistry,
    input: GitScope,
    options?: GenerationCallOptions,
  ) =>
    runOneShot(
      runtime,
      registry,
      () => Effect.flatMap(client, (c) => c["git.generatePullRequest"](scopePayload(input))),
      options,
    );

  const regenerateTitle = (
    registry: AtomRegistry.AtomRegistry,
    input: RegenerateTitle,
    options?: GenerationCallOptions,
  ) =>
    runOneShot(
      runtime,
      registry,
      () =>
        Effect.flatMap(client, (c) => c["thread.regenerateTitle"]({ threadId: input.threadId })),
      options,
    );

  return { generateCommitMessage, generatePullRequest, regenerateTitle };
};

export type GenerationCommands = ReturnType<typeof makeGenerationCommands>;
