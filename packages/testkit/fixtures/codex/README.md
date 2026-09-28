# Codex recordings

**Every directory here is a real recording of the real Codex CLI.** Nothing in
it is hand-written, reconstructed or synthesized. If the CLI changes, these are
re-recorded — they are never edited by hand to make a test pass.

|             |                                                                         |
| ----------- | ----------------------------------------------------------------------- |
| CLI         | `codex` (the operator's global install), `codex app-server` over stdio  |
| Version     | **0.156.1**                                                             |
| Recorded on | **2026-09-28**, signed in with ChatGPT                                  |
| Model       | the CLI's default (the thread names none); each manifest names what ran |

The transport is `stdio-jsonrpc` (docs/development.md, "The recording format"):
the testkit's stdio tee sat where the connector's binary path points, so each
`invocation-<n>.ndjson` is what the connector and the real app-server said to
each other, line by line, stderr included, and the manifest lists every launch
with its argv and exit. The scrubber replaced the account's email and ids, the
home directory, the scratch root, the temp directory, the host name, and the
names of the operator's own MCP servers and skills (`user-skill-<n>`). The MCP
bearer never reaches a capture: it travels in the child's environment, which
the tee does not write.

Every session was recorded with Poseidon's MCP server pointed at a loopback
port nothing listens on, so each shows it named, tried and failed.

## Scenarios

| Scenario                | Recorded by                                           | What it is                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe`                 | `packages/connector-codex/test/recordProbe.test.ts`   | The connector's probe: `--version`, `login status`, and the zero-turn app-server handshake (`initialize`, `account/read`, `model/list`). No thread starts.                 |
| `plain-reply`           | `packages/connector-codex/test/recordSession.test.ts` | One turn answered "ok": streamed text, token usage and the context window, `completed`.                                                                                    |
| `interrupt`             | `packages/connector-codex/test/recordSession.test.ts` | A counting turn stopped by `turn/interrupt` on its first text, then a one-word follow-up on the same process.                                                              |
| `resume`                | `packages/connector-codex/test/recordSession.test.ts` | Two processes: the first is told to remember a word; the second resumes the thread (`thread/resume`) and names it.                                                         |
| `resume-missing`        | `packages/connector-codex/test/recordSession.test.ts` | A resume of a thread id the CLI has no rollout for: refused, then a new thread (`thread/start`). No turn, so it spent nothing.                                             |
| `model-switch`          | `packages/connector-codex/test/recordSession.test.ts` | Two turns in one process: the default model, then `gpt-6-luna` at effort `low`, named on the second `turn/start`.                                                          |
| `image`                 | `packages/connector-codex/test/recordSession.test.ts` | A 2×2 red PNG as a `localImage` input; the model answers "Red".                                                                                                            |
| `edit-approval`         | `packages/connector-codex/test/recordSession.test.ts` | Approval required: the file change asks (`item/fileChange/requestApproval`), the card is allowed once (`accept`), and `hello.txt` is written.                              |
| `deny`                  | `packages/connector-codex/test/recordSession.test.ts` | Approval required: `touch denied.txt` asks (`item/commandExecution/requestApproval`), the card is denied (`decline`), and the command never runs.                          |
| `sensitive-full-access` | `packages/connector-codex/test/recordSession.test.ts` | Full access, a stand-in `.env` in the repo, prompt `cat .env`: the CLI asked about the read even under full access, and the card was denied.                               |
| `approval-stop`         | `packages/connector-codex/test/recordSession.test.ts` | Two file-change cards left open: the first ended by Stop (the request answered `cancel`, then `turn/interrupt`), the second by closing the session, which answers nothing. |
