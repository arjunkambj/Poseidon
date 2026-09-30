# Codex's session rollouts

Not a recording, and not written by the CLI: a hand-built `CODEX_HOME` whose
`sessions/` holds three rollouts in the record shapes Codex **0.156.1** writes
— the same shapes 0.159.2's rollouts were read in on 2026-10-01 — beside a
`session_index.jsonl`, for the connector's `sessions` extension
(`packages/connector-codex/src/sessionFiles.test.ts`). The shapes were taken
from real rollouts; no content was. Every prompt and reply here was made up,
and paths are spelled `<HOME>/code/…` and `<TMP>/…` as the scrubber would
spell them.

| File                                    | What it holds                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions/2026/09/20/rollout-…0a.jsonl` | Two turns: `session_meta`, turn context and world state, a developer message, a user message of injected context (plugins, the `AGENTS.md` preambles of `CODEX_HOME` and of the project, `<environment_context>`), reasoning and a tool call, a torn line, a prompt after the desktop app's file list with an image frame, and a two-block reply. |
| `sessions/2026/09/21/rollout-…0b.jsonl` | An older rollout in a second directory: no ordinals, `<user_instructions>` as a message, and the conversation only as `event_msg` `user_message` / `agent_message` copies.                                                                                                                                                                        |
| `sessions/2026/09/22/rollout-…0c.jsonl` | A subagent's rollout, its `source` naming the thread that spawned it: not listed.                                                                                                                                                                                                                                                                 |
| `session_index.jsonl`                   | Two names for the first thread; the last one wins.                                                                                                                                                                                                                                                                                                |

The tests set each file's last write themselves, so the order does not depend
on the checkout. Edit these by hand when the CLI's record shapes change.
