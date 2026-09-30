/**
 * A session's subagents: the `task` rows the Task and Agent tools open, their
 * lifecycle, and the work each subagent does nested under its row.
 *
 * The SDK tells a subagent three ways, all keyed by the `tool_use` id of the
 * call that started it:
 *
 * - the call itself, a `tool_use` block of the main loop's snapshot. Its row
 *   (`tools.ts`) is the task's row, and `task.started` goes out beside it with
 *   the call's `description` as the title and its `model` when it names one;
 * - `system` messages of the `task_*` family. `task_started` ties the CLI's own
 *   `task_id` to the call's `tool_use_id`; `task_progress`, `task_updated` and
 *   `task_notification` then name only one of the two. They become
 *   `task.updated` while the task runs and `task.completed` once it settled —
 *   `completed`, or `failed` for a failure, a kill or a stop. The same family
 *   reports the CLI's shell commands. A foreground one (`task_type`
 *   `local_bash`, not `is_backgrounded`) is a command the CLI waited on long
 *   enough to track: its row settles with its own result, so its `task_*`
 *   messages add nothing (`steering`), until a `task_updated` says the CLI
 *   moved it to the background. A background one's row settled when the
 *   command was launched and cannot say how it ended; a `task_*` message whose
 *   call opened a row of another kind is kept unmapped, whole, until a mapping
 *   onto that row exists;
 * - the subagent's own messages — its stream, its snapshots and the results of
 *   its calls — carrying the call's id as `parent_tool_use_id`. The translator
 *   reads them as it reads the main loop's, and every row they open is nested
 *   under the task's row (`parentItemId`).
 *
 * A subagent's message, or a `task_*` message, can reach the session before
 * the snapshot that opens its task: the id it names has no row yet. Such
 * messages wait here, keyed by that id, and are read the moment the row
 * opens. Whatever still waits when the turn ends is let go then, so nothing is
 * held past its turn and nothing is dropped: a subagent's message is read
 * without a parent, and the timeline shows its rows at the top level; a
 * lifecycle message with no row to move is kept unmapped.
 */

import type { ItemStatus } from "@poseidon/contracts/runtime";
import type { ItemId } from "@poseidon/contracts/ids";

import { asRecord, asString, type Json, type PendingRuntimeEvent } from "./pending";

/** The title of a task whose call gave neither a description nor a kind. */
export const UNTITLED_TASK = "Subagent task";

/**
 * How the CLI's task states read as a row's status: `null` while the task
 * still runs, the settled status once it is done. `stopped` and `killed` are
 * the user or the model ending it early, which the row shows as not finished.
 */
export const settledTaskStatus = (status: string | undefined): ItemStatus | null => {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "killed":
    case "stopped":
      return "failed";
    default:
      return null;
  }
};

/** The title a Task or Agent call gives its task. */
export const taskTitleOf = (input: Json): string => {
  const described = asString(input.description)?.trim();
  if (described !== undefined && described !== "") return described;
  const kind = asString(input.subagent_type)?.trim();
  return kind === undefined || kind === "" ? UNTITLED_TASK : `${kind} subagent`;
};

interface Task {
  readonly itemId: ItemId;
  readonly title: string;
  readonly model?: string;
  readonly parentItemId?: ItemId;
  settled: boolean;
}

/** A row the translator already opened for a `tool_use` id. */
export type RowLookup = (
  toolUseId: string,
) => { readonly itemId: ItemId; readonly kind: string } | undefined;

export interface Subagents {
  /** A Task or Agent call's row opened → `task.started`. */
  readonly opened: (
    toolUseId: string,
    itemId: ItemId,
    input: Json,
    parentItemId: ItemId | undefined,
  ) => ReadonlyArray<PendingRuntimeEvent>;
  /**
   * The `tool_use` id a `task_*` system message belongs to: the one it names,
   * or the one its `task_started` tied its `task_id` to. Undefined for a task
   * nothing here has heard of.
   */
  readonly callOf: (message: Json) => string | undefined;
  /**
   * A `task_*` system message whose call has a row → its task events: none
   * for what a settled task's row already shows, nor for a foreground shell
   * command's, whose row its own result settles. Null for a message this does
   * not read — a call whose row is not a task's (a background shell command,
   * or another tool the CLI runs as a task), or a `task_*` kind it does not
   * know — which the translator keeps unmapped.
   */
  readonly lifecycle: (
    toolUseId: string,
    message: Json,
  ) => ReadonlyArray<PendingRuntimeEvent> | null;
  /**
   * The CLI's `task_id` for the running task whose row is `itemId`, which is
   * what the SDK's `stopTask` takes. Undefined once the task settled, or
   * before its `task_started` named the id.
   */
  readonly cliTaskOf: (itemId: ItemId) => string | undefined;
  /** Holds a subagent's message until its task's row opens. */
  readonly hold: (toolUseId: string, message: Json) => void;
  /** The held messages whose task row is open now, taken out. */
  readonly takeReady: (rowOf: RowLookup) => ReadonlyArray<{ toolUseId: string; message: Json }>;
  /** Every message still held, taken out — the turn ended. */
  readonly takeAll: () => ReadonlyArray<Json>;
}

