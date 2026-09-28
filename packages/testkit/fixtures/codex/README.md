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

| Scenario                | Recorded by                                                          | What it is                                                                                                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe`                 | `packages/connector-codex/test/recordProbe.test.ts`                  | The connector's probe: `--version`, `login status`, and the zero-turn app-server handshake (`initialize`, `account/read`, `model/list`). No thread starts.                                                                                                                    |
| `plain-reply`           | `packages/connector-codex/test/recordSession.test.ts`                | One turn answered "ok": streamed text, token usage and the context window, `completed`.                                                                                                                                                                                       |
| `interrupt`             | `packages/connector-codex/test/recordSession.test.ts`                | A counting turn stopped by `turn/interrupt` on its first text, then a one-word follow-up on the same process.                                                                                                                                                                 |
| `resume`                | `packages/connector-codex/test/recordSession.test.ts`                | Two processes: the first is told to remember a word; the second resumes the thread (`thread/resume`) and names it.                                                                                                                                                            |
| `resume-missing`        | `packages/connector-codex/test/recordSession.test.ts`                | A resume of a thread id the CLI has no rollout for: refused, then a new thread (`thread/start`). No turn, so it spent nothing.                                                                                                                                                |
| `model-switch`          | `packages/connector-codex/test/recordSession.test.ts`                | Two turns in one process: the default model, then `gpt-6-luna` at effort `low`, named on the second `turn/start`.                                                                                                                                                             |
| `image`                 | `packages/connector-codex/test/recordSession.test.ts`                | A 2×2 red PNG as a `localImage` input; the model answers "Red".                                                                                                                                                                                                               |
| `edit-approval`         | `packages/connector-codex/test/recordSession.test.ts`                | Approval required: the file change asks (`item/fileChange/requestApproval`), the card is allowed once (`accept`), and `hello.txt` is written.                                                                                                                                 |
| `deny`                  | `packages/connector-codex/test/recordSession.test.ts`                | Approval required: `touch denied.txt` asks (`item/commandExecution/requestApproval`), the card is denied (`decline`), and the command never runs.                                                                                                                             |
| `sensitive-full-access` | `packages/connector-codex/test/recordSession.test.ts`                | Full access, a stand-in `.env` in the repo, prompt `cat .env`: the CLI asked about the read even under full access, and the card was denied.                                                                                                                                  |
| `approval-stop`         | `packages/connector-codex/test/recordSession.test.ts`                | Two file-change cards left open: the first ended by Stop (the request answered `cancel`, then `turn/interrupt`), the second by closing the session, which answers nothing.                                                                                                    |
| `plan-accept`           | `packages/connector-codex/test/recordInteractions.test.ts`           | A plan turn (`collaborationMode: plan`) hands its plan over as a `plan` item; it is accepted, and the next turn (`collaborationMode: default`) implements it, its command allowed once.                                                                                       |
| `question`              | `packages/connector-codex/test/recordInteractions.test.ts`           | A plan turn in which the model asks (`item/tool/requestUserInput`); the card is answered with its first option, and the plan names it.                                                                                                                                        |
| `steering`              | `packages/connector-codex/test/recordInteractions.test.ts`           | Full access: `sleep 5; echo one` runs, a message is steered in (`turn/steer`) once the command's row shows, and the one turn's answer ends with the steered word.                                                                                                             |
| `compaction`            | `packages/connector-codex/test/recordInteractions.test.ts`           | One answered turn, then `/compact` sent as `thread/compact/start`: the CLI's compaction turn, its `contextCompaction` item and the smaller context it leaves.                                                                                                                 |
| `conformance`           | `packages/connector-codex/src/conformance.test.ts`                   | The connector-sdk conformance suite, one app-server launch per case; the approval case's write (the model chose `printf … > conformance.txt`, a command approval) allowed once.                                                                                               |
| `mcp-servers`           | `packages/connector-codex/src/extensions/mcpServersRecorded.test.ts` | No session: the MCP servers extension's `codex mcp list --json`, `add` and `remove` runs on a scratch `CODEX_HOME` seeded with one hand-written server (disabled, literal and variable headers), including the refusals that run no add or remove and a name the CLI rejects. |

`mcp-servers` sends no message to a model and reads no account; its scratch
`CODEX_HOME` holds nothing of the operator's.

## Live check

Besides the recordings, `packages/connector-codex/src/liveConformance.test.ts`
runs against the operator's CLI behind `POSEIDON_LIVE_CODEX=1`
(docs/codex-connector.md, "After a new CLI release"). It was last run on
**2026-09-28** against 0.156.1: all eleven cases passed — the probe, the
schema check of every method the connector uses, the conformance suite, a
plain turn with nothing unmapped, an approval allowed once and a plan turn.
A live run that disagrees with a recording means the recording is stale.
