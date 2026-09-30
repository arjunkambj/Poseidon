/**
 * Plan mode on Claude Code, through the whole server.
 *
 * A plan turn runs the CLI in its `plan` permission mode. The model writes its
 * plan file and calls ExitPlanMode; the connector turns that call into the
 * plan card and refuses it with a message that tells the model to stop, so
 * the plan turn ends on the CLI's own result. Accepting the plan takes the
 * thread out of plan mode and sends the implementation turn, which the CLI
 * now runs in its default mode and which edits the file.
 *
 * A replay runs no tool, so the file on disk is checked by the live and
 * record drivers; a replay checks what the thread shows. The implementation
 * turn's edit stops on an approval card, which is answered for it: this
 * scenario is about the mode, not the gate.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  autoApprove,
  command,
  connect,
  isSettled,
  startTurn,
  staticCredentials,
} from "../e2e/harness";
import { claudeScenario } from "./harness";

const PROPOSE =
  "Plan how to add a subtract(a, b) function to app.js, in at most three short lines, then present the plan with ExitPlanMode.";
const SEED = { "app.js": "export const add = (a, b) => a + b;\n" };

claudeScenario(
  "accepting a Claude Code plan",
  {
    scenario: "plan-accept",
    description:
      "A plan turn: the model writes its plan and calls ExitPlanMode, which becomes the plan card and stops the turn. The plan is accepted, and the implementation turn, out of plan mode, adds subtract to app.js; its edit card is allowed once.",
    prompts: [PROPOSE, "Implement the approved plan at <the CLI's plan file>"],
    seed: SEED,
  },
  "raises the plan card, and accepting it implements the plan out of plan mode",
  (run) =>
    Effect.gen(function* () {
      const server = yield* run.boot;
      const client = yield* connect(Effect.succeed(staticCredentials(server)));
      const open = yield* run.openThread(client, { interactionMode: "plan" });
      yield* autoApprove(client, open);

      const started = yield* startTurn(client, open, { text: PROPOSE });
      // The card stays up after the turn: the plan turn is over once the CLI's
      // own result has ended it with the plan still pending.
      const proposed = yield* open.view.awaitValue(
        (view) =>
          (view.pendingPlan !== null && view.currentTurnId === null) || view.status === "error",
        started,
      );
      expect(proposed.status).not.toBe("error");
      const plan = proposed.pendingPlan!;
      expect(plan.planMarkdown.length).toBeGreaterThan(0);
      expect(proposed.settings.interactionMode).toBe("plan");
      // Nothing was changed while planning.
      if (run.driver !== "replay") {
        expect(NodeFS.readFileSync(NodePath.join(run.home.workspace, "app.js"), "utf8")).toBe(
          SEED["app.js"],
        );
      }

      const accepted = yield* open.view.markAfter(
        yield* client.send(
          command({
            type: "thread.plan.respond",
            threadId: open.threadId,
            turnId: plan.turnId,
            action: "accept",
          }),
        ),
      );
      const implementing = yield* open.view.awaitAt(
        (view) => view.settings.interactionMode === "default" && view.currentTurnId !== null,
        accepted,
      );
      expect(implementing.value.pendingPlan).toBeNull();

      const done = yield* open.view.awaitValue(isSettled, implementing.next);
      expect(done.status).not.toBe("error");
      expect(done.settings.interactionMode).toBe("default");
      expect(done.items.some((item) => item.kind === "plan")).toBe(true);
      const sent = done.items.filter((item) => item.kind === "user_message");
      expect(sent).toHaveLength(2);
      expect(sent.at(-1)!.text ?? "").toContain("Implement the approved plan");
      const edits = done.items.filter(
        (item) =>
          item.kind === "file_change" &&
          item.status === "completed" &&
          item.fileChange?.path.endsWith("app.js"),
      );
      expect(edits.length).toBeGreaterThan(0);
      if (run.driver !== "replay") {
        expect(NodeFS.readFileSync(NodePath.join(run.home.workspace, "app.js"), "utf8")).toContain(
          "subtract",
        );
      }
    }),
);
