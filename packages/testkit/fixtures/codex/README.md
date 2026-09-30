# Codex recordings

**Every directory here but `session-files/` is a real recording of the real
Codex CLI.** Nothing in them is hand-written, reconstructed or synthesized. If
the CLI changes, these are re-recorded — they are never edited by hand to make
a test pass.

|             |                                                                         |
| ----------- | ----------------------------------------------------------------------- |
| CLI         | `codex` (the operator's global install), `codex app-server` over stdio  |
| Version     | **0.156.1**; `fork`, `plugin-skill` and `plugins` **0.159.2**           |
| Recorded on | **2026-09-28**; those three **2026-10-01**, signed in with ChatGPT      |
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

A manifest's `recordedOn` is the UTC date, so the three made on the morning of
2026-10-01 in the recording machine's zone say 2026-09-30.

Every session but `mcp-tool-approval` was recorded with Poseidon's MCP server
pointed at a loopback port nothing listens on, so each shows it named, tried
and failed. `mcp-tool-approval` points it at a live loopback endpoint
(`packages/connector-codex/test/mcpStandIn.ts`) — Poseidon's side of the
wire, not the harness's — listing one tool shaped as the gateway lists
`browser_open`.

## Scenarios

| Scenario                | Recorded by                                                          | What it is                                                                                                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe`                 | `packages/connector-codex/test/recordProbe.test.ts`                  | The connector's probe: `--version`, `login status`, and the zero-turn app-server handshake (`initialize`, `account/read`, `model/list`). No thread starts.                                                                                                                         |
| `plain-reply`           | `packages/connector-codex/test/recordSession.test.ts`                | One turn answered "ok": streamed text, token usage and the context window, `completed`.                                                                                                                                                                                            |
| `interrupt`             | `packages/connector-codex/test/recordSession.test.ts`                | A counting turn stopped by `turn/interrupt` on its first text, then a one-word follow-up on the same process.                                                                                                                                                                      |
| `resume`                | `packages/connector-codex/test/recordSession.test.ts`                | Two processes: the first is told to remember a word; the second resumes the thread (`thread/resume`) and names it.                                                                                                                                                                 |
| `fork`                  | `packages/connector-codex/test/recordSession.test.ts`                | Two processes: the first is told to remember a word; the second forks the thread (`thread/fork`) into a new one, which names it. The source's rollout is left as it was.                                                                                                           |
| `resume-missing`        | `packages/connector-codex/test/recordSession.test.ts`                | A resume of a thread id the CLI has no rollout for: refused, then a new thread (`thread/start`). No turn, so it spent nothing.                                                                                                                                                     |
| `model-switch`          | `packages/connector-codex/test/recordSession.test.ts`                | Two turns in one process: the default model, then `gpt-6-luna` at effort `low`, named on the second `turn/start`.                                                                                                                                                                  |
| `ultra-effort`          | `packages/connector-codex/test/recordSession.test.ts`                | One turn on the default model with the thread's effort `ultra`: `turn/start` names `effort: "ultra"`, the CLI restates it in `thread/settings/updated`, and the model answers "ok" without delegating.                                                                             |
| `image`                 | `packages/connector-codex/test/recordSession.test.ts`                | A 2×2 red PNG as a `localImage` input; the model answers "Red".                                                                                                                                                                                                                    |
| `edit-approval`         | `packages/connector-codex/test/recordSession.test.ts`                | Approval required: the file change asks (`item/fileChange/requestApproval`), the card is allowed once (`accept`), and `hello.txt` is written.                                                                                                                                      |
| `deny`                  | `packages/connector-codex/test/recordSession.test.ts`                | Approval required: `touch denied.txt` asks (`item/commandExecution/requestApproval`), the card is denied (`decline`), and the command never runs.                                                                                                                                  |
| `sensitive-full-access` | `packages/connector-codex/test/recordSession.test.ts`                | Full access, a stand-in `.env` in the repo, prompt `cat .env`: the CLI asked about the read even under full access, and the card was denied.                                                                                                                                       |
| `bearer-hidden`         | `packages/connector-codex/test/recordSession.test.ts`                | Full access: the model runs `echo "token=[$POSEIDON_CODEX_MCP_TOKEN]"`, allowed on its card, and it prints `token=[]` — the session's `shell_environment_policy.set` override blanks the MCP bearer's variable in every command.                                                   |
| `approval-stop`         | `packages/connector-codex/test/recordSession.test.ts`                | Two file-change cards left open: the first ended by Stop (the request answered `cancel`, then `turn/interrupt`), the second by closing the session, which answers nothing.                                                                                                         |
| `plan-accept`           | `packages/connector-codex/test/recordInteractions.test.ts`           | A plan turn (`collaborationMode: plan`) hands its plan over as a `plan` item; it is accepted, and the next turn (`collaborationMode: default`) implements it, its file change allowed once.                                                                                        |
| `question`              | `packages/connector-codex/test/recordInteractions.test.ts`           | A plan turn in which the model asks (`item/tool/requestUserInput`); the card is answered with its first option, and the plan names it.                                                                                                                                             |
| `steering`              | `packages/connector-codex/test/recordInteractions.test.ts`           | Full access: `sleep 5; echo one` runs, a message is steered in (`turn/steer`) once the command's row shows, and the one turn's answer ends with the steered word.                                                                                                                  |
| `compaction`            | `packages/connector-codex/test/recordInteractions.test.ts`           | One answered turn, then `/compact` sent as `thread/compact/start`: the CLI's compaction turn, its `contextCompaction` item and the smaller context it leaves.                                                                                                                      |
| `mcp-tool-approval`     | `packages/connector-codex/test/recordInteractions.test.ts`           | Poseidon's MCP server at a live loopback endpoint: the model calls its `browser_open`, the CLI asks with `mcpServer/elicitation/request` (`codex_approval_kind: mcp_tool_call`), the card allows it once, and the call runs.                                                       |
| `plugin-skill`          | `packages/connector-codex/test/recordInteractions.test.ts`           | One Poseidon plugin: its skills directory handed over with `skills/extraRoots/set`, its HTTP MCP server (at a port nothing listens on) in `thread/start`'s config. The turn references the plugin's skill; the model reads its `SKILL.md` on an allowed card and answers its word. |
| `conformance`           | `packages/connector-codex/src/conformance.test.ts`                   | The connector-sdk conformance suite, one app-server launch per case; the approval case's write (the model chose `printf … > conformance.txt`, a command approval) allowed once.                                                                                                    |
| `generate-text`         | `packages/connector-codex/test/recordGenerateText.test.ts`           | `generateText`: its own `app-server` with no MCP override in a temporary directory, an `ephemeral` thread (`read-only` sandbox, approval policy `never`, the system text as `developerInstructions`), one turn at effort `low` with an `outputSchema`; the answer is a JSON title. |
| `plugins`               | `packages/connector-codex/src/extensions/pluginsRecorded.test.ts`    | No session: the plugins extension's `codex plugin list --json` on a scratch `CODEX_HOME` with a local marketplace (in the temp directory, so `<TMP>`) of two plugins installed with the CLI, one then disabled in `config.toml` by hand.                                           |
| `mcp-servers`           | `packages/connector-codex/src/extensions/mcpServersRecorded.test.ts` | No session: the MCP servers extension's `codex mcp list --json`, `add` and `remove` runs on a scratch `CODEX_HOME` seeded with one hand-written server (disabled, literal and variable headers), including the refusals that run no add or remove and a name the CLI rejects.      |

`mcp-servers` and `plugins` send no message to a model and read no account;
their scratch `CODEX_HOME`s hold nothing of the operator's. `generate-text` is no session:
its app-server names no Poseidon MCP server, so only the operator's own start.

`session-files/` is the one directory that is not a recording: it is
hand-built, session rollouts and a session index in the CLI's record shapes
with made-up content, for the connector's sessions extension. It has no
manifest, so `recordingNames` skips it; its own README says how it was made.

## Live check

Besides the recordings, `packages/connector-codex/src/liveConformance.test.ts`
runs against the operator's CLI behind `POSEIDON_LIVE_CODEX=1`
(docs/codex-connector.md, "After a new CLI release"). It was first run on
**2026-09-28** against 0.156.1: all eleven cases passed — the probe, the
schema check of every method the connector uses, the conformance suite, a
plain turn with nothing unmapped, an approval allowed once and a plan turn.
Run again the same day after the review fixes, ten passed and the approval
case timed out once: the model applied its patch through the CLI's `exec`
tool, which wrote the file with no approval request and then hung. Run on its
own, the case passed. Approval required then ran in the `workspace-write`
sandbox; after it moved to `read-only`, the bearer was blanked in commands
and every session was recorded again, the suite ran once more the same day
and all eleven cases passed.

On **2026-10-01** the suite ran against **0.159.2** and all eleven cases
passed on the default model, with the recordings above made on 0.156.1
unchanged: every recorded frame also validates against 0.159.2's own JSON
schema (docs/codex-connector.md, "Releases checked"). A live run that
disagrees with a recording means the recording is stale.
