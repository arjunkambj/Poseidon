/**
 * The Codex definition against the interaction recordings, replayed behind
 * the binary path as in `recordedSession.test.ts`.
 *
 * `plan-accept`: a plan turn's plan row and `turn.plan.proposed`, then the
 * accepted implementation out of plan mode. `question`: the model's question
 * on the card, answered with its first option. `steering`: a message steered
 * into a running command's turn, answered in the same turn. `compaction`: a
 * `/compact` turn run as the CLI's compaction.
 *
 * Every replay checks what the connector sent against what the recording
 * says it sent; the divergence log must stay empty.
 */

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  closed,
  ofType,
  prompts,
  replaying,
  rows,
  SETTINGS,
  stopReasons,
  text,
  turn,
  turnWithCard,
} from "../test/replaySession";
import { COMPACT_COMMAND } from "./compaction";

const PLAN = { ...SETTINGS, interactionMode: "plan" } as const;

describe("a Codex session replaying codex/plan-accept", () => {
  it.live("proposes the plan at the plan turn's end, then implements it out of plan mode", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, assertDone } = yield* replaying("plan-accept", PLAN);
        const [plan, implement] = prompts("plan-accept");
        const session = yield* open();
        yield* turn(session, text(plan!));
        const proposed = yield* session.collector.awaitItem(
          (event) => event.type === "turn.plan.proposed",
        );
        if (proposed.type !== "turn.plan.proposed") throw new Error("no plan");
        yield* session.handle.respondToPlan(proposed.payload.turnId, "accept");
        yield* session.handle.updateSettings({ interactionMode: "default" });
        const { request } = yield* turnWithCard(session, text(implement!), "allow-once");
        const events = yield* closed(session);
        assertDone();

        const planRows = rows(events, "plan");
        expect(planRows).toHaveLength(1);
        expect(planRows[0]!.plan?.markdown).toContain("hello.txt");
        const proposals = ofType(events, "turn.plan.proposed");
        expect(proposals.map((event) => event.payload.planMarkdown)).toEqual([
          planRows[0]!.plan!.markdown.trim(),
        ]);
        const [firstTurn] = ofType(events, "turn.started");
        expect(proposals[0]!.payload.turnId).toBe(firstTurn!.payload.turnId);
        // Proposed inside the plan turn, just before it ended.
        const completions = ofType(events, "turn.completed");
        expect(events.indexOf(proposals[0]!)).toBe(events.indexOf(completions[0]!) - 1);
        expect(request).toMatchObject({ kind: "file_write", toolName: "Edit" });
        expect(stopReasons(events)).toEqual(["end_turn", "end_turn"]);
        expect(ofType(events, "event.unmapped")).toEqual([]);
        expect(ofType(events, "runtime.error")).toEqual([]);
      }),
    ),
  );
});

describe("a Codex session replaying codex/question", () => {
  it.live("raises the model's question on the card and sends the chosen option back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, assertDone } = yield* replaying("question", PLAN);
        const session = yield* open();
        yield* session.handle.send(text(prompts("question")[0]!));
        const asked = yield* session.collector.awaitItem(
          (event) => event.type === "user-input.requested",
        );
        if (asked.type !== "user-input.requested") throw new Error("no question");
        const [question] = asked.payload.questions;
        expect(question).toMatchObject({
          questionId: "file_name",
          header: "File name",
          freeform: true,
          multiSelect: false,
        });
        expect(question!.options.map((option) => option.label)).toEqual([
          "a.txt (Recommended)",
          "b.txt",
        ]);
        yield* session.handle.respondToUserInput(asked.payload.requestId, [
          { questionId: "file_name", optionIds: [question!.options[0]!.optionId] },
        ]);
        yield* session.collector.awaitItem((event) => event.type === "turn.completed");
        const events = yield* closed(session);
        assertDone();

        expect(
          ofType(events, "user-input.resolved").map((event) => event.payload.requestId),
        ).toEqual([asked.payload.requestId]);
        const proposed = ofType(events, "turn.plan.proposed");
        expect(proposed).toHaveLength(1);
        expect(proposed[0]!.payload.planMarkdown).toContain("a.txt");
        expect(stopReasons(events)).toEqual(["end_turn"]);
        expect(ofType(events, "event.unmapped")).toEqual([]);
        expect(ofType(events, "session.warning")).toEqual([]);
      }),
    ),
  );
});

describe("a Codex session replaying codex/steering", () => {
  it.live("steers a message into the running turn, which one completion ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, assertDone } = yield* replaying("steering", {
          ...SETTINGS,
          runtimeMode: "full-access",
        });
        const [sleep, steered] = prompts("steering");
        const session = yield* open();
        yield* session.handle.send(text(sleep!));
        yield* session.collector.awaitItem(
          (event) =>
            event.type === "item.started" && event.payload.item.kind === "command_execution",
        );
        // The CLI may answer the steer only once the command's card is
        // answered (as recorded), so the two run side by side.
        const steering = yield* Effect.forkChild(session.handle.steer!(text(steered!)));
        const card = yield* session.collector.awaitItem((event) => event.type === "request.opened");
        if (card.type !== "request.opened") throw new Error("no card");
        yield* session.handle.respondToRequest(card.payload.request.requestId, "allow-once");
        yield* Fiber.join(steering);
        yield* session.collector.awaitItem((event) => event.type === "turn.completed");
        // With the turn over, a steer is refused for the server to queue.
        const late = yield* Effect.flip(session.handle.steer!(text(steered!)));
        const events = yield* closed(session);
        assertDone();

        expect(late._tag).toBe("NotSteerable");
        expect(ofType(events, "turn.started")).toHaveLength(1);
        expect(stopReasons(events)).toEqual(["end_turn"]);
        const answers = rows(events, "assistant_message");
        expect(answers.at(-1)!.text).toContain("pineapple");
        expect(rows(events, "command_execution")[0]!.command?.output).toContain("one");
        // The turn's usage spans both of its model requests.
        const usage = ofType(events, "usage.updated").map((event) => event.payload);
        expect(usage.length).toBeGreaterThan(1);
        expect(usage.at(-1)!.output).toBeGreaterThan(usage[0]!.output);
        expect(ofType(events, "event.unmapped")).toEqual([]);
      }),
    ),
  );
});

describe("a Codex session replaying codex/compaction", () => {
  it.live("runs /compact as the CLI's compaction turn: its row and the smaller context", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, assertDone } = yield* replaying("compaction");
        const [plain] = prompts("compaction");
        const session = yield* open();
        yield* turn(session, text(plain!));
        const before = yield* session.collector.collected;
        yield* session.handle.send(text(COMPACT_COMMAND));
        // A compaction takes no messages: a steer is refused at once.
        const steer = yield* Effect.flip(session.handle.steer!(text("hi")));
        yield* session.collector.awaitItem(
          (event) => !before.includes(event) && event.type === "turn.completed",
        );
        const events = yield* closed(session);
        assertDone();

        expect(steer._tag).toBe("NotSteerable");
        expect(rows(events, "context_compaction").map((row) => row.status)).toEqual(["completed"]);
        const context = ofType(events, "context.updated").map((event) => event.payload.used);
        expect(context.at(-1)!).toBeLessThan(context[0]!);
        expect(stopReasons(events)).toEqual(["end_turn", "end_turn"]);
        expect(ofType(events, "event.unmapped")).toEqual([]);
        expect(ofType(events, "runtime.error")).toEqual([]);
      }),
    ),
  );
});
