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
  // `turn/steer` exists, but nothing recorded shows it yet (`steering`).
  steering: false,
  // `collaborationMode: plan` on `turn/start`, experimental; no recording yet.
  planMode: false,
  // Codex's collaboration agents are not mapped to Poseidon's tasks.
  subagents: false,
  // A `localImage` user input by path (`image`: the model names a PNG's colour).
  images: true,
  // `thread/resume` against the CLI's own rollout, from a new process
  // (`resume`); a thread it has no rollout for starts afresh (`resume-missing`).
  resume: true,
  // `thread/fork` exists; nothing in Poseidon needs it yet.
  fork: false,
  // `turn/interrupt` stops the running turn and leaves the thread, and the
  // same process answers the next (`interrupt`).
  interrupt: "turn",
  // `thread/revert` exists; Poseidon's checkpoints are git and do not need it.
  rollback: false,
  // `thread/compact/start` exists; nothing recorded shows it yet.
  compaction: false,
  // `item/tool/requestUserInput` exists; nothing recorded shows it yet.
  questions: false,
  // Every mode keeps the approval policy that asks, and varies only the
  // sandbox; each request goes through Poseidon's ladder and card
  // (`edit-approval`: a file change allowed once; `deny`: a command declined;
  // `approval-stop`: Stop and close resolving an open card). The CLI asked
  // about every command on the recording machine, reads included
  // (`sensitive-full-access`: `cat .env` under full access); a known-safe read
  // it runs unasked where its exemption applies is the gap `toolGate.ts`
  // names.
  runtimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  // Images go as `localImage` inputs; any other file is named in the prompt.
  attachments: "files",
};
