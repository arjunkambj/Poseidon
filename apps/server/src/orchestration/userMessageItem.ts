/**
 * The user's own row on the timeline, built the same way wherever it is
 * written: the decider writes it with a turn it starts, the provider reactor
 * writes it once a steered message has actually reached the running turn.
 */

import type { ItemId, TurnId } from "@poseidon/contracts/ids";
import type { Attachment, TurnReference } from "@poseidon/contracts/orchestration";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";

/** What the user sent, as a turn or a steer carries it. */
export interface UserMessageInput {
  readonly text: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly references?: ReadonlyArray<TurnReference> | undefined;
}

/**
 * A completed `user_message` item. Attachments and references are left off
 * when there are none, so a plain message stores no empty lists.
 */
export const userMessageItem = (
  itemId: ItemId,
  turnId: TurnId,
  input: UserMessageInput,
): ItemSnapshot => ({
  itemId,
  kind: "user_message",
  status: "completed",
  turnId,
  text: input.text,
  ...(input.attachments.length === 0 ? {} : { attachments: input.attachments }),
  ...((input.references ?? []).length === 0 ? {} : { references: input.references }),
});
