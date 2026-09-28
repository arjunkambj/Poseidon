/**
 * Stopping one Claude Code subagent while its turn goes on.
 *
 * The model delegates a slow command to a general-purpose agent. Once the
 * task row is open and running, `thread.task.stop` names it: the connector
 * calls the SDK's `stopTask` with the CLI's `task_id` for that row, the CLI
 * reports the task stopped, and the row settles as failed. The turn itself is
 * not interrupted — it settles on its own, not with `interrupted`.
 *
 * Stop is sent on an event, not a timer: once the task row shows. A replay
 * writes everything the CLI said up to then and waits for the `stop_task`
 * request on stdin, so the moment is the same in both drivers.
 */

import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { command, connect, isSettled, startTurn, staticCredentials } from "../e2e/harness";
import { claudeScenario } from "./harness";

const DELEGATE =
  "Use the Task tool with a general-purpose agent to run `sleep 60` and then say done. Once the agent returns, reply with exactly: finished";

claudeScenario(
  "stopping a Claude Code subagent",
  {
    scenario: "subagent-stop",
    description:
      "Full access: the model delegates `sleep 60` to a general-purpose agent; once the task row is running, `stop_task` stops it, the row settles as failed, and the turn goes on to its own end.",
    prompts: [DELEGATE],
  },
  "settles the stopped task as failed and lets the turn finish",
  (run) =>
    Effect.gen(function* () {
      const server = yield* run.boot;
      const client = yield* connect(Effect.succeed(staticCredentials(server)));
      const open = yield* run.openThread(client, { runtimeMode: "full-access" });

      const started = yield* startTurn(client, open, { text: DELEGATE });
      const running = yield* open.view.awaitValue(
        (view) => view.items.some((item) => item.kind === "task" && item.status === "in_progress"),
        started,
      );
      expect(running.session?.capabilities?.stopTask).toBe(true);
      const task = running.items.find(
        (item) => item.kind === "task" && item.status === "in_progress",
      )!;

      const stopped = yield* open.view.markAfter(
        yield* client.send(
          command({ type: "thread.task.stop", threadId: open.threadId, itemId: task.itemId }),
        ),
      );
      const done = yield* open.view.awaitValue(isSettled, stopped);
      expect(done.status).not.toBe("error");
      expect(done.items.find((item) => item.itemId === task.itemId)?.status).toBe("failed");
      expect(done.items.filter((item) => item.kind === "error")).toEqual([]);
    }),
);
