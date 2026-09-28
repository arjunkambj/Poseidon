# Claude Code recordings

**Every directory here is a real recording of the real Claude Code CLI.**
Nothing in it is hand-written, reconstructed or synthesized. If the CLI changes,
these are re-recorded — they are never edited by hand to make a test pass.

|             |                                                            |
| ----------- | ---------------------------------------------------------- |
| CLI         | `/opt/homebrew/bin/claude` (the operator's global install) |
| Version     | **2.1.280**                                                |
| SDK         | `@anthropic-ai/claude-agent-sdk` **0.3.280**               |
| Recorded on | **2026-09-23**                                             |
| Model       | the CLI's `default` (each manifest names what it ran as)   |

The transport is `sdk-stream` (docs/development.md, "The recording format"):
the testkit's stdio tee sat where the connector's binary path points, so each
`invocation-<n>.ndjson` is what the real SDK and the real CLI said to each
other, line by line, and the manifest lists every launch with its argv and exit.
The scrubber replaced the account, the home directory, the scratch root, the
system temp directory (`<TMP>`, where the CLI's attachment directory and a
probe's working directory live), the MCP bearer and the operator's own agents, and it replaced the handshake's `skills`,
`slash_commands` and `commands` lists, which come from the operator's own
installation, with one `scrubbed-entry` each.

## Scenarios

| Scenario                   | Recorded by                                                                                    | What it is                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `probe`                    | `packages/connector-claude/test/recordProbe.test.ts`                                           | The connector's probe: `--version`, `auth status --json`, and the zero-turn SDK handshake that lists the models. Signed out.                                                                                                                                                                                                                                 |
| `signed-out`               | `packages/connector-claude/test/recordSession.test.ts`                                         | One session and one turn against a CLI that is not signed in: the CLI refuses without calling the API.                                                                                                                                                                                                                                                       |
| `conformance`              | `packages/connector-claude/src/conformance.test.ts`                                            | The connector conformance suite, one session launch per case in the suite's order. Signed out: each turn is refused the same way.                                                                                                                                                                                                                            |
| `signed-out-turn`          | `apps/server/test/e2e-claude/signed-out.test.ts`                                               | One turn through the real server against a signed-out CLI: two probes (boot and the connectors page's refresh), then the session, refused without the API.                                                                                                                                                                                                   |
| `session-controls`         | `packages/connector-claude/test/recordSession.test.ts`                                         | One signed-out session: a refused turn; `set_model` to the explicit id the init named for the default, `apply_flag_settings` effort low; an image turn (content blocks), refused; `/compact`, which ran as the command and failed for the login; `set_model` back to the default.                                                                            |
| `signed-out-steer`         | `packages/connector-claude/test/recordSession.test.ts`                                         | One signed-out turn with a second message steered in after the CLI's `system/init`: the CLI queues it, refuses the first, then runs the steered one as its next turn (its `command_lifecycle` `started` after the first `result`) and refuses it too.                                                                                                        |
| `receiptless-steer`        | `packages/connector-claude/test/recordSession.test.ts` (`POSEIDON_RECORD_CLAUDE_OLDER_BINARY`) | One signed-out turn on the older build **2.1.150**, whose `system/init` has no `capabilities` and which sends no `command_lifecycle` receipts: the connector refuses a steer after the init, so nothing is written mid-turn. The one recording below the oldest tested version, on purpose.                                                                  |
| `local-command`            | `packages/connector-claude/test/recordSession.test.ts`                                         | One signed-out session of the CLI's own slash commands: `/cost`, answered by the CLI itself as a synthetic assistant message; `/permissions`, refused because it only opens a terminal panel; `/clear`, which sends `conversation_reset` and moves the CLI to a new session id; `/cost` again. None makes a request.                                         |
| `generate-text-signed-out` | `packages/connector-claude/test/recordSession.test.ts`                                         | One `generateText` call (a thread title) signed out: the one-shot options as the SDK spells them — `--max-turns 1`, `--tools ""`, `--setting-sources=`, `--strict-mcp-config`, `--no-session-persistence`, `--effort low`, the system prompt in `initialize` — a `system/init` with no tools and no MCP servers, and the sign-in refusal as an error result. |

Everything above was recorded while the CLI on the recording machine was signed
out, so none of it spent anything. A compaction of a real conversation costs a
summarisation request, so a signed-in `/compact` is recorded only with the
operator's approval; `session-controls` shows the command's path without one.

## Waiting for a signed-in CLI

These scenarios have their tests and recorders in place, and are skipped under
replay — the skip says so in its title — until they are recorded:

| Scenario                | Test                                                   | What it will show                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plain-reply`           | `apps/server/test/e2e-claude/turn.test.ts`             | One answered turn: streamed text, usage, `end_turn`. Also replayed by `recordedSession.test.ts`.                                                                   |
| `interrupt`             | `apps/server/test/e2e-claude/interrupt.test.ts`        | A turn interrupted after its first text, then a follow-up: whether the same process serves the next.                                                               |
| `resume`                | `apps/server/test/e2e-claude/resume.test.ts`           | Two turns with the server restarted between: the second session launch is `--resume`.                                                                              |
| `edit-approval`         | `apps/server/test/e2e-claude/approval.test.ts`         | Approval-required: a write to `hello.txt` asked about, allowed once, written after. Also `recordedSession.test.ts`.                                                |
| `deny`                  | `apps/server/test/e2e-claude/approval.test.ts`         | Approval-required: `touch denied.txt` denied at every card; the file is absent. Also `recordedSession.test.ts`.                                                    |
| `sensitive-full-access` | `apps/server/test/e2e-claude/approval.test.ts`         | Full access (`bypassPermissions`): `cat .env` still opens a card, which is denied. Also `recordedSession.test.ts`.                                                 |
| `plan-accept`           | `apps/server/test/e2e-claude/plan.test.ts`             | A plan turn stopped at ExitPlanMode with the plan card, then accepted and implemented out of plan mode. Also `recordedSession.test.ts`.                            |
| `question`              | `apps/server/test/e2e-claude/question.test.ts`         | AskUserQuestion as a question card, answered with its first option, and the colour written to `colour.txt`. Also `recordedSession.test.ts`.                        |
| `subagent`              | `apps/server/test/e2e-claude/subagent.test.ts`         | Full access: a Task delegation to a general-purpose agent listing the files, its rows nested under the task row. Also `recordedSession.test.ts`.                   |
| `subagent-stop`         | `apps/server/test/e2e-claude/subagent-stop.test.ts`    | Full access: a Task delegation of `sleep 60`, stopped once its row runs; the row settles as failed and the turn ends on its own.                                   |
| `model-switch`          | `apps/server/test/e2e-claude/model.test.ts`            | Two turns, the model switched to the default's explicit id and the effort to low between them, in the one process.                                                 |
| `image`                 | `apps/server/test/e2e-claude/attachment.test.ts`       | A 2×2 red PNG sent as an image content block; the model names its colour.                                                                                          |
| `steering`              | `apps/server/test/e2e-claude/steering.test.ts`         | Full access: `sleep 5; echo one`, a message steered in once the command's row shows, and one turn whose answer ends with "banana". Also `recordedSession.test.ts`. |
| `generate-text`         | `packages/connector-claude/test/recordSession.test.ts` | One `generateText` call answered: the text on the `result`, one turn, no tools.                                                                                    |

Record them, once `claude auth status` says `loggedIn: true` in the operator's
own shell, with:

    POSEIDON_RECORD_CLAUDE=1 pnpm -F server exec vitest run test/e2e-claude/turn.test.ts test/e2e-claude/interrupt.test.ts test/e2e-claude/resume.test.ts test/e2e-claude/approval.test.ts test/e2e-claude/plan.test.ts test/e2e-claude/question.test.ts test/e2e-claude/subagent.test.ts test/e2e-claude/subagent-stop.test.ts test/e2e-claude/model.test.ts test/e2e-claude/attachment.test.ts test/e2e-claude/steering.test.ts

and re-record `conformance` signed in the same way from its own file, so the
suite's turns are answered ones. That recording also takes the suite's
approval case (a file write stopped on a card and allowed once), which the
replay runs only once the recording has it.

`plugins/` is the one directory that is not a recording: it holds the config
files the real CLI wrote while installing two plugins into a scratch config
directory, for the connector's plugins extension. It has no manifest, so
`recordingNames` skips it; its own README says how it was made.
