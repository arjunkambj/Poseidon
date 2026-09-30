/**
 * A Claude Code subagent, through the whole server.
 *
 * The model delegates to a general-purpose agent with the Task tool. The call
 * opens a `task` row and `task.started`; the subagent's own work — its
 * messages carry the call's id as `parent_tool_use_id` — lands in rows nested
 * under it (`parentItemId`), which is what the timeline folds into the task
 * row; and the `task_*` lifecycle settles the task. The thread runs in full
 * access, but a listing that names `.git` — the model tends to leave it out
 * of a `find` — touches a sensitive path, which asks in every mode; such a
 * card is answered for it, since this scenario is about the nesting, not the
 * gate.
 */

import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { autoApprove, connect, isSettled, startTurn, staticCredentials } from "../e2e/harness";
import { claudeScenario } from "./harness";

const DELEGATE = "Use the Task tool with a general-purpose agent to list the files here.";

claudeScenario(
  "a Claude Code subagent",
  {
    scenario: "subagent",
    description:
      "Full access: the model delegates listing the scratch repo's files to a general-purpose agent with the Task tool; the subagent's calls run nested under the task, and the model reports what it found.",
    prompts: [DELEGATE],
    seed: { "notes.txt": "a note\n" },
  },
  "nests the subagent's rows under its task row",
  (run) =>
    Effect.gen(function* () {
      const server = yield* run.boot;
      const client = yield* connect(Effect.succeed(staticCredentials(server)));
      const open = yield* run.openThread(client, { runtimeMode: "full-access" });
      yield* autoApprove(client, open);

      const started = yield* startTurn(client, open, { text: DELEGATE });
      const done = yield* open.view.awaitValue(isSettled, started);
      expect(done.status).not.toBe("error");
      expect(done.items.filter((item) => item.kind === "error")).toEqual([]);

      const tasks = done.items.filter((item) => item.kind === "task");
      expect(tasks.length).toBeGreaterThan(0);
      const task = tasks[0]!;
      expect(task.status).toBe("completed");
      expect(task.text ?? "").not.toBe("");

      // The subagent's own rows point at the task, and none of them is left running.
      const nested = done.items.filter((item) => item.parentItemId === task.itemId);
      expect(nested.length).toBeGreaterThan(0);
      expect(nested.every((item) => item.status !== "in_progress")).toBe(true);
    }),
);
