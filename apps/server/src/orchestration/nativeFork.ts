/**
 * Forking in the harness itself, when it can.
 *
 * A fork is a transcript copy by default (`forkSeed.ts`): harness-neutral,
 * and correct from any point in the source. A harness whose capabilities say
 * `fork` can do better from one place only — the source's tail. Its own fork
 * copies the conversation into a new session and leaves the source's alone,
 * so the model gets the real history (tool calls included) rather than a text
 * summary of it. From anywhere earlier the harness would copy turns the fork
 * is meant to leave out, so those forks stay copies.
 *
 * The decider picks (`nativeForkSession`), `thread.created` records the
 * source's session on the fork, and the session manager resumes it with
 * `fork: true` on the fork's first turn (`pendingNativeFork`). The harness
 * copies the session as it stands then, not as it stood when the fork was
 * made, so the manager forks only while the source has not moved on since
 * (`sourceStillAt`). The transcript is still recorded: if the harness cannot
 * fork after all, or the source has run another turn, the manager starts a
 * fresh session and the transcript goes ahead of the first message as for any
 * other fork.
 */

import type { ThreadWorktree } from "@poseidon/contracts/git";
import type { ForkSession, ThreadFork } from "@poseidon/contracts/orchestration";
import { latestTurnId } from "@poseidon/contracts/orchestration";
import type { ConnectorInstanceId, ItemId, TurnId } from "@poseidon/contracts/ids";

import type { ThreadDoc } from "./state";

/** The thread's fork, tolerating a document written before forks existed. */
export const forkOf = (doc: ThreadDoc): ThreadFork | null =>
  (doc.fork as ThreadFork | null | undefined) ?? null;

/**
 * Whether `turnId` is the fork's first turn: no user message of another turn
 * exists. A resend of the same turn after a lost session still counts.
 */
export const isFirstTurn = (doc: ThreadDoc, turnId: TurnId | undefined): boolean =>
  !doc.items.some(
    (item) => item.kind === "user_message" && item.turnId !== undefined && item.turnId !== turnId,
  );

/**
 * The source session a new fork should continue natively, or `undefined` for
 * a transcript copy. All of these have to hold:
 *
 * - the source has a bound session whose harness declared `fork`;
 * - nothing is running in the source, so its tail is settled;
 * - the fork point is that tail: the whole thread, or a message of the
 *   source's latest turn;
 * - the fork stays on the source's connector instance — the session belongs
 *   to it — and in the source's workspace, where the harness keeps it.
 */
export const nativeForkSession = (input: {
  readonly source: ThreadDoc;
  readonly throughItemId: ItemId | undefined;
  readonly connectorInstanceId: ConnectorInstanceId | undefined;
  readonly worktree: ThreadWorktree | undefined;
}): ForkSession | undefined => {
  const { source } = input;
  const session = source.session;
  if (session === null || session.capabilities?.fork !== true || source.currentTurn !== null) {
    return undefined;
  }
  if (input.throughItemId !== undefined) {
    const turnId = source.items.find((item) => item.itemId === input.throughItemId)?.turnId;
    if (turnId === undefined || turnId !== latestTurnId(source.items)) {
      return undefined;
    }
  }
  if (input.connectorInstanceId !== session.connectorInstanceId) {
    return undefined;
  }
  // Read as `worktreeOf` does; importing it from the fold would be a cycle.
  const sourceWorktree = (source.worktree as ThreadWorktree | null | undefined) ?? null;
  if ((input.worktree?.path ?? null) !== (sourceWorktree?.path ?? null)) {
    return undefined;
  }
  const afterTurnId = latestTurnId(source.items);
  return {
    connectorInstanceId: session.connectorInstanceId,
    sessionRef: session.sessionRef,
    ...(afterTurnId === null ? {} : { afterTurnId }),
  };
};

/**
 * Whether the source is still where `recorded` found it: idle, on the same
 * session, and with no turn after the one it had then. A source that ran
 * another turn since has a longer session, and a harness fork now would copy
 * turns the fork was made without.
 */
export const sourceStillAt = (recorded: ForkSession, source: ThreadDoc | null): boolean => {
  if (source === null || source.deleted || source.currentTurn !== null) {
    return false;
  }
  const session = source.session;
  return (
    session !== null &&
    session.connectorInstanceId === recorded.connectorInstanceId &&
    JSON.stringify(session.sessionRef) === JSON.stringify(recorded.sessionRef) &&
    (recorded.afterTurnId === undefined || latestTurnId(source.items) === recorded.afterTurnId)
  );
};

/**
 * The source session to fork when this thread's session starts, or `null`.
 * Only a fork that recorded one, has no session of its own yet, and is on its
 * first turn: a fork that has since run turns of its own and lost its
 * session would lose them by forking the source again. The caller still
 * checks the source has not moved on (`sourceStillAt`).
 */
export const pendingNativeFork = (doc: ThreadDoc): ForkSession | null => {
  const session = forkOf(doc)?.session;
  if (session === undefined || doc.session !== null) {
    return null;
  }
  return isFirstTurn(doc, doc.currentTurn?.turnId) ? session : null;
};
