/**
 * Records the interaction scenarios from the real CLI into `fixtures/codex/`:
 * plan mode, a question, a steer, a compaction and an MCP tool call approved
 * on its card.
 *
 *     POSEIDON_RECORD_CODEX=1 POSEIDON_HOME=/tmp/poseidon-codex \
 *       pnpm -F @poseidon/connector-codex vitest run test/recordInteractions.test.ts
 *
 * Same rules as `recordSession.test.ts`: the connector's real definition on
 * the tee, the CLI's default model, trivial prompts. Skipped unless asked
 * for: it runs the operator's real CLI and account.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { COMPACT_COMMAND } from "../src/compaction";
import { startMcpStandIn, STAND_IN_TOOL } from "./mcpStandIn";
import { RECORD } from "./record";
import { answerCards, closed, recordScenario, SETTINGS, text, turn } from "./scenario";

const INTERACTION_PROMPTS = {
  plan: "Without running any commands, plan how to create hello.txt containing hi. Two steps. Do not ask questions.",
  implement: "Implement the approved plan.",
  question:
    "Without running any commands, first ask me with your question tool whether the new file should be named a.txt or b.txt. Then give a one-line plan.",
  sleep: "Run: sleep 5; echo one",
  steer: "Also, end your reply with the word pineapple.",
  plain: "Reply with exactly: ok",
  mcpTool: `Call the ${STAND_IN_TOOL.name} tool of the poseidon MCP server once with url https://example.com, then reply with one word.`,
} as const;

const PLAN = { ...SETTINGS, interactionMode: "plan" } as const;

describe("interaction recordings", () => {
  it.live.skipIf(!RECORD)("plan-accept: a plan proposed, then accepted out of plan mode", () =>
    recordScenario(
      {
        scenario: "plan-accept",
        description:
          "A plan turn (collaborationMode plan) hands its plan over as a plan item; the plan is accepted, so the next turn leaves plan mode (collaborationMode default) and implements it, its file change allowed once.",
        prompts: [INTERACTION_PROMPTS.plan, INTERACTION_PROMPTS.implement],
        settings: PLAN,
      },
      (session) =>
        Effect.gen(function* () {
          const recording = yield* session.open();
          yield* answerCards(recording, "allow-once");
          yield* turn(recording, text(INTERACTION_PROMPTS.plan));
          const proposed = yield* recording.collector.awaitItem(
            (event) => event.type === "turn.plan.proposed",
          );
          if (proposed.type !== "turn.plan.proposed") throw new Error("no plan");
          yield* recording.handle.respondToPlan(proposed.payload.turnId, "accept");
          yield* recording.handle.updateSettings({ interactionMode: "default" });
          yield* turn(recording, text(INTERACTION_PROMPTS.implement));
          yield* closed(recording);
          expect(NodeFS.existsSync(NodePath.join(session.repo, "hello.txt"))).toBe(true);
        }),
    ),
  );

  it.live.skipIf(!RECORD)("question: the model asks, answered with its first option", () =>
    recordScenario(
      {
        scenario: "question",
        description:
          "A plan turn in which the model asks the user a question (item/tool/requestUserInput); the card is answered with its first option, and the plan names it.",
        prompts: [INTERACTION_PROMPTS.question],
        settings: PLAN,
      },
      (session) =>
        Effect.gen(function* () {
          const recording = yield* session.open();
          yield* answerCards(recording, "allow-once");
          yield* recording.handle.send(text(INTERACTION_PROMPTS.question));
          const asked = yield* recording.collector.awaitItem(
            (event) => event.type === "user-input.requested",
          );
          if (asked.type !== "user-input.requested") throw new Error("no question");
          const [question] = asked.payload.questions;
          yield* recording.handle.respondToUserInput(asked.payload.requestId, [
            { questionId: question!.questionId, optionIds: [question!.options[0]!.optionId] },
          ]);
          yield* recording.collector.awaitItem((event) => event.type === "turn.completed");
          yield* closed(recording);
        }),
    ),
  );

  it.live.skipIf(!RECORD)("steering: a message steered into a running command's turn", () =>
    recordScenario(
      {
        scenario: "steering",
        description:
          "Full access: a turn runs `sleep 5; echo one`, and once the command's row shows a second message is steered in (turn/steer); the one turn ends with an answer naming the steered word.",
        prompts: [INTERACTION_PROMPTS.sleep, INTERACTION_PROMPTS.steer],
        settings: { ...SETTINGS, runtimeMode: "full-access" },
      },
      (session) =>
        Effect.gen(function* () {
          const recording = yield* session.open();
          // The ladder may still ask about the compound command; it is allowed.
          yield* answerCards(recording, "allow-once");
          yield* recording.handle.send(text(INTERACTION_PROMPTS.sleep));
          yield* recording.collector.awaitItem(
            (event) =>
              event.type === "item.started" && event.payload.item.kind === "command_execution",
          );
          yield* recording.handle.steer!(text(INTERACTION_PROMPTS.steer));
          yield* recording.collector.awaitItem((event) => event.type === "turn.completed");
          yield* closed(recording);
        }),
    ),
  );

  it.live.skipIf(!RECORD)("compaction: /compact on a one-turn thread", () =>
    recordScenario(
      {
        scenario: "compaction",
        description:
          "One answered turn, then a /compact turn sent as thread/compact/start: the CLI's compaction turn, its contextCompaction item and the context it leaves.",
        prompts: [INTERACTION_PROMPTS.plain, COMPACT_COMMAND],
      },
      (session) =>
        Effect.gen(function* () {
          const recording = yield* session.open();
          yield* turn(recording, text(INTERACTION_PROMPTS.plain));
          yield* turn(recording, text(COMPACT_COMMAND));
          yield* closed(recording);
        }),
    ),
  );

  it.live.skipIf(!RECORD)("mcp-tool-approval: a Poseidon MCP tool call, allowed on its card", () =>
    Effect.gen(function* () {
      const standIn = yield* Effect.promise(() => startMcpStandIn());
      yield* recordScenario(
        {
          scenario: "mcp-tool-approval",
          description: `Poseidon's MCP server answering at a live loopback endpoint with one tool shaped like the gateway's ${STAND_IN_TOOL.name} (not read-only, open world): the model calls it, the CLI asks with mcpServer/elicitation/request (codex_approval_kind mcp_tool_call), the card allows it once, and the call runs.`,
          prompts: [INTERACTION_PROMPTS.mcpTool],
          mcp: standIn.endpoint,
        },
        (session) =>
          Effect.gen(function* () {
            const recording = yield* session.open();
            const answered = yield* answerCards(recording, "allow-once");
            yield* turn(recording, text(INTERACTION_PROMPTS.mcpTool));
            yield* closed(recording);
            expect(answered.size).toBe(1);
          }),
      ).pipe(Effect.ensuring(Effect.promise(() => standIn.close())));
      expect(standIn.calls()).toEqual([{ url: "https://example.com" }]);
    }),
  );
});
