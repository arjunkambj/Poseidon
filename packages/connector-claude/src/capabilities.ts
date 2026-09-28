/**
 * What a Claude Code session can do, as the engine and the renderer read it.
 *
 * Its own module because the definition, the probe and the session all need
 * it. A value here is a promise the session keeps. Each comment says what
 * backs it: a recording, or — where the recording needs a signed-in CLI and
 * is not made yet — the SDK's declarations and a reading of the CLI's bundle,
 * with the recording that will pin it named. What neither backs (`fork`,
 * `rollback`) stays at the answer that promises least.
 */

import type { ConnectorCapabilities } from "@poseidon/contracts/runtime";

export const CLAUDE_CAPABILITIES: ConnectorCapabilities = {
  // One process serves the whole session, and the SDK's `setModel` changes
  // the model for the next request without restarting it:
  // `fixtures/claude/session-controls/` has the CLI taking `set_model` for an
  // explicit id, and for none (the default again), in the one process.
  modelSwitch: "in-session",
  // The SDK's `applyFlagSettings({ effortLevel })`, taken the same way in the
  // same recording (`apply_flag_settings`), with no restart.
  effortSwitch: "in-session",
  // `steer` writes one more user message into the running turn, and the turn
  // stays open until the CLI has taken it up (`steering.ts`).
  // `signed-out-steer` has the message written mid-turn and run as the CLI's
  // next turn, inside one Poseidon turn; `steering` is the recording that will
  // show a message folded into a running agent loop; none is made yet. The
  // session announces `false` once the CLI's init shows it sends no receipts
  // (`receiptless-steer`), and refuses a steer until it has shown it does.
  steering: true,
  // Permission mode `plan`, with the plan handed over through ExitPlanMode
  // and raised as the plan card (`interactions.ts`). `plan-accept` is the
  // recording that will show it; none is made yet.
  planMode: true,
  // The Task and Agent tools, their task_* system messages, and the
  // subagent's own messages nested under the task's row
  // (`translate/subagents.ts`). `subagent` is the recording that will show a
  // delegation end to end; none is made yet.
  subagents: true,
  // Native image content blocks in the user message, typed by their bytes
  // (`attachments.ts`). The CLI read an image turn's blocks in
  // `session-controls`; `image` is the recording that will show a model
  // answering from one.
  images: true,
  // `resume: <sessionId>` against the CLI's own transcript.
  resume: true,
  // Nothing recorded forks a session yet.
  fork: false,
  // `Query.interrupt()` stops the running request inside the one long-lived
  // process; nothing recorded yet shows what it leaves behind.
  interrupt: "session",
  // `resumeSessionAt` can rewind the CLI's conversation, but nothing recorded
  // shows it yet. Poseidon's checkpoints are git and do not depend on it.
  rollback: false,
  // A `/compact` user message is the CLI's own command: in
  // `session-controls` it ran as the command — a compaction started, and
  // failed for want of a login — rather than as a prompt.
  compaction: true,
  // AskUserQuestion, answered through the question card as the tool's
  // result. The CLI offers the tool to SDK sessions (recorded `system/init`);
  // `question` is the recording that will show a card answered.
  questions: true,
  // Every mode is enforced by Poseidon's permission ladder through the session's
  // PreToolUse hook, which runs for every tool call in every permission mode.
  runtimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  // Images go as content blocks; any other file goes under the thread's
  // attachments directory, which the session adds to the CLI's readable
  // directories, and is named in the prompt (`attachments.ts`).
  attachments: "files",
  // The SDK's `stopTask` with the CLI's `task_id` for the row
  // (`session.ts`). `subagent-stop` is the recording that will show a
  // subagent stopped mid-turn; none is made yet.
  stopTask: true,
  // `generateText`: one `query()` with one turn, no tools, no settings and no
  // session kept, in a temp directory (`generateText.ts`). Only its refusal is
  // recorded (`generate-text-signed-out`); `generate-text` is the signed-in
  // recording that will show an answer, and none is made yet.
  textGeneration: true,
};
