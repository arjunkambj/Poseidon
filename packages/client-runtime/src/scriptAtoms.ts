/**
 * The detected-scripts half of the client runtime: the package.json scripts
 * the server finds in a workspace, for the Run menu to list beside the
 * project's saved ones.
 *
 * `detectedScriptsAtom(scope)` is `scripts.detect` for one project, or one
 * thread's own root. It is a **stream driven by the connection's status**,
 * like the editor list, so it asks once per connected epoch; offline it stays
 * `Initial`. Unlike the editor list it is **not kept alive** and nothing
 * preloads it: only the open Run menu reads it, so detection runs when the
 * menu opens and the answer is dropped when it closes — the next open sees a
 * package.json edited in between. A failed call is the empty list: the menu
 * then offers only the saved scripts.
 */

import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { DetectedScript } from "@poseidon/contracts/scripts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Atom from "effect/unstable/reactivity/Atom";

import { Connection, ConnectionStateRef } from "./connection";

/** Which root to detect in: the thread's when `threadId` is set, the project's otherwise. */
export interface ScriptScope {
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId | undefined;
}

/** `Atom.family` keys have to be primitives; a test pins the round trip. */
export const encodeScriptScope = (scope: ScriptScope): string =>
  JSON.stringify([scope.projectId, scope.threadId ?? null]);

export const decodeScriptScope = (key: string): ScriptScope => {
  const [projectId, threadId] = JSON.parse(key) as [ProjectId, ThreadId | null];
  return { projectId, ...(threadId === null ? {} : { threadId }) };
};

const noScripts: ReadonlyArray<DetectedScript> = [];

export const makeScriptAtoms = (runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>) => {
  const client = Effect.flatMap(Connection, (connection) => connection.client);

  /** One tick per connected epoch: mount, and every reconnect after that. */
  const connectedEpochs = Effect.gen(function* () {
    const state = yield* ConnectionStateRef;
    return SubscriptionRef.changes(state).pipe(
      Stream.map((connection) => connection.status),
      Stream.changes,
      Stream.filter((status) => status === "connected"),
    );
  }).pipe(Stream.unwrap);

  const detectedScriptsByKeyAtom = Atom.family((key: string) => {
    const scope = decodeScriptScope(key);
    return runtime.atom(
      connectedEpochs.pipe(
        Stream.mapEffect(() =>
          Effect.flatMap(client, (c) =>
            c["scripts.detect"]({
              projectId: scope.projectId,
              ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
            }),
          ).pipe(Effect.catch(() => Effect.succeed(noScripts))),
        ),
      ),
    );
  });

  const detectedScriptsAtom = (scope: ScriptScope) =>
    detectedScriptsByKeyAtom(encodeScriptScope(scope));

  return { detectedScriptsAtom };
};

export type ScriptAtoms = ReturnType<typeof makeScriptAtoms>;
