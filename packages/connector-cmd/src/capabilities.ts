/**
 * What a Command Code session can do, as the engine and the renderer read it.
 *
 * Its own module because both the definition and the session need it, and the
 * session file has no room left to be the place a constant lives.
 */

import type { ConnectorCapabilities } from "@poseidon/contracts/runtime";

export const CMD_CAPABILITIES: ConnectorCapabilities = {
  modelSwitch: "per-turn",
  effortSwitch: "per-turn",
  // One print-mode process per turn: a second message waits for the first.
  steering: false,
  planMode: true,
  subagents: true,
  // Print mode has no image flag; the connector stages the files and names
  // their paths in the prompt instead.
  images: true,
  resume: true,
  // `--session <id> --fork-session`: a new session with the history, the
  // original left as it was (`fixtures/cmd/fork/`).
  fork: true,
  // Stopping signals the one turn's process group; the session outlives it and
  // the next turn resumes the same conversation.
  interrupt: "turn",
  // The harness has no rewind of its own. Poseidon's checkpoints are git.
  rollback: false,
  // The harness compacts by itself; print mode offers no way to ask for it.
  compaction: false,
  // `ask_user_question`, enabled on every turn.
  questions: true,
  // Every mode is enforced by Poseidon's permission engine through the
  // PreToolUse hook, which fires under `--yolo` too.
  runtimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  // Any file can be staged and named by path, not only images.
  attachments: "files",
  // `generateText`: one print-mode process with `--no-session --max-turns 1`
  // and no `--yolo`, in a temp directory (`generateText.ts`,
  // `fixtures/cmd/generate-text/`).
  textGeneration: true,
};
