import { makeItemId, makeThreadId } from "@poseidon/contracts/ids";
import type { Command, CommandReceipt, QueuedMessage } from "@poseidon/contracts/orchestration";
import { describe, expect, it } from "vitest";

import { queueRowItems } from "@/components/composer/queue-row-menu";
import {
  canEditQueued,
  draftHasContent,
  editQueued,
  steerQueued,
  type QueueDispatch,
} from "@/components/composer/use-queue-actions";
import { emptyComposerDraft } from "@/state/ui";

const threadId = makeThreadId();

const message = (fields: Partial<QueuedMessage> = {}): QueuedMessage => ({
  queuedMessageId: makeItemId(),
  text: "and add a test",
  attachments: [],
  mentions: ["src/app.tsx"],
  references: [{ kind: "skill", name: "review" }],
  queuedAt: "2026-01-01T00:00:00.000Z",
  ...fields,
});

/**
 * A dispatch that records every command and answers from `answers`, keyed by
 * command type: a reason string rejects, "unreachable" throws, absent accepts.
 */
const recorder = (answers: Partial<Record<Command["type"], string>> = {}) => {
  const sent: Command[] = [];
  const dispatch: QueueDispatch = (command) => {
    sent.push(command);
    const answer = answers[command.type];
    if (answer === "unreachable") {
      return Promise.reject(new Error("socket closed"));
    }
    const receipt: CommandReceipt = {
      commandId: command.commandId,
      status: answer === undefined ? "accepted" : "rejected",
      ...(answer === undefined ? {} : { reason: answer }),
      lastSequence: 0,
    };
    return Promise.resolve(receipt);
  };
  return { sent, dispatch };
};

describe("queueRowItems", () => {
  it("offers Steer now only when the turn can be steered", () => {
    const actions = (steerable: boolean) =>
      queueRowItems(steerable, message()).map((item) => item.action);
    expect(actions(false)).toEqual(["edit", "remove"]);
    expect(actions(true)).toEqual(["steer", "edit", "remove"]);
  });

  it("disables Edit for a message with images, and says why", () => {
    const withImage = message({ attachments: [{ path: "shot.png", mime: "image/png" }] });
    expect(canEditQueued(withImage)).toBe(false);
    const edit = queueRowItems(true, withImage).find((item) => item.action === "edit");
    expect(edit).toEqual({ action: "edit", label: "Edit (has images)", disabled: true });
    expect(queueRowItems(true, message()).find((item) => item.action === "edit")?.disabled).toBe(
      false,
    );
  });
});

describe("steerQueued", () => {
  it("removes the message first, then steers it with every field", async () => {
    const { sent, dispatch } = recorder();
    const queued = message({ attachments: [{ path: "shot.png", mime: "image/png" }] });
    const notes: string[] = [];
    const error = await steerQueued(dispatch, threadId, queued, () =>
      notes.push(`noted after ${sent.length}`),
    );
    expect(error).toBeNull();
    expect(sent.map((command) => command.type)).toEqual([
      "thread.queue.remove",
      "thread.turn.steer",
    ]);
    expect(sent[0]).toMatchObject({ threadId, queuedMessageId: queued.queuedMessageId });
    expect(sent[1]).toMatchObject({
      threadId,
      text: queued.text,
      attachments: queued.attachments,
      mentions: queued.mentions,
      references: queued.references,
    });
    expect(notes).toEqual(["noted after 1"]);
  });

  it("does not steer when the removal is refused", async () => {
    const { sent, dispatch } = recorder({ "thread.queue.remove": "not queued" });
    expect(await steerQueued(dispatch, threadId, message(), () => {})).toBe("not queued");
    expect(sent.map((command) => command.type)).toEqual(["thread.queue.remove"]);
  });

  it("puts a refused steer back on the queue with the same fields", async () => {
    const { sent, dispatch } = recorder({ "thread.turn.steer": "the turn ended" });
    const queued = message();
    const error = await steerQueued(dispatch, threadId, queued, () => {});
    expect(error).toBe("the turn ended — it is back at the end of the queue");
    expect(sent.map((command) => command.type)).toEqual([
      "thread.queue.remove",
      "thread.turn.steer",
      "thread.turn.start",
    ]);
    expect(sent[2]).toMatchObject({
      threadId,
      text: queued.text,
      attachments: queued.attachments,
      mentions: queued.mentions,
      references: queued.references,
      queued: true,
    });
  });

  it("re-queues when the steer never reached the server", async () => {
    const { sent, dispatch } = recorder({ "thread.turn.steer": "unreachable" });
    const error = await steerQueued(dispatch, threadId, message(), () => {});
    expect(error).toMatch(/could not reach the server/);
    expect(sent.at(-1)?.type).toBe("thread.turn.start");
  });
});

describe("editQueued", () => {
  it("fills the draft only after the server took the message off the queue", async () => {
    const { sent, dispatch } = recorder();
    const queued = message();
    const filled: QueuedMessage[] = [];
    expect(await editQueued(dispatch, threadId, queued, (m) => filled.push(m))).toBeNull();
    expect(sent.map((command) => command.type)).toEqual(["thread.queue.remove"]);
    expect(filled).toEqual([queued]);
  });

  it("leaves the draft alone when the removal is refused", async () => {
    const { dispatch } = recorder({ "thread.queue.remove": "already sent" });
    const filled: QueuedMessage[] = [];
    expect(await editQueued(dispatch, threadId, message(), (m) => filled.push(m))).toBe(
      "already sent",
    );
    expect(filled).toEqual([]);
  });
});

describe("draftHasContent", () => {
  it("asks before replacing anything the user typed or picked", () => {
    expect(draftHasContent(emptyComposerDraft)).toBe(false);
    expect(draftHasContent({ ...emptyComposerDraft, text: "wip" })).toBe(true);
    expect(draftHasContent({ ...emptyComposerDraft, mentions: ["a.ts"] })).toBe(true);
    expect(
      draftHasContent({ ...emptyComposerDraft, references: [{ kind: "plugin", name: "x" }] }),
    ).toBe(true);
    expect(draftHasContent({ ...emptyComposerDraft, files: [new File(["x"], "shot.png")] })).toBe(
      true,
    );
  });
});
