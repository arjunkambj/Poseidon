# Claude Code connector reference

Poseidon's second connector drives the Claude Code CLI, spelled `claude`,
through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). This document
describes how the connector finds that binary, what it starts and with what
environment, what comes back and how it is read, how every tool call reaches
Poseidon's approval gate, and what to check when the CLI changes.

Everything here is read off the code as it stands and off the recordings under
`packages/testkit/fixtures/claude/`. Those are captures of the real CLI at its
stdio boundary: each line the SDK wrote to the CLI and each line the CLI wrote
back, in order, with every launch's argv and exit. In the shared recording
format they are the `claude` kind over the `sdk-stream` transport
([development.md](development.md#sdk-stream)). Where a claim rests on a
recording, the recording is named.

The recordings made so far were all made while the CLI on the recording
machine was signed out. So they show the launch, the handshake, the control
requests, the message receipts and the CLI's refusals exactly, but no model
answer, tool call, plan, question or subagent. The scenarios that will show
those are written and wait for a signed-in CLI
(`packages/testkit/fixtures/claude/README.md` lists them, and
[Needs a signed-in run](#needs-a-signed-in-run) lists everything that waits,
with the commands). Where a claim about
that half rests on the SDK's declarations or on reading the CLI's own bundled
code instead of a recording, this document says so, and names the recording
that will pin it. Until those exist their replays are skipped in the gate
under titles that say so, and so is the conformance suite's approval case:
Claude Code can be made to ask on demand, so that case is owed, not optional
([philosophy.md](philosophy.md#4-a-connectors-promises-are-executable)).

Its companions: [architecture.md](architecture.md#the-claude-code-connector)
for the shape of the connector inside Poseidon,
[how-it-works.md](how-it-works.md) for what the rest of the app does with what
comes back, and [development.md](development.md#the-claude-code-end-to-end-suite)
for the commands that run and record it.

## Where the code is

The connector is `packages/connector-claude`. It implements the
`ConnectorDefinition` interface of `packages/connector-sdk`, and
`apps/server/src/boot.ts` registers it after Command Code, so a fresh install
routes new threads to Command Code until the user picks this instance.

| module                    | what it owns                                                              |
| ------------------------- | ------------------------------------------------------------------------- |
| `definition.ts`           | the `ConnectorDefinition`: probe, instance, start and resume, models      |
| `configSchema.ts`         | `binaryPath`, `configDir`, `defaultModel`, and the settings form          |
| `binary.ts`               | which executable `claude` means, and how to spell a command for the user  |
| `env.ts`                  | the default-deny child environment                                        |
| `probe.ts`                | `--version`, `auth status --json`, the zero-turn handshake, version floor |
| `models.ts`               | the CLI's model rows and their effort ladders                             |
| `commands.ts`             | the CLI's own slash commands, for the composer's `/` menu                 |
| `capabilities.ts`         | what a Claude Code session can do, and why                                |
| `spawn.ts`                | the SDK's `spawnClaudeCodeProcess`: a process group, and proof it is gone |
| `queryOptions.ts`         | the SDK options a session starts with; runtime mode → permission mode     |
| `inputQueue.ts`           | the streaming-input prompt the session writes user messages to            |
| `userMessage.ts`          | one composer turn as the user message the CLI reads                       |
| `attachments.ts`          | images as content blocks, other files by path                             |
| `session.ts`              | one long-lived CLI process per thread: send, steer, interrupt, close      |
| `sessionRef.ts`           | the persisted session reference                                           |
| `toolGate.ts`             | the PreToolUse hook and `canUseTool`, both through the permission ladder  |
| `approvals.ts`            | the CLI's tool names in Poseidon's approval vocabulary                    |
| `interactions.ts`         | the question and plan cards AskUserQuestion and ExitPlanMode open         |
| `questions.ts`            | AskUserQuestion's input and the answer it takes back                      |
| `plans.ts`                | the plan ExitPlanMode hands over, and the CLI's plan file                 |
| `steering.ts`             | when a steered turn is over, and its summed usage                         |
| `translate/`              | SDK messages → `RuntimeEvent`s                                            |
| `translate/tools.ts`      | the tool rows                                                             |
| `translate/subagents.ts`  | tasks, and the rows nested under them                                     |
| `translate/compaction.ts` | the compaction row                                                        |
| `translate/notices.ts`    | the CLI's notices: warnings, and the ones left out on purpose             |
| `translate/result.ts`     | a `result` → usage, context and the turn's completion                     |

The package may import `connector-sdk`, `contracts` and `shared`; its tests
also import `testkit`. Nothing else in the tree names `claude`, apart from the
registration line in `boot.ts` and tests.

## Finding the binary

`resolveBinary` in `binary.ts` answers in this order:

1. the configured `binaryPath`, when it is set and not empty, taken as given —
   the probe's `--version` is what finds out whether it runs;
2. `claude` in each `PATH` entry;
3. `claude` in the directories the CLI's installers use, which a GUI process
   never inherits on its `PATH`: `/opt/homebrew/bin`, `/usr/local/bin`,
   `~/.local/bin`, `~/.claude/local`, `~/.npm-global/bin`,
   `~/.local/share/pnpm`, `~/Library/pnpm` and `~/.bun/bin`.

A candidate counts only when it is a regular file with the execute bit set.
There is no fallback to a package runner: the SDK is always handed the
resolved path as `pathToClaudeCodeExecutable`, and never runs a copy of the
CLI of its own. The SDK's per-platform CLI builds are listed under pnpm's
`ignoredOptionalDependencies` and are not installed.

Resolution is redone per session start and per probe, so an install that
appears later is found. `terminalCommand` spells a command for the user's own
terminal — the login command, for one — with the resolved binary's full path,
prefixed with `CLAUDE_CONFIG_DIR=…` when the instance has an account of its
own.

## Version policy

The connector runs whatever is installed. The CLI updates itself, and the
harness is the user's. `OLDEST_TESTED_VERSION` in `probe.ts` is the release the
recordings were made at, **2.1.280**. Below it the probe adds a warning; at or
above it, it says nothing; a version string that does not parse is not
refused. The floor moves only when the recordings are made again on a newer
release, and `recordedFrames.test.ts` fails if any recording's manifest names a
CLI older than it.

The SDK is pinned in `package.json` (**0.3.280**), because its launch argv and
control protocol are what the recordings replay. Every manifest records the
SDK version beside the CLI's.

## Config

`ClaudeConnectorConfig` (`configSchema.ts`) is what an instance's
`settings.connectors[].config` holds. Its `settingsForm` annotations are the
form the connectors page renders, served over `connectors.describe`.

| field          | meaning                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------- |
| `binaryPath`   | overrides discovery. Empty uses the discovered `claude`.                                 |
| `configDir`    | `CLAUDE_CONFIG_DIR` for this instance: a separate Claude account. `~` is expanded.       |
| `defaultModel` | the model a new thread on this instance starts with, when the app-wide default is unset. |

`HOME` is never changed. On macOS the CLI finds its subscription login in the
keychain under `HOME`, so moving it signs the child out; a second account is a
second config directory instead. A `configDir` outside `~/.claude` is not among
the permission ladder's sensitive paths yet.

## The probe

`probe` in `probe.ts` asks three questions of the binary a session would run,
under the environment a session would get (`env.ts`), from the system temp
directory. `fixtures/claude/probe/` is the probe recorded.

1. **`claude --version`** prints `2.1.280 (Claude Code)`. A non-zero exit or
   an unparsable answer is status `error`, with the CLI's own output as the
   message.
2. **`claude auth status --json`** prints a document with `loggedIn`,
   `authMethod`, `apiProvider`, and the account's email once signed in.
   Signed out it prints `loggedIn: false`, `authMethod: "none"` **and exits
   1**, so the output is read whatever the exit code. `loggedIn` true is
   `auth: present` and status `ready`; false is `absent`, status
   `not-authenticated`, and the message `not signed in — run <loginCommand>`,
   where `loginCommand` is `claude auth login` spelled by `terminalCommand`.
3. **The initialize handshake**, which is the only place the model list
   comes from. `readInitialization` starts a `query()` whose prompt never
   yields, with `settingSources: []` and `persistSession: false`, so none of
   the user's settings is loaded and nothing is written. It reads the
   initialize response and stops the CLI's process group again. The argv is
   the SDK's stream-json set plus `--setting-sources=` and
   `--no-session-persistence`, and the recorded launch ends in SIGTERM
   (exit 143), which is the stop. No message is sent, so the handshake costs
   nothing, signed in or out. It gives up after 20 seconds, and a handshake
   that fails is a warning on the probe rather than a failed probe.

The initialize response carries `models`, `account`, the commands, agents
and output styles, and the current permission mode. `models` is the CLI's own
list for this account. Its first row is `default`, whose description names
the model it currently stands for, and each row has a `value`, a
`displayName`, a `resolvedModel` and, when the model takes one, its
`supportedEffortLevels` (`low` to `max` in the recording; one row has none).
`toModelOptions` (`models.ts`) keeps every row, labels it with its display
name, groups it under "Claude", and keeps the effort rungs Poseidon's ladder
knows. `listModels` runs the same handshake once per instance and caches the
result, so the model picker does not start a CLI every time it opens.

`commands` is the CLI's slash commands (the SDK's `SlashCommand`: `name`,
`description`, `argumentHint`, and `builtin` on Claude Code's own ones). The
instance's `commands` extension answers them through `connectors.commands.list`
from the same cached handshake as the models: one CLI start per instance for
both, and asks that arrive together wait for the one in flight. A failed
handshake is not cached and answers `ConnectorExtensionFailed` with code
`internal`. `toHarnessCommands` (`commands.ts`) strips a leading `/`, leaves out
an empty description or argument hint, and keeps one row per name: the built-in
one when a row is marked, otherwise the first. Because the handshake runs with
`settingSources: []`, the list holds only the CLI's built-in and bundled
commands. The user's and the project's own commands (`.claude/commands`,
plugins, MCP prompts) are not listed, though the CLI still runs them when a
message names one. For the same reason the list does not depend on the
project, so the extension ignores its scope. The recorder scrubs the command
list down to one `scrubbed-entry` row, so the replayed tests
(`definition.test.ts`, `models.test.ts`) assert on that row, and the mapping is
unit-tested on the SDK's declared fields (`commands.test.ts`).

The account comes from `auth status` first and from the initialize response's
`account.email` otherwise. The recorded, signed-out response says only
`tokenSource: "none"`.

## The child environment

`childEnv` (`env.ts`) builds the child's environment from nothing. The SDK's
`env` option replaces the child's environment outright, so what `childEnv`
returns is all the CLI sees:

- **kept by name:** `HOME`, `PATH`, `USER`, `SHELL`, `LANG`, `TERM`, `TMPDIR`,
  `SSH_AUTH_SOCK`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`,
  `NODE_EXTRA_CA_CERTS`;
- **kept by prefix:** `LC_*`;
- **dropped by name and prefix, whatever the list above says:** `CLAUDECODE`,
  `CLAUDE_CONFIG_DIR`, and every `CLAUDE_CODE_*`, `CLAUDE_AGENT_SDK_*`,
  `ANTHROPIC_*` and `POSEIDON_SERVER_*`;
- **added:** `CLAUDE_CONFIG_DIR` from the instance's `configDir`.

Dropping by name matters because Poseidon can itself be started from inside a
Claude Code session. Such a process carries `CLAUDECODE`, a few dozen
`CLAUDE_CODE_*` variables — the parent session's id, its OAuth scopes, a
messaging socket and its token among them — `CLAUDE_AGENT_SDK_VERSION`, and
`ANTHROPIC_BASE_URL`. If they were passed on, the child would believe it is a
subprocess of that session, talk to the parent's socket, or send its API
traffic wherever the parent's base URL points. An inherited
`CLAUDE_CONFIG_DIR` is dropped too, because which account a session uses is
the instance's setting, not the shell's.

On top of that environment the SDK adds its own two entry-point variables,
`CLAUDE_AGENT_SDK_VERSION` and `CLAUDE_CODE_ENTRYPOINT=sdk-ts`.
`env.test.ts` checks this through the real SDK: a fake parent session's
variables go in, and the child sees only the allowlist and those two.

## The launch

`buildQueryOptions` (`queryOptions.ts`) is the whole of a session's SDK
options:

| option                            | value                                                               |
| --------------------------------- | ------------------------------------------------------------------- |
| `pathToClaudeCodeExecutable`      | the resolved binary                                                 |
| `spawnClaudeCodeProcess`          | `spawn.ts`'s, so the CLI leads a process group of its own           |
| `env`                             | `childEnv`                                                          |
| `cwd`                             | the thread's workspace root                                         |
| `sessionId` / `resume`            | a fresh id we mint, or the ref's id to resume                       |
| `settingSources`                  | `user`, `project`, `local`                                          |
| `systemPrompt`                    | the CLI's own preset (`claude_code`)                                |
| `includePartialMessages`          | true: text and thinking stream as deltas                            |
| `forwardSubagentText`             | true: a subagent's text arrives, not only its tool calls            |
| `permissionMode`                  | from the thread's modes (see [Runtime modes](#runtime-modes))       |
| `allowDangerouslySkipPermissions` | true, which the SDK requires before `bypassPermissions` can be used |
| `model`, `effort`                 | the thread's, left out for `default` and for `minimal` effort       |
| `mcpServers`                      | `poseidon`, over HTTP, with the per-thread bearer                   |
| `additionalDirectories`           | the thread's attachments directory                                  |
| `hooks`                           | one PreToolUse callback, for every tool                             |
| `canUseTool`                      | the approval gate                                                   |
| `maxTurns`, `maxBudgetUsd`        | only when a test or recording sets them; production sets neither    |

That becomes this argv (`fixtures/claude/signed-out-steer/`, bearer and paths
scrubbed):

```
--output-format stream-json --verbose --input-format stream-json
--max-turns 1 --max-budget-usd 0.05
--permission-prompt-tool stdio
--mcp-config {"mcpServers":{"poseidon":{"type":"http","url":"…/mcp","headers":{"Authorization":"<REDACTED>"}}}}
--setting-sources=user,project,local
--permission-mode default --allow-dangerously-skip-permissions
--include-partial-messages
--add-dir <attachments dir>
--session-id=<uuid>
```

The hooks and `forwardSubagentText` travel in the SDK's `initialize` control
request instead, as `hooks.PreToolUse[0].hookCallbackIds: ["hook_0"]`.

**The user's harness.** `settingSources` user, project and local load the
user's `CLAUDE.md`, skills, MCP servers, hooks and permission rules, as the
CLI would in a terminal. That is intended: the harness is the user's.
Poseidon's hook still decides every call first (below). The connector writes
nothing into the CLI's settings files, and allow-always is Poseidon's rule
alone.

**Our MCP entry.** Poseidon's MCP gateway is added as `poseidon`, an HTTP server
at the per-thread endpoint with `Authorization: Bearer <token>`. The SDK hands
the CLI its MCP configuration on the command line, so **the bearer is in the
CLI's argv and visible to `ps` on the machine** for as long as the session
runs. It is minted per session and revoked with it, and the recorder scrubs
it. `system/init` reports the server's status. In the recordings it is
`failed` with source `dynamic`, because the connector's tests point it at a
port nothing listens on.

**The process.** `spawn.ts` starts the CLI `detached`, so it leads its own
process group, and sends every signal to the whole group, which is the only
way a Bash tool's grandchildren go with it. `stop` sends SIGTERM, waits for
the leader, escalates to SIGKILL after a grace period, and sweeps whatever is
left. `isGone`, a signal 0 to the group failing with ESRCH, is the proof
`close` rests on. A group seen gone is never signalled again — not by `stop`,
the SDK's own kill, nor the SDK's abort about two seconds after `close` —
since its pid is free for the kernel to hand to an unrelated process; a group
whose leader exited but whose members remain is still signalled, as its id
cannot be reused while they live. The CLI's stderr is drained there and its tail kept, since
an exit nobody asked for is explained by nothing else. A session whose CLI
closes its stdin normally exits 0 (`session-controls`).

## One session, one process

`startSession` starts `query()` in streaming-input mode. Its prompt is the
session's input queue (`inputQueue.ts`), and each turn is one more user
message written to the same CLI. The session waits for the initialize
handshake before it returns, so a CLI that cannot start, or no longer has the
conversation a resume names, fails `startSession` with `SpawnFailed` rather
than leaving a thread that never answers. It then emits `session.started`, its
ref naming the session id, and once more after every turn with the updated
ref.

`send` fails with `TurnInProgress` while a turn runs, which is when the caller
queues the message or steers it (see [Steering](#steering-and-turn-accounting)).
Otherwise it opens a turn, stages the attachments, sets the CLI's permission
mode if the turn needs another one, and writes the message.

The user message (`userMessage.ts`) carries a uuid the session mints, which
the CLI's receipts name it by. Its text is the composer's text, then each
mention as `@path`, then one line per non-image attachment. A turn with no
images is sent as a plain string. A turn with images is sent as content
blocks, images first and the text last, because the CLI reads a message as a
slash command only when its last block is text.

A CLI that stops while the session is open is a crash: a fatal
`runtime.error` naming the last stderr line, then
`session.ended { reason: "crashed" }`, which the supervisor resumes from.

## The message catalogue

The SDK yields the CLI's stdout lines, minus the control traffic it answers
itself (`control_request`, `control_response`, `control_cancel_request`,
`keep_alive`, `transcript_mirror`). One translator per session
(`translate/translator.ts`) reads them:

| SDK message                                                                 | `RuntimeEvent`                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `stream_event` text and thinking deltas                                     | `content.delta` on an `assistant_message` or `reasoning` row the block opens          |
| other `stream_event`s (block and message bounds)                            | nothing: the snapshot restates them                                                   |
| `assistant` snapshot                                                        | the finished text and reasoning rows, and a row per `tool_use` block                  |
| `assistant` snapshot with `error`                                           | `runtime.error` with the CLI's line; fatal, naming the login command, when signed out |
| `user` message of `tool_result` blocks                                      | settles the rows the calls opened                                                     |
| `system/init`                                                               | `mcp.status.updated`; the model it names is kept for the context window               |
| `system/status: requesting`                                                 | nothing: a request is on its way, and the deltas say so again                         |
| `system/status` with only a `permissionMode`                                | nothing: the session reads the CLI's mode off it                                      |
| `system/status: compacting`, `compact_boundary`                             | a `context_compaction` row, opened and settled, and `context.updated`                 |
| `system/status: null` with `compact_result: failed`                         | the compaction row, failed                                                            |
| `system/task_started`, `task_progress`, `task_updated`, `task_notification` | `task.updated`, then `task.completed`                                                 |
| any message with `parent_tool_use_id`                                       | read like the main loop's, every row nested under the task (`parentItemId`)           |
| `command_lifecycle`                                                         | nothing on the stream: the session reads it for steering                              |
| `conversation_reset` (`/clear`)                                             | nothing on the stream: the ref follows the session id the next `system/init` names    |
| `system/api_retry`, `model_refusal_fallback`, `model_refusal_no_fallback`   | `session.warning`: the retry and its reason, or the CLI's line on the refusal         |
| `system/informational` (warning, suggestion, notice), high `notification`   | `session.warning` with the CLI's text; lower levels nothing                           |
| `rate_limit_event`                                                          | `session.warning` when the status becomes close to or over the limit, once per change |
| `system/local_command_output`                                               | a completed `assistant_message` row with the command's output                         |
| progress and bookkeeping notices (`translate/notices.ts` lists each)        | nothing, each with its reason                                                         |
| `result`                                                                    | `usage.updated`, `context.updated`, `turn.completed`                                  |
| anything else                                                               | `event.unmapped`, kept whole, raw source `claude.sdk`                                 |

`system/init` is not reported as `model.changed`. The CLI names the model a
choice resolved to (`default` runs as a dated id), and the thread keeps the id
the user picked.

A text or thinking row is opened by its block's `content_block_start` and
completed by the snapshot's matching block (`translate/textRows.ts`). A
thinking block can come back with its text left out and only a signature
kept. Its row is still completed, with no text. A row still open when the
turn's `result` arrives is completed there with the text its deltas grew, so
none stays in progress after the turn.

**A `result`** (`translate/result.ts`) is the end of one of the CLI's turns.
Its `usage` is the main loop's tokens for that turn alone. `total_cost_usd`
and `modelUsage` are running totals for the process, which for a resumed
session start from what its transcript saved. So the turn's cost is the
difference from the previous result's total, which the ref carries across
restarts; a total lower than the previous one was reset by a `/clear`, and is
the turn's cost by itself. The stop reason is `interrupted` when the user
stopped the turn, `max_turns` for `error_max_turns`, `end_turn` for a
`success` that is not `is_error`, and `error` otherwise. The context window is
`modelUsage`'s entry for the running model.

**Signed out** (`fixtures/claude/signed-out/`): the CLI does not call the
API. For each message it writes an `assistant` snapshot whose model is
`<synthetic>`, whose `error` is `authentication_failed`, and whose text is
`Not logged in · Please run /login`, then a `result` with subtype `success`
**and `is_error: true`**, `terminal_reason: "api_error"` and a cost of 0. The
translator makes that a fatal `runtime.error` naming `claude auth login`, as
Command Code's exit 3 is. A fatal error is a row on the timeline, and nothing
the thread sends will work until the user signs in. Other failed requests stay
non-fatal, because the next message may well work.

None of the notices is in a recording yet: each needs a signed-in CLI that
retries, refuses or nears a limit, so their reading rests on the SDK's
declarations (`translate/notices.test.ts`). A refused answer that a fallback
model replaced stays on the timeline, since the contract has no event that
takes a row back.

`recordedFrames.test.ts` feeds every recorded session through the translator
and fails on any `event.unmapped`. Its allowlist of frames left unmapped on
purpose is empty.

## The tool vocabulary

`tool_use` blocks open rows keyed by their id, and the `tool_result` in the
CLI's next `user` message settles them; `is_error` fails the row, which is how
a refused call reads. `tool_use_result`, the tool's own structured output next
to the text the model sees, supplies an edit's patch and a write's
create-or-update.

| Tool                                                 | Row                                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Bash                                                 | `command_execution`: the command, its output, the exit code from the CLI's `Exit code N` line |
| Edit, MultiEdit, NotebookEdit                        | `file_change`, an edit, diff from `structuredPatch`                                           |
| Write                                                | `file_change`, create or edit as the result says, and its diff                                |
| WebFetch, WebSearch                                  | `web_search`                                                                                  |
| `mcp__<server>__<tool>`                              | `mcp_tool_call`, naming the server                                                            |
| TodoWrite                                            | `todo`, the model's checklist                                                                 |
| Skill                                                | `skill`                                                                                       |
| Task, Agent                                          | `task`                                                                                        |
| ExitPlanMode, EnterPlanMode                          | `plan`                                                                                        |
| Read, Glob, Grep, LS, AskUserQuestion, anything else | `tool_call`                                                                                   |

A finished row never goes back to running. Output is cut at 64KB. Rows still
open when the turn's `result` arrives are failed there, so none spins under an
idle thread.

CLI 2.1.280's `system/init` tool list is `Task`, `AskUserQuestion`, `Bash`,
`Edit`, `EnterPlanMode`, `ExitPlanMode`, `NotebookEdit`, `Read`, `Skill`,
`WebFetch`, `WebSearch`, `Write` and a handful of the CLI's own
(scheduling, worktrees, messaging, monitoring). It lists no `Glob`, `Grep`,
`LS`, `MultiEdit` or `TodoWrite`. They stay in the tables because older
releases and other accounts have offered them, and a row costs nothing.

## Approvals

### The gate

```
model calls a tool
   │
   ▼
the CLI calls the SDK's PreToolUse hook, in-process   (every call, every mode)
   │     toolGate.ts: permissions.decide(...), never waiting for the user
   ├─ allow  → { permissionDecision: "allow" }   the call runs
   ├─ deny   → { permissionDecision: "deny" }    the model is told it was refused
   └─ prompt → { permissionDecision: "ask" }
                 │  the CLI hands the call to canUseTool, decision made
                 ▼
               canUseTool → the shared approval gate → the card
                 → { behavior: "allow" | "deny" }
```

The SDK offers two ways in, and neither is enough alone:

- **`canUseTool`** is asked only when the CLI itself would prompt. Calls its
  own rules already allow — reads, the user's `~/.claude` allow list,
  everything under `bypassPermissions` — never reach it. A ladder that says
  "ask" for one of those would be skipped, and "ask outranks allow"
  ([philosophy.md](philosophy.md)) would not hold.
- **A PreToolUse hook** runs for every call, in every permission mode, and
  a hook's `ask` is handed to `canUseTool` with the decision already made.

So the hook asks the ladder about every call and answers with its verdict,
and `canUseTool` runs the shared approval gate (`makeApprovalGate`), which
asks the ladder again — the same answer — and opens the card. The hook never
waits for the user, so no hook timeout can decide a call. Both fail closed: a
hook that cannot reach a verdict answers `ask`, and a `canUseTool` that
cannot answer answers `deny`.

That the CLI does not consult its mode or its allow rules again once a hook
said `ask` comes from reading the permission code bundled in CLI 2.1.280, not
from a recording yet. `sensitive-full-access` (`cat .env` under full access,
which must still open a card) is the recording that will pin it.

The gate counts every call it sees. At the end of a turn the session compares
that count with the tool calls that ran, and emits a `session.warning` if
calls ran while the gate saw none — a CLI that stopped calling the hook would
say so rather than run ungated.

### Mapping onto Poseidon's vocabulary

`approvals.ts` names each call before the ladder reads it:

| Tool                                 | Approval kind | Pattern suggestion                                 |
| ------------------------------------ | ------------- | -------------------------------------------------- |
| Bash                                 | `command`     | `Shell(<first word> *)`                            |
| Edit, MultiEdit, Write, NotebookEdit | `file_write`  | `Edit(<path>)`                                     |
| Read, Glob, Grep, LS                 | `file_read`   | `Read(<path>)`, or the bare tool name with no path |
| WebFetch                             | `web`         | `Fetch(<url>)`                                     |
| WebSearch                            | `web`         | `Fetch(<query>)`                                   |
| `mcp__<server>__<tool>`              | `mcp_tool`    | `Mcp(<server>.<tool>)`, with `mcpTool`             |
| anything else                        | `other`       | the bare tool name                                 |

NotebookEdit's `notebook_path` is handed to the ladder as `file_path`, so the
sensitive-path check sees it. Each request also carries a one-line
description. `approvals.test.ts` parses every suggested pattern with the
shared `parsePattern`.

The CLI's no-permission tools never reach the ladder: Agent (Task is its older
name), TodoWrite, TaskCreate, TaskGet, TaskUpdate, TaskList, TaskStop,
ToolSearch and EnterPlanMode (`NO_PERMISSION_TOOLS`). CLI 2.1.280 allows them
in every mode Poseidon selects, and none runs a command or touches a file. As
`other` they would open a card in the ask modes and be refused in every plan
turn. The hook lets them past with no verdict, and `canUseTool` allows one if
it is ever asked. A subagent's own calls are still gated one by one. Skill is
not on the list, since the CLI asks before running a skill no rule allows.
Monitor, the worktree tools, the cron tools and RemoteTrigger are not on it
either, since they run commands or change the working directory.

### The answers

| Card answer       | What the CLI is told                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| allow once        | `allow`, input unchanged                                                                                                   |
| allow always      | `allow`, input unchanged; the rule is Poseidon's, saved by the server                                                      |
| allow for session | `allow`, plus the CLI's own suggested rules and directories, every one kept to destination `session`; mode changes dropped |
| deny              | `deny`, with a line for the model saying the user refused                                                                  |

Nothing is ever written to the CLI's settings files. A call the CLI withdraws
while its card is open — the turn was stopped — aborts `canUseTool`'s signal,
and the gate answers the card `deny`. Interrupt and close release every open
card as `deny`.

### Runtime modes

| Thread                          | CLI permission mode |
| ------------------------------- | ------------------- |
| approval required               | `default`           |
| auto-accept edits               | `acceptEdits`       |
| full access                     | `bypassPermissions` |
| a plan turn, whatever the above | `plan`              |

The mode is set at start and changed mid-session with `setPermissionMode`. The
session remembers the mode the CLI is in: the one it last set, or the one the
CLI last reported in a `system/status`. It sets the mode again before a turn
whose modes call for another, so the turn after a plan runs out of plan mode
even when the model moved the CLI into plan mode itself (EnterPlanMode).
Whatever the CLI's mode, the ladder reads the thread's own modes on every
call. There is no Poseidon mode for the CLI's own `auto` mode.

## Plan mode

A plan turn runs in the CLI's `plan` mode. The model writes its plan to a
markdown file of the CLI's own directly under `<config dir>/plans/`, then
calls ExitPlanMode. Reading CLI 2.1.280's bundle shows it filling the call's
input with the file's markdown and path (`plan`, `planFilePath`) before it asks
`canUseTool`.

- ExitPlanMode passes the hook with no verdict, since the ladder refuses every
  non-read in a plan turn and would refuse the very call that hands the plan
  over. `canUseTool` (`interactions.ts`) settles the call's row as a `plan`
  item carrying the markdown, emits `turn.plan.proposed` with `planPath`, and
  **denies the call** with `PLAN_CAPTURED`, a message telling the model the
  plan is with the user and to stop. The turn then ends on the CLI's
  `result`; the refusal the CLI writes back leaves the plan row as it is.
- A call that arrives with no plan is denied with `NO_PLAN`, which asks the
  model to write the plan file and call again, and opens no card.
- The plan file's own write, a Write, Edit or MultiEdit of a `.md` file
  directly in the plans directory, passes the hook with no verdict in a plan
  turn, and the CLI's plan mode, which allows that one file, decides it. Every
  other write in a plan turn reaches the ladder and is refused, and so are
  Task and its subagents, which are not reads. Plans kept elsewhere through the
  CLI's `plansDirectory` setting are not recognised: their write is refused,
  and ExitPlanMode arrives with no plan.

`respondToPlan` has nothing to release. Accept, accept with auto-accept, and
revise are the server's settings change and next turn, as on every connector,
and that next turn runs out of plan mode. `plan-accept` is the recording that
will show it end to end.

## Questions

AskUserQuestion also passes the hook with no verdict, and `canUseTool` opens
the question card (`questions.ts`):

- each question's text, `header`, options (label and description) and
  `multiSelect`;
- ids minted by position, `q<n>` and `o<n>`;
- `freeform` always on, since the CLI always lets the user type an answer of
  their own.

The answer goes back as the call's `updatedInput`: the input plus `answers`,
keyed by question text, holding the chosen labels joined by ", " and then any
typed text. The CLI hands the model that as the tool's result. A withdrawn
call, an interrupt or a close denies the call, and `user-input.resolved` is
emitted exactly once whichever way it ends.

AskUserQuestion is offered to SDK sessions without any environment switch: the
recorded `system/init` tool list has it. `question` is the recording that will
show a card answered.

## Subagents

A Task or Agent call's row is a task row, and `task.started` goes out beside it
with the call's `description` as title and its `model` when it sets one. The
CLI's `task_started`, `task_progress`, `task_updated` and `task_notification`
system messages name the call's `tool_use_id`, or a `task_id` their
`task_started` tied to it. They become `task.updated` while the task runs and
`task.completed` once it settles: `completed`, or `failed` for a failure, a
kill or a stop. A task_* message for a background shell command — whose row
settled with the CLI's placeholder when the command was launched — or of a
kind the connector does not know is kept as `event.unmapped`, whole, until a
recording shows how it maps onto that row; one for a task already settled
restates it and adds nothing.

With `forwardSubagentText`, every message the subagent sends carries the
call's id as `parent_tool_use_id`. Each is translated as a main-loop message
would be, with its own stream key, and every row it opens is nested under the
task (`parentItemId`), rows the plan path and the end-of-turn cleanup settle
included. A subagent's messages never move the session's context, cost or
rewind point. The prompt the subagent is handed is already on the task row and
is not shown again. A message that arrives before its task row exists is held
until the row opens, and anything still held at the end of the turn is shown
unnested (a held lifecycle message becomes `event.unmapped`).

Unlike Command Code's, a subagent's own tool calls reach the PreToolUse hook —
the hook input names the subagent (`agent_id`) — so they are gated one by one.
`subagent` is the recording that will show a delegation end to end.

## Resume, rewind and fork

`ClaudeSessionRef` (`sessionRef.ts`) is `{ sessionId, cwd, lastAssistantUuid?,
totalCostUsd? }`:

- `sessionId` is minted by the connector for a fresh session and passed as the
  SDK's `sessionId` (`--session-id=<uuid>`). On restart it is the SDK's
  `resume`. After that it follows the id each `system/init` names: `/clear`
  sends `conversation_reset` and moves the CLI to a new session id, so the ref
  moves with it and a resume carries on the cleared conversation
  (`fixtures/claude/local-command/`).
- `cwd` is kept because the CLI files transcripts per project directory; a
  resume from another directory does not find the conversation.
- `lastAssistantUuid` is the newest main-loop assistant message, the point the
  SDK's `resumeSessionAt` could rewind to. A `conversation_reset` clears it.
- `totalCostUsd` is the CLI's running cost total at the last `result`, which a
  resumed CLI carries on from its transcript.

A ref that does not parse (another connector's, a session id that is not a
uuid) starts a fresh session with a `session.warning`. A resume the CLI refuses
with "No conversation found with session ID: …" does the same. The CLI says it
on stderr, which the SDK does not read from a custom spawn, so a failed
handshake's `SpawnFailed` carries the end of the CLI's stderr (at most 500
characters) after the SDK's own message. `resume` is the recording that will
show a second turn recalling the first after a restart.

Rollback and fork are not offered (`rollback: false`, `fork: false`). The SDK
can rewind (`resumeSessionAt`) and fork (`forkSession`), but nothing recorded
shows either, and Poseidon's checkpoints are git, which does not depend on
them.

## Model and effort

`updateSettings` switches the model with the SDK's `setModel`, which sends no
model for `default` so the CLI's own default applies again. It switches the
effort with `applyFlagSettings({ effortLevel })`. Both act on the running
process from its next request, and `fixtures/claude/session-controls/` has the
CLI answering `set_model` (an explicit id, and none) and
`apply_flag_settings` with success, in one process with no restart. The
session then emits `model.changed` with what the CLI runs on: the new pick
once the CLI took it, the previous one when it refused, so the thread never
shows a model the session is not using.

The thread model `default` leaves the SDK's `model` option out altogether. On
the recording account the CLI's `system/init` named what it resolved to, and
that is the id each manifest's `model` records. Poseidon's `minimal` effort has
no rung in the CLI and is left out, so the CLI's default effort applies.

## Compaction

A turn whose text is `/compact` goes as a plain string, the form the CLI reads
a slash command from, and runs as the CLI's own command. `session-controls` has
it signed out: `system/status: compacting`, then `system/status` with
`status: null`, `compact_result: "failed"` and a `compact_error`, then a
`result` whose text repeats the error — with `is_error: false`. The
translator opens a `context_compaction` row on `compacting`. A
`compact_boundary` settles it with the token counts before and after, plus
`context.updated`. A failed compaction, or one still open when the turn ends,
fails the row. A compaction of a real conversation costs a summarisation
request, so a signed-in `/compact` is recorded only with the operator's
approval.

## Harness slash commands

The composer's `/` menu lists the CLI's own commands under a Harness heading,
from the instance's `commands` extension (see [The probe](#the-probe)).
Choosing one only inserts `/<name> ` into the draft; the message goes out as
plain text, the form the CLI reads a slash command from, as a typed `/compact`
does. A command the CLI answers itself comes back as a `<synthetic>` assistant
snapshot, which the translator reads as any answer (`local-command`).

- **What is listed:** only the CLI's built-in and bundled commands, since the
  listing handshake runs with `settingSources: []`. The user's and the
  project's own commands, plugin commands and MCP prompts are missing from the
  menu, though the CLI still runs them when typed.
- **What is left out** (`slash-menu.tsx`): every name Poseidon's own entries
  take (`model`, `effort`, `mode`, `plan`, `default`, `clear-draft`, and
  `compact` even while it is hidden), every enabled skill's name, and `clear`,
  which would reset the conversation behind the timeline.
- **Command Code** has no such extension; its `/` menu shows no Harness group
  ([command-code-connector.md](command-code-connector.md)).

## Attachments

`attachments.ts` sniffs each attached file's bytes
(`@poseidon/shared/imageBytes`). PNG, JPEG, GIF and WebP go to the model as
base64 image content blocks ahead of the text (`session-controls` has the CLI
reading such a message). Any other file is named by its path in the prompt,
as Command Code's are: the server's staged file where it is, and a file from
anywhere else copied into the thread's attachments directory first. That
directory is among the CLI's `additionalDirectories`, so the model can read
what is named there. A file that cannot be read or copied is still named, with
a `session.warning` saying why. `image` is the recording that will show a model
answering from an image.

## Steering and turn accounting

`steering` is true: while a turn runs, `steer` writes one more user message to
the same CLI, with no `turn.started`. It fails `NotSteerable` when no turn is
running or the turn is stopping, and the server then puts the message on the
queue ([how-it-works.md](how-it-works.md#steering)).

The steered message's `user_message` row is written by the server, not the
connector, and only once `steer` has succeeded: the decider emits
`thread.turn.steered` alone, and the provider command reactor appends the row
on the running turn after the delivery. A steer the session refuses leaves no
row behind in the turn it missed; the message gets its one row when the queue
runs it. A server that restarts between the steer and that append loses the
row, which is accepted.

The CLI queues the message and takes it one of two ways:

- **folded** into the running agent loop, between two of its requests, so the
  turn's one `result` answers both messages;
- **run next**, when the loop ended first, as a turn of the CLI's own with a
  `result` of its own.

Counting `result`s cannot tell these apart. The CLI's `command_lifecycle`
receipts can (capability `msg_lifecycle_v1` in `system/init`). They name each
user message by the uuid the session stamped on it, and move it `queued` →
`started` → one end state: `completed`, `cancelled`, `discarded` or `refused`.
A folded message is `started` before the running turn's `result`, and one that
runs next is `started` after it. So `steering.ts` holds Poseidon's turn open at
a `result` while any steered message has been neither `started` nor ended, and
the turn's usage is the sum of every `result` it spans. The steer's check and
the end-of-turn decision are each one atomic step, so a steer racing the last
`result` either holds the turn or finds no turn and falls back to the queue.

A CLI that sends no receipts cannot be steered this way: a message it ran next
would run as a turn nobody opened, and its `result` would close the turn after
it. So `steer` is taken only once the CLI has shown it sends them — a receipt,
or `msg_lifecycle_v1` in its `system/init` — and refused otherwise, for the
server to queue the message. That includes the moment before the first
`system/init`. Once an init lists no `msg_lifecycle_v1`, the session's next
`session.started` says `steering: false`, so the composer stops offering it.
`fixtures/claude/receiptless-steer/` pins this on CLI 2.1.150, whose init has
no `capabilities` at all and which sends no receipts.

`fixtures/claude/signed-out-steer/` records the run-next path: the steered
message was written after `system/init` and before the first `result`; the CLI
receipted it `queued`, ended the first turn (receipt `cancelled` for the
refused message), then `started` the steered one and gave it a `result` of its
own. `steering` is the recording that will show a message folded into a running
loop.

**Interrupt** is the SDK's `interrupt()` on the running process
(`interrupt: "session"` — the process stays, and the next message goes to it).
When a steered message is still waiting, the session passes the SDK's
`cancelQueued` option (the CLI's `interrupt_cancel_queued_v1` capability), so
the CLI drops that message rather than running it once the turn stops. The
option is read by SDK 0.3.280's runtime but missing from its declarations.
When the turn was already held at a `result` for that message, no `result`
follows its cancellation, so the session ends the held turn on the message's
end-state receipt instead (`interrupted`); the same goes for any steered
message the turn is held for that ends without being `started`.
`interrupt` is the recording that will show what the next turn finds.

## Capabilities

`CLAUDE_CAPABILITIES` in `capabilities.ts`, and why each value is what it is:

| Capability     | Value        | Why                                                                                                                                             |
| -------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelSwitch`  | `in-session` | `setModel` on the running process; `session-controls`                                                                                           |
| `effortSwitch` | `in-session` | `applyFlagSettings({ effortLevel })`; `session-controls`                                                                                        |
| `steering`     | `true`       | one more message to the running CLI, the turn held by its receipts; `signed-out-steer`; `false` once the CLI's init lists no `msg_lifecycle_v1` |
| `planMode`     | `true`       | permission mode `plan`, the plan handed over through ExitPlanMode                                                                               |
| `subagents`    | `true`       | Task/Agent, the task_* messages, and nested rows                                                                                                |
| `images`       | `true`       | image content blocks; `session-controls` has the CLI reading one                                                                                |
| `resume`       | `true`       | `resume: <sessionId>` against the CLI's own transcript                                                                                          |
| `fork`         | `false`      | nothing recorded forks a session                                                                                                                |
| `interrupt`    | `session`    | `Query.interrupt()` inside the one long-lived process                                                                                           |
| `rollback`     | `false`      | `resumeSessionAt` exists, but nothing recorded shows it; Poseidon's checkpoints are git                                                         |
| `compaction`   | `true`       | `/compact` runs as the CLI's command; `session-controls`                                                                                        |
| `questions`    | `true`       | AskUserQuestion, offered to SDK sessions (recorded `system/init`)                                                                               |
| `runtimeModes` | all three    | the PreToolUse hook puts every call in every mode past the ladder                                                                               |
| `attachments`  | `files`      | images as blocks, anything else by path under a readable directory                                                                              |

`planMode`, `subagents` and `questions` rest on the SDK's declarations and on
reading the CLI's bundle until their recordings are made; the capability
comments say which recording will pin each.

## Known CLI behaviour worth remembering

- **`auth status --json` exits 1 when signed out** and still prints the
  document.
- **A signed-out turn is a `success` result with `is_error: true`,** after a
  `<synthetic>` assistant snapshot carrying `error: "authentication_failed"`.
  Nothing reaches the API, so it costs nothing.
- **A failed `/compact` is a `success` result with `is_error: false`,** whose
  text is the compaction error. The status message before it is what says it
  failed.
- **Every user message gets receipts** (`command_lifecycle`): `queued`,
  `started`, then an end state. A refused, signed-out message ends
  `cancelled`.
- **The CLI's own commands answer as the model would** (`local-command`):
  `/cost` is a `<synthetic>` assistant snapshot carrying the command's output
  (and a `local_command_source` wrapping it in `<local-command-stdout>`), then
  a `success` result with no request behind it; the translator reads it as any
  answer. A command that only opens a terminal panel, such as `/permissions`,
  answers "/permissions isn't available in this environment." the same way.
  The SDK declares a `system/local_command_output` message too, but 2.1.280
  never writes it on stdout.
- **`/clear` moves the CLI to a new session id:** it sends
  `conversation_reset`, and the next `system/init` names the new id.
- **A message written mid-turn is queued, not refused,** and runs as the
  next turn if the loop ends first (`signed-out-steer`).
- **The initialize response is the only model list,** and the only account
  source besides `auth status`. It also lists the user's skills, commands and
  agents, which the recorder replaces with `user-skill-<n>`.
- **MCP configuration travels in argv,** so the bearer is visible to `ps`.
- **`system/init` capabilities** in 2.1.280: `interrupt_receipt_v1`,
  `interrupt_cancel_queued_v1`, `msg_lifecycle_v1`, `mcp_read_resource_v1`,
  `mcp_tool_ui_meta_v1`. 2.1.150's init has no `capabilities` field and it
  sends no receipts (`receiptless-steer`).
- **A probe's handshake is stopped, not ended:** its recorded exit is 143.

## Needs a signed-in run

Every claim below still rests on the SDK's declarations, on reading the CLI's
bundled code, or on unit tests of the pure pieces, because the CLI on the
recording machine is signed out. Each is settled by a recording or a live run
once it is signed in ([Owner commands](#owner-commands)).

**The scenarios waiting for a signed-in CLI**, their tests in place and skipped
under replay (`packages/testkit/fixtures/claude/README.md` has the table):

- `plain-reply`: one answered turn, streamed text, usage, `end_turn`.
- `interrupt`: a turn stopped after its first text, and whether the same
  process serves the next.
- `resume`: two turns with the server restarted between, the second launch
  `--resume`, and whether that init names the same session id
  (`resume.test.ts` compares them).
- `edit-approval`: a write asked about in approval-required, allowed once.
- `deny`: `touch denied.txt` denied at every card, the file absent.
- `sensitive-full-access`: `cat .env` under `bypassPermissions` still opens a
  card, which pins that a hook's `ask` reaches `canUseTool` in every mode.
- `plan-accept`: ExitPlanMode's plan card, accepted, then implemented out of
  plan mode.
- `question`: AskUserQuestion as a card, answered with its first option.
- `subagent`: a Task delegation with its rows nested under the task row.
- `model-switch`: the model and the effort switched between two turns in one
  process.
- `image`: a model answering from an image content block.
- `steering`: a message folded into a running agent loop.

**Conformance and the live suites:**

- `conformance` re-recorded signed in, so the suite's turns are answered ones,
  with its approval case (a file write stopped on a card and allowed once),
  which the replay runs only once the recording has it.
- One run of the `POSEIDON_LIVE_CLAUDE=1` suites on the CLI's default model.

**The provisional capability values** (`capabilities.ts`): `effortSwitch` and
`steering` are backed only by signed-out recordings; `interrupt` (`session`)
has no recording of what an interrupt leaves behind; `rollback` and `fork` stay
`false` until a recording shows `resumeSessionAt` or `forkSession`.

**This round's fixes and additions:**

- The resume fallback's wording on a real missing conversation: that the CLI's
  stderr, carried into `SpawnFailed`, says "No conversation found with session
  ID: …" (read from the 2.1.280 binary with `strings`, never from a run).
- The no-permission tools: that Agent, TodoWrite, ToolSearch, EnterPlanMode and
  the task-list tools run without a card in approval-required and plan turns,
  and that Skill is still asked.
- A thinking block whose snapshot comes back with no text: that its streamed
  row settles, and what the CLI's default thinking display (without
  `--thinking-display`) shows in it.
- `system/local_command_output` from a harness command: 2.1.280 answered local
  commands as `<synthetic>` snapshots signed out; a signed-in CLI may write it.
- The harness command list as a signed-in CLI reports it. The recorder scrubs
  the list to one `scrubbed-entry`, so this is read in the running app's `/`
  menu rather than from a recording.
- The notices: `rate_limit_event` on every turn (status `allowed` maps to
  nothing) and its warning statuses, `api_retry`, the model-refusal messages,
  and the `informational` and `notification` shapes. A fallback model's
  `retracted_message_uuids` leave the refused rows on the timeline.
- Foreground subagents: the order of the Task `tool_result` and
  `task_notification`, since a late `task_updated` could show a finished task
  row as running again.
- Background agents (`run_in_background`): whether the headless CLI holds its
  `result` until they finish, as its bundle suggests, or runs a turn of its own
  that would close the wrong Poseidon turn.
- `lastAssistantUuid` taking a synthetic local-command snapshot's uuid, which
  matters only once rollback is offered.

### Owner commands

Run these in your own shell, from the repository root. The recording and live
commands spend the account's subscription on the CLI's default model.

Sign in, and check it took (the document must say `"loggedIn": true`):

```sh
claude auth login
claude auth status
```

Record the waiting scenarios through the server:

```sh
POSEIDON_RECORD_CLAUDE=1 pnpm -F server exec vitest run test/e2e-claude/turn.test.ts test/e2e-claude/interrupt.test.ts test/e2e-claude/resume.test.ts test/e2e-claude/approval.test.ts test/e2e-claude/plan.test.ts test/e2e-claude/question.test.ts test/e2e-claude/subagent.test.ts test/e2e-claude/model.test.ts test/e2e-claude/attachment.test.ts test/e2e-claude/steering.test.ts
```

Re-record the conformance suite signed in:

```sh
POSEIDON_RECORD_CLAUDE=1 pnpm -F @poseidon/connector-claude vitest run src/conformance.test.ts
```

Run the live suites once:

```sh
POSEIDON_LIVE_CLAUDE=1 pnpm -F @poseidon/connector-claude vitest run src/liveConformance.test.ts
POSEIDON_HOME=/tmp/poseidon-h1 POSEIDON_LIVE_CLAUDE=1 pnpm exec vitest run apps/server/test/e2e-claude
```

A replay skipped for want of its recording runs by itself once the recording
exists. Then check the capability values above against the new recordings, and
move each item they settle off this list.

## After a new CLI release

The CLI updates itself, so a release arrives without warning. These catch
drift, in the order they tell you:

1. **`recordedFrames.test.ts`** replays every recorded session through the
   translator and fails on any `event.unmapped`, and on a manifest older than
   `OLDEST_TESTED_VERSION`.
2. **The replayed suites** — `conformance.test.ts`, `sessionControls.test.ts`,
   `steering.test.ts`, `recordedSession.test.ts`, and the end-to-end suite in
   `apps/server/test/e2e-claude/`. The replayer exits 97 on any line the
   connector sends that the recorded run was not sent, so a change in the
   SDK's launch or control traffic fails here.
3. **The live suites**, the only thing that proves the CLI installed today
   still takes what the SDK and the connector send, is signed in, maps
   without `event.unmapped`, and still routes its calls through the gate:

   ```sh
   POSEIDON_LIVE_CLAUDE=1 pnpm -F @poseidon/connector-claude vitest run src/liveConformance.test.ts
   POSEIDON_HOME=/tmp/poseidon-h1 POSEIDON_LIVE_CLAUDE=1 pnpm exec vitest run apps/server/test/e2e-claude
   ```

   Both spend the account's subscription on the CLI's default model, so they
   are skipped without the variable; `POSEIDON_LIVE_CLAUDE_DEBUG=1` prints more.

4. **Re-recording**, when something did change. The commands and the model
   rules are in [development.md](development.md#making-one); a recording is
   never edited by hand to make a test pass. Recording on a newer release is
   also when `OLDEST_TESTED_VERSION` moves.

Beyond the tests, the things to read after an upgrade:

- `claude auth status --json`, for a field that moved (`loggedIn`, `email`).
- The initialize response's `models`, for a new row shape or effort rung.
- The `system/init` tool list, for a tool the vocabulary tables above do not
  name, and its capabilities, for a receipt or interrupt option that changed.
- Whether a hook's `ask` still reaches `canUseTool` under `bypassPermissions`
  — the claim full access rests on.
- A new SDK release, whose argv and control protocol the recordings replay;
  moving the SDK pin means making the recordings again.
