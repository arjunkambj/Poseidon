/**
 * What a Claude Code session can do, as the engine and the renderer read it.
 *
 * Its own module because the definition, the probe and the session all need
 * it. A value here is a promise the session keeps. Each comment says what
 * backs it: a recording under `fixtures/claude/` — the signed-in ones made on
 * CLI 2.1.286 — or, for ultracode, the SDK's declarations, the CLI's bundle
 * and one live check. What nothing backs (`fork`, `rollback`) stays at the
 * answer that promises least.
 */

import type { ConnectorCapabilities } from "@poseidon/contracts/runtime";

export const CLAUDE_CAPABILITIES: ConnectorCapabilities = {
  // One process serves the whole session, and the SDK's `setModel` changes
  // the model for the next request without restarting it:
  // `session-controls` has the CLI taking `set_model` for an explicit id, and
  // for none (the default again), in the one process; `model-switch` has the
  // next turn answered after it, signed in.
  modelSwitch: "in-session",
  // The SDK's `applyFlagSettings({ effortLevel })`, taken with no restart:
  // `model-switch` switched to low between two answered turns, the session id
  // the same on both sides. The recording shows the call taken, not the
  // effort; the ultracode live check read each new effort back through the
  // CLI's `get_settings`.
  effortSwitch: "in-session",
  // `steer` writes one more user message into the running turn, and the turn
  // stays open until the CLI has taken it up (`steering.ts`). `steering` has
  // the message folded into the running agent loop, answered by the turn's
  // one result; `signed-out-steer` has one run as the CLI's next turn, inside
  // one Poseidon turn. The session announces `false` once the CLI's init shows
  // it sends no receipts (`receiptless-steer`), and refuses a steer until it
  // has shown it does.
  steering: true,
  // Permission mode `plan`, with the plan handed over through ExitPlanMode
  // and raised as the plan card (`interactions.ts`): `plan-accept`, the plan
  // turn stopped at the card and the accepted plan implemented after it.
  planMode: true,
  // The Agent tool (Task, as the init lists it), its task_* system messages,
  // and the subagent's own messages nested under the task's row
  // (`translate/subagents.ts`): `subagent`.
  subagents: true,
  // Native image content blocks in the user message, typed by their bytes
  // (`attachments.ts`): `image` has the model naming a picture's colour with
  // no tool call.
  images: true,
  // `resume: <sessionId>` against the CLI's own transcript: `resume` has the
  // second server's turn recalling what the first was told.
  resume: true,
  // The connector never calls the SDK's `forkSession`, and no recording
  // forks a session.
  fork: false,
  // `Query.interrupt()` stops the running request inside the one long-lived
  // process: `interrupt` has the turn ended and the next message answered by
  // the same process and session.
  interrupt: "session",
  // `resumeSessionAt` can rewind the CLI's conversation, but the connector
  // never calls it and no recording rewinds. Poseidon's checkpoints are git
  // and do not depend on it.
  rollback: false,
  // A `/compact` user message is the CLI's own command: in
  // `session-controls` it ran as the command — a compaction started, and
  // failed for want of a login — rather than as a prompt. A signed-in one
  // costs a summarisation request and waits for the operator's approval.
  compaction: true,
  // AskUserQuestion, answered through the question card as the tool's
  // result: `question`.
  questions: true,
  // Every mode is enforced by Poseidon's permission ladder through the session's
  // PreToolUse hook, which runs for every tool call in every permission mode:
  // `sensitive-full-access` has a hook's `ask` reaching the card under
  // `bypassPermissions`.
  runtimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  // Images go as content blocks; any other file goes under the thread's
  // attachments directory, which the session adds to the CLI's readable
  // directories, and is named in the prompt (`attachments.ts`).
  attachments: "files",
  // The SDK's `stopTask` with the CLI's `task_id` for the row
  // (`session.ts`): `subagent-stop`, the task settled as stopped and the turn
  // going on to its own end.
  stopTask: true,
  // `generateText`: one `query()` with one turn, no tools, no settings and no
  // session kept, in a temp directory (`generateText.ts`): `generate-text`
  // answered, `generate-text-signed-out` refused.
  textGeneration: true,
  // Ultracode — xhigh effort plus standing dynamic-workflow orchestration —
  // as the SDK's `Settings.ultracode`: the inline `settings` at launch and
  // `applyFlagSettings({ effortLevel: "xhigh", ultracode })` mid-session
  // (`flagSettings.ts`). Backed by the SDK 0.3.280 declarations, the CLI
  // bundle, and one live check on a signed-in 2.1.286 whose `get_settings`
  // showed the flag taken both ways; no workflow was run or recorded. Whether
  // the account has workflows, and the model xhigh, is the CLI's to decide.
  ultracode: true,
};
