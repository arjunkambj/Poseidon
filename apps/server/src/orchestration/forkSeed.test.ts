import { describe, expect, it } from "vitest";

import { makeItemId, makeProjectId, makeThreadId, makeTurnId } from "@poseidon/contracts/ids";
import type { TurnId } from "@poseidon/contracts/ids";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";

import { forkTranscript, OMITTED_MARKER, withForkContext } from "./forkSeed";
import type { ThreadDoc } from "./state";

const NOW = "2026-01-02T03:04:05.000Z";

const row = (kind: ItemSnapshot["kind"], turnId: TurnId, text: string): ItemSnapshot => ({
  itemId: makeItemId(),
  kind,
  status: "completed",
  turnId,
  text,
});

const [t1, t2, t3] = [makeTurnId(), makeTurnId(), makeTurnId()];
const ask1 = row("user_message", t1, "Add a health check.");
const items: ReadonlyArray<ItemSnapshot> = [
  ask1,
  row("command_execution", t1, "pnpm lint"),
  row("assistant_message", t1, "Added GET /healthz."),
  row("user_message", t1, "Also return the build id."),
  row("assistant_message", t1, "It returns the build id too."),
  row("user_message", t2, "Now test it."),
  {
    itemId: makeItemId(),
    kind: "plan",
    status: "completed",
    turnId: t2,
    plan: { markdown: "1. Write the test" },
  },
  { ...row("assistant_message", t2, "A subagent's note."), parentItemId: makeItemId() },
  row("assistant_message", t2, "Tested."),
];

describe("forkTranscript", () => {
  it("cuts at the end of the turn that holds the message, steered messages and answers included", () => {
    expect(forkTranscript(items, ask1.itemId)).toBe(
      [
        "User:\nAdd a health check.",
        "Assistant:\nAdded GET /healthz.",
        "User:\nAlso return the build id.",
        "Assistant:\nIt returns the build id too.",
      ].join("\n\n"),
    );
  });

  it("carries the whole thread without a message, plans and all, but no tool or subagent rows", () => {
    const transcript = forkTranscript(items);
    expect(transcript).toContain("User:\nNow test it.\n\nAssistant (plan):\n1. Write the test");
    expect(transcript.endsWith("Assistant:\nTested.")).toBe(true);
    expect(transcript).not.toContain("pnpm lint");
    expect(transcript).not.toContain("subagent");
  });

  it("drops the oldest turns behind a marker to stay under the limit", () => {
    const long = [
      row("user_message", t1, "a".repeat(40)),
      row("assistant_message", t1, "b".repeat(40)),
      row("user_message", t2, "c".repeat(40)),
      row("user_message", t3, "d".repeat(40)),
    ];
    const transcript = forkTranscript(long, undefined, 110);
    expect(transcript).toBe(
      `${OMITTED_MARKER}\n\nUser:\n${"c".repeat(40)}\n\nUser:\n${"d".repeat(40)}`,
    );
  });

  it("keeps the tail of a newest turn longer than the limit on its own", () => {
    const transcript = forkTranscript(
      [row("user_message", t1, `start ${"x".repeat(100)} end`)],
      undefined,
      20,
    );
    expect(transcript.startsWith(OMITTED_MARKER)).toBe(true);
    expect(transcript.endsWith("x end")).toBe(true);
    expect(transcript.length).toBe(OMITTED_MARKER.length + 2 + 20);
  });

  it("is empty for a thread with nothing said yet", () => {
    expect(forkTranscript([])).toBe("");
  });
});

describe("withForkContext", () => {
  const doc = (fields: Partial<ThreadDoc>): ThreadDoc =>
    ({
      threadId: makeThreadId(),
      projectId: makeProjectId(),
      title: "Fork",
      items: [],
      createdAt: NOW,
      updatedAt: NOW,
      ...fields,
    }) as ThreadDoc;
  const fork = {
    threadId: makeThreadId(),
    title: "Health check",
    transcript: "User:\nAdd it.\n\nAssistant:\nDone.",
  };
  const input = { text: "Now test it.", attachments: [], mentions: [] };

  it("puts the transcript ahead of a fork's first message", () => {
    const first = row("user_message", t1, "Now test it.");
    const sent = withForkContext(doc({ fork, items: [first] }), t1, input);
    expect(sent.text).toContain('continues an earlier one, "Health check"');
    expect(sent.text).toContain(fork.transcript);
    expect(sent.text.endsWith("The user's new message:\n\nNow test it.")).toBe(true);
    expect(sent.attachments).toBe(input.attachments);
  });

  it("leaves every later turn alone", () => {
    const later = doc({
      fork,
      items: [row("user_message", t1, "first"), row("user_message", t2, "second")],
    });
    expect(withForkContext(later, t2, input)).toBe(input);
  });

  it("prefixes the first turn again when it is resent, a steered message and all", () => {
    const resent = doc({
      fork,
      items: [row("user_message", t1, "first"), row("user_message", t1, "steered")],
    });
    expect(withForkContext(resent, t1, input).text).toContain(fork.transcript);
  });

  it("leaves a thread that is not a fork, or a fork of nothing, alone", () => {
    expect(withForkContext(doc({}), t1, input)).toBe(input);
    expect(withForkContext(doc({ fork: { ...fork, transcript: "" } }), t1, input)).toBe(input);
  });
});
