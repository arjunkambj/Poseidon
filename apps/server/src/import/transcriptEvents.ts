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
 *
 * Each row is stamped with when its message was said, so the thread's last
 * update, which the sidebar sorts and labels by, is the session's own last
 * message rather than the moment of the import. A message the harness wrote
 * no time for takes the one before it, and the first takes the session's
 * start.
 */

import type { ImportedMessage } from "@poseidon/connector-sdk/extensions";
import type { EventId, ItemId, ThreadId, TurnId } from "@poseidon/contracts/ids";
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

/** A harness's time as the event log spells one, or undefined when it is not a time. */
const isoOf = (at: string | undefined): string | undefined => {
  const ms = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

/**
 * One `thread.item.upserted` per message, oldest first, grouped into turns;
 * `startedAt` is the session's start, for messages that carry no time.
 */
export const transcriptEvents = (
  threadId: ThreadId,
  messages: ReadonlyArray<ImportedMessage>,
  startedAt: string,
  env: Env,
): ReadonlyArray<PlannedEvent> => {
  let turnId: TurnId | null = null;
  let occurredAt = isoOf(startedAt) ?? env.now();
  return messages.map((message): PlannedEvent => {
    if (message.role === "user" || turnId === null) {
      turnId = env.nextTurnId();
    }
    occurredAt = isoOf(message.timestamp) ?? occurredAt;
    const itemId = env.nextItemId();
    const item: ItemSnapshot =
      message.role === "user"
        ? userMessageItem(itemId, turnId, { text: message.text, attachments: [] })
        : { itemId, kind: "assistant_message", status: "completed", turnId, text: message.text };
    return {
      eventId: env.nextEventId(),
      streamKind: "thread",
      streamId: threadId,
      occurredAt,
      actor: "system",
      type: "thread.item.upserted",
      payload: { item, turnId },
    };
  });
};
