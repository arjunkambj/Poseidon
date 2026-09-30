/**
 * What a Codex session can do, as the engine and the renderer read it.
 *
 * Its own module because the definition, the probe and the session all need
 * it. A value here is a promise the session keeps. Each comment says what
 * backs it — the app-server protocol of `PROTOCOL_CLI_VERSION` and the
 * recording that pins it, named even where it is not made yet — and what
 * nothing backs yet stays at the answer that promises least.
 */

import type { ConnectorCapabilities } from "@poseidon/contracts/runtime";

export const CODEX_CAPABILITIES: ConnectorCapabilities = {
  // `turn/start` carries `model` and `effort` of its own, so each turn names
  // what it runs on in the one app-server process (`model-switch`: the second
  // turn on another model at effort low).
  modelSwitch: "per-turn",
  effortSwitch: "per-turn",
  // `turn/steer` into the running turn, which the CLI keeps: one
  // `turn/completed` ends it with both messages answered (`steering`: a steer
  // while `sleep 5` ran, the one answer naming the steered word).
  steering: true,
  // `collaborationMode: plan` on `turn/start` (experimental, asked for in the
  // handshake); the plan item is proposed at the turn's end, and the next
  // turn leaves plan mode (`plan-accept`).
  planMode: true,
  // Codex's collaboration agents are not mapped to Poseidon's tasks.
  subagents: false,
  // A `localImage` user input by path (`image`: the model names a PNG's colour).
  images: true,
  // `thread/resume` against the CLI's own rollout, from a new process
  // (`resume`); a thread it has no rollout for starts afresh (`resume-missing`).
  resume: true,
  // `thread/fork` copies the source thread's rollout into a new thread and
  // leaves the source alone; a fork the CLI refuses fails rather than
  // starting fresh (`fork`: the forked thread names the word the source was
  // told, in a thread of its own).
  fork: true,
  // `turn/interrupt` stops the running turn and leaves the thread, and the
  // same process answers the next (`interrupt`).
  interrupt: "turn",
  // `thread/revert` exists; Poseidon's checkpoints are git and do not need it.
  rollback: false,
  // A `/compact` turn is `thread/compact/start`, run by the CLI as a turn of
  // its own (`compaction`: the contextCompaction row and the smaller context).
  compaction: true,
  // `item/tool/requestUserInput` (experimental, offered in plan mode) is the
  // question card; its answer goes back by option label (`question`).
  questions: true,
  // Every mode keeps the approval policy that asks, and varies only the
  // sandbox; each request goes through Poseidon's ladder and card
  // (`edit-approval`: a file change allowed once; `deny`: a command declined;
  // `approval-stop`: Stop and close resolving an open card). The CLI asked
  // about every command on the recording machine, reads included
  // (`sensitive-full-access`: `cat .env` under full access); a known-safe read
  // it runs unasked where its exemption applies is the gap `toolGate.ts`
  // names. A write the CLI fails to ask about (once, a patch from inside its
  // `exec` tool) meets the read-only sandbox under approval required
  // (`modes.ts`); in the writing modes it lands, and the turn ends with the
  // ungated warning (`turnWrites.ts`).
  runtimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  // Images go as `localImage` inputs; any other file is named in the prompt.
  attachments: "files",
  // `generateText` runs one ephemeral, read-only thread on an app-server of
  // its own, the schema as the turn's `outputSchema` (`generate-text`: a
  // JSON title on the default model at effort low).
  textGeneration: true,
};
