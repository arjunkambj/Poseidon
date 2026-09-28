/**
 * The thread writes a start nothing watches needs, as one-shot calls.
 *
 * `dispatchAtom` and `stageAttachmentAtom` (`./atoms`) are each a single
 * `runtime.fn`: a second call interrupts the first and hands its caller the
 * second's result (`./oneShot` explains why). That suits the composer, which
 * sends one thing at a time. A start that runs in the background, or several
 * threads started at once, cannot share them — with each other or with the
 * user's next send.
 *
 * - `dispatch` — `orchestration.dispatch`: sends a `Command` and resolves with
 *   its receipt. Meant for thread commands; it does not refetch the project
 *   list the way `dispatchAtom` does after `project.create` or
 *   `project.remove`.
 * - `stageAttachment` — `attachments.stage`: uploads one image for a thread
 *   and resolves with the reference its turn carries.
 *
 * Each call is `runOneShot` on the app's registry and resolves with its own
 * `Exit`, whether or not another call is in flight or the component that
 * started it is still mounted.
 */

import type { ThreadId } from "@poseidon/contracts/ids";
import type { Command } from "@poseidon/contracts/orchestration";
import * as Effect from "effect/Effect";
import type * as Atom from "effect/unstable/reactivity/Atom";
import type * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";

import { Connection, type ConnectionStateRef } from "./connection";
import { runOneShot } from "./oneShot";

export interface StageAttachment {
  readonly threadId: ThreadId;
  readonly name: string;
  readonly base64: string;
}

export const makeOneShotCommands = (runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>) => {
  const client = Effect.flatMap(Connection, (connection) => connection.client);

  const dispatch = (registry: AtomRegistry.AtomRegistry, command: Command) =>
    runOneShot(runtime, registry, () =>
      Effect.flatMap(client, (c) => c["orchestration.dispatch"]({ command })),
    );

  const stageAttachment = (registry: AtomRegistry.AtomRegistry, input: StageAttachment) =>
    runOneShot(runtime, registry, () =>
      Effect.flatMap(client, (c) =>
        c["attachments.stage"]({
          threadId: input.threadId,
          name: input.name,
          base64: input.base64,
        }),
      ),
    );

  return { dispatch, stageAttachment };
};

export type OneShotCommands = ReturnType<typeof makeOneShotCommands>;