export const makeSubagents = (): Subagents => {
  /** By the `tool_use` id of the call that started each. */
  const tasks = new Map<string, Task>();
  /** The CLI's `task_id` → the call's `tool_use` id, for every task it reported. */
  const calls = new Map<string, string>();
  /** The CLI's `task_id`s of shell commands it ran in the foreground. */
  const foreground = new Set<string>();
  const held = new Map<string, Array<Json>>();

  const event = (
    type: "task.started" | "task.updated" | "task.completed",
    task: Task,
    status: ItemStatus,
    title = task.title,
  ): PendingRuntimeEvent => ({
    type,
    payload: {
      taskId: task.itemId,
      title,
      status,
      ...(task.parentItemId === undefined ? {} : { parentItemId: task.parentItemId }),
      ...(task.model === undefined ? {} : { model: task.model }),
    },
  });

  const opened: Subagents["opened"] = (toolUseId, itemId, input, parentItemId) => {
    if (tasks.has(toolUseId)) return [];
    const model = asString(input.model)?.trim();
    const task: Task = {
      itemId,
      title: taskTitleOf(input),
      ...(model === undefined || model === "" ? {} : { model }),
      ...(parentItemId === undefined ? {} : { parentItemId }),
      settled: false,
    };
    tasks.set(toolUseId, task);
    return [event("task.started", task, "in_progress")];
  };

  const callOf: Subagents["callOf"] = (message) => {
    const taskId = asString(message.task_id);
    const named = asString(message.tool_use_id);
    if (message.subtype === "task_started" && taskId !== undefined && named !== undefined) {
      calls.set(taskId, named);
      if (message.task_type === "local_bash" && message.is_backgrounded === false) {
        foreground.add(taskId);
      }
    }
    // A foreground command the CLI later moves to the background: its row
    // settles as launched there, so how it ends is a background command's.
    if (
      message.subtype === "task_updated" &&
      taskId !== undefined &&
      asRecord(message.patch).is_backgrounded === true
    ) {
      foreground.delete(taskId);
    }
    return named ?? (taskId === undefined ? undefined : calls.get(taskId));
  };

  const lifecycle: Subagents["lifecycle"] = (toolUseId, message) => {
    const task = tasks.get(toolUseId);
    if (task === undefined) {
      const taskId = asString(message.task_id);
      return taskId !== undefined && foreground.has(taskId) ? [] : null;
    }
    if (task.settled) return [];
    const settle = (status: ItemStatus): ReadonlyArray<PendingRuntimeEvent> => {
      task.settled = true;
      return [event("task.completed", task, status)];
    };
    switch (message.subtype) {
      case "task_started":
        return [event("task.updated", task, "in_progress")];
      case "task_progress": {
        const summary = asString(message.summary)?.trim();
        return [
          event(
            "task.updated",
            task,
            "in_progress",
            summary === undefined || summary === "" ? task.title : summary,
          ),
        ];
      }
      case "task_updated": {
        const status = asString(asRecord(message.patch).status);
        if (status === undefined) return [];
        const settled = settledTaskStatus(status);
        return settled === null ? [event("task.updated", task, "in_progress")] : settle(settled);
      }
      case "task_notification":
        return settle(settledTaskStatus(asString(message.status)) ?? "completed");
      default:
        return null;
    }
  };

  const cliTaskOf: Subagents["cliTaskOf"] = (itemId) => {
    for (const [taskId, toolUseId] of calls) {
      const task = tasks.get(toolUseId);
      if (task?.itemId === itemId && !task.settled) return taskId;
    }
    return undefined;
  };

  return {
    opened,
    callOf,
    lifecycle,
    cliTaskOf,
    hold: (toolUseId, message) => {
      held.set(toolUseId, [...(held.get(toolUseId) ?? []), message]);
    },
    takeReady: (rowOf) => {
      const ready: Array<{ toolUseId: string; message: Json }> = [];
      for (const [toolUseId, messages] of held) {
        if (rowOf(toolUseId) === undefined) continue;
        held.delete(toolUseId);
        for (const message of messages) ready.push({ toolUseId, message });
      }
      return ready;
    },
    takeAll: () => {
      const all = [...held.values()].flat();
      held.clear();
      return all;
    },
  };
};
