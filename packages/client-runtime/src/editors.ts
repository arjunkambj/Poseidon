/**
 * The "Open in" half of the client runtime: which editors the server found,
 * and a way to open the workspace, or a path inside it, in one of them.
 *
 * - `editorsAtom` — `editors.list`: the editors, file manager and terminal
 *   installed on the server's machine, editors first. It is a **stream driven
 *   by the connection's status**, like the git and folder atoms, so it lists
 *   once per connected epoch — on mount, and again after a reconnect, which
 *   may be a different server. Offline it stays `Initial`. A failed call is
 *   the empty list rather than the atom's error: nothing to open in simply
 *   hides the header control and the "Open with" submenu, and the next
 *   reconnect lists again.
 * - `openIn` — `editors.open`: a one-shot call (`./oneShot`) on the app's
 *   registry, resolving with its own `Exit`. It fails with the server's
 *   refusal — a path outside the workspace, a file that is gone, an editor no
 *   longer installed — for the caller's toast to show. Two opens never share
 *   an atom, so a second click cannot cut the first launch short.
 *
 * The list is kept alive: every header and file menu reads the same answer,
 * and detection runs on the server once per connection, not once per menu.
 */

import type { DetectedEditor, EditorId } from "@poseidon/contracts/editors";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Atom from "effect/unstable/reactivity/Atom";
import type * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";

import { Connection, ConnectionStateRef } from "./connection";
import { runOneShot } from "./oneShot";

/**
 * What to open, and where. The root is the thread's own (its worktree) when
 * `threadId` is set and the project's otherwise; `path` is relative to it and
 * omitted for the root itself. `line` is honoured by an editor that supports
 * it, and `reveal` selects the path in the file manager instead of opening it.
 */
export interface OpenInInput {
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId | undefined;
  readonly editor: EditorId;
  readonly path?: string | undefined;
  readonly line?: number | undefined;
  readonly reveal?: boolean | undefined;
}

const noEditors: ReadonlyArray<DetectedEditor> = [];

export const makeEditorAtoms = (runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>) => {
  const client = Effect.flatMap(Connection, (connection) => connection.client);

  /** One tick per connected epoch: mount, and every reconnect after that. */
  const connectedEpochs = Effect.gen(function* () {
    const state = yield* ConnectionStateRef;
    return SubscriptionRef.changes(state).pipe(
      Stream.map((connection) => connection.status),
      // `markConnected` rewrites the same status with the server's boot id;
      // dedupe on the status alone so that is not a second listing.
      Stream.changes,
      Stream.filter((status) => status === "connected"),
    );
  }).pipe(Stream.unwrap);

  const editorsAtom = runtime
    .atom(
      connectedEpochs.pipe(
        Stream.mapEffect(() =>
          Effect.flatMap(client, (c) => c["editors.list"]({})).pipe(
            Effect.catch(() => Effect.succeed(noEditors)),
          ),
        ),
      ),
    )
    .pipe(Atom.keepAlive);

  /** Fails with `invalid`, `not-found` or `unavailable` — the server's refusal. */
  const openIn = (registry: AtomRegistry.AtomRegistry, input: OpenInInput) =>
    runOneShot(runtime, registry, () =>
      Effect.flatMap(client, (c) =>
        c["editors.open"]({
          projectId: input.projectId,
          editor: input.editor,
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.line === undefined ? {} : { line: input.line }),
          ...(input.reveal === undefined ? {} : { reveal: input.reveal }),
        }),
      ),
    );

  return { editorsAtom, openIn };
};

export type EditorAtoms = ReturnType<typeof makeEditorAtoms>;
