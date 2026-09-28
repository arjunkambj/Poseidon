/**
 * An imported transcript as the events that make it a thread's timeline.
 *
 * Every message becomes one completed `thread.item.upserted` row, written by
 * the system rather than a connector: the harness said these things before
 * Poseidon ever saw the session. Each user message opens a new turn and the
 * assistant replies after it share that turn, so the timeline groups the
 * history the way it groups a conversation held here. A reply with no user
 * message before it (a transcript whose head was cut by the reader's caps)
 * gets a turn of its own.
 */

import type { ImportedMessage } from "@poseidon/connector-sdk/extensions";
import type {
  ConnectorInstanceId,
  EventId,
  ItemId,
  ThreadId,
  TurnId,
} from "@poseidon/contracts/ids";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";

import type { PlannedEvent } from "../persistence/EventStore";
import { userMessageItem } from "../orchestration/userMessageItem";

/** Where ids and the clock come from: the engine's own `EngineEnv`. */
interface Env {
  readonly now: () => string;
  readonly nextEventId: () => EventId;
  readonly nextTurnId: () => TurnId;
  readonly nextItemId: () => ItemId;
}

const envelope = (threadId: ThreadId, env: Env) => ({
  eventId: env.nextEventId(),
  streamKind: "thread" as const,
  streamId: threadId,
  occurredAt: env.now(),
  actor: "system" as const,
});

/** One `thread.item.upserted` per message, oldest first, grouped into turns. */
export const transcriptEvents = (
  threadId: ThreadId,
  messages: ReadonlyArray<ImportedMessage>,
  env: Env,
): ReadonlyArray<PlannedEvent> => {
  let turnId: TurnId | null = null;
  return messages.map((message): PlannedEvent => {
    if (message.role === "user" || turnId === null) {
      turnId = env.nextTurnId();
    }
    const itemId = env.nextItemId();
    const item: ItemSnapshot =
      message.role === "user"
        ? userMessageItem(itemId, turnId, { text: message.text, attachments: [] })
        : { itemId, kind: "assistant_message", status: "completed", turnId, text: message.text };
    return {
      ...envelope(threadId, env),
      type: "thread.item.upserted",
      payload: { item, turnId },
    };
  });
};

/**
 * Binds the thread to the harness's own session, so its first turn resumes
 * that conversation instead of starting one. No capabilities ride along: the
 * connector announces them when the session actually starts.
 */
export const sessionBoundEvent = (
  threadId: ThreadId,
  session: {
    readonly connectorInstanceId: ConnectorInstanceId;
    readonly connectorKind: string;
    readonly sessionRef: unknown;
  },
  env: Env,
): PlannedEvent => ({
  ...envelope(threadId, env),
  type: "thread.session.bound",
  payload: session,
});
