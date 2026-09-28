# Codex connector reference

Poseidon's third connector drives the Codex CLI, spelled `codex`, through its
`app-server` mode: one JSON-RPC message per line over the child's stdin and
stdout, with no SDK in between. This document describes how the connector
finds that binary, what it starts and with what environment, what comes back
and how it is read, how commands and file changes reach Poseidon's approval
gate, and what to check when the CLI changes.

Everything here is read off the code as it stands and off the recordings under
`packages/testkit/fixtures/codex/`. Those are captures of the real CLI at its
stdio boundary, signed in with ChatGPT: each line the connector wrote to the
app-server and each line it wrote back, in order, with every launch's argv and
exit. In the shared recording format they are the `codex` kind over the
`stdio-jsonrpc` transport ([development.md](development.md#stdio-jsonrpc)).
Where a claim rests on a recording, the recording is named; the fixtures'
README lists every scenario and the file that recorded it.

Its companions: [architecture.md](architecture.md#the-codex-connector) for the
shape of the connector inside Poseidon, [how-it-works.md](how-it-works.md) for
what the rest of the app does with what comes back, and
[development.md](development.md#making-one) for the commands that record it
and run it live.

## Where the code is

The connector is `packages/connector-codex`. It implements the
`ConnectorDefinition` interface of `packages/connector-sdk`, and
`apps/server/src/boot.ts` registers it third, after Command Code and Claude
Code, so a fresh install routes new threads to Command Code until the user
picks this instance. Adding it changed no existing install's routing.

| module                     | what it owns                                                                     |
| -------------------------- | -------------------------------------------------------------------------------- |
| `definition.ts`            | the `ConnectorDefinition`: probe, instance, start and resume, models, extensions |
| `configSchema.ts`          | `binaryPath`, `codexHome`, `defaultModel`, and the settings form                 |
| `binary.ts`                | which executable `codex` means, and how to spell a command for the user          |
| `env.ts`                   | the default-deny child environment                                               |
| `spawn.ts`                 | a process group per child, stdin closed first, and proof it is gone              |
| `rpc.ts`                   | the line-delimited JSON-RPC client                                               |
| `protocol.ts`              | narrow schemas for the responses read, pinned to `PROTOCOL_CLI_VERSION`          |
| `handshake.ts`             | `initialize` with the experimental API, `account/read`, `model/list`             |
| `probe.ts`                 | `--version`, `login status`, the zero-turn handshake, version floor              |
| `models.ts`                | the CLI's model rows and their effort ladders                                    |
| `capabilities.ts`          | what a Codex session can do, and why                                             |
| `launch.ts`                | the session's argv and environment, with Poseidon's MCP server                   |
| `session.ts`               | one app-server process per thread: send, steer, interrupt, close                 |
| `threadOpen.ts`            | `thread/start`, or `thread/resume` with the fallback to a new thread             |
| `sessionRef.ts`            | the persisted session reference                                                  |
| `modes.ts`                 | runtime modes → approval policy and sandbox                                      |
| `userInput.ts`             | one composer turn as `turn/start`'s `input`                                      |
| `attachments.ts`           | images as `localImage` inputs, other files by path                               |
| `approvals.ts`             | the approval requests in Poseidon's approval vocabulary                          |
| `mcpApprovals.ts`          | MCP tool-call approvals, which arrive as elicitations                            |
| `toolGate.ts`              | those requests through the permission ladder, and their answers                  |
| `serverRequests.ts`        | the safe refusal for every request no card answers                               |
| `plans.ts`                 | plan mode on `turn/start`, and the plan a turn proposes                          |
| `questions.ts`             | `item/tool/requestUserInput` as the question card                                |
| `steering.ts`              | when a steer is refused                                                          |
| `compaction.ts`            | `/compact` as `thread/compact/start`                                             |
| `translate/translator.ts`  | notifications → `RuntimeEvent`s, and the `IGNORED` list                          |
| `translate/tools.ts`       | the item rows                                                                    |
| `translate/usage.ts`       | a turn's usage from the thread's running total, and the context                  |
| `extensions/skills.ts`     | the `skills` extension                                                           |
| `extensions/mcpServers.ts` | the `mcpServers` extension, through `codex mcp`                                  |

The package may import `connector-sdk`, `contracts` and `shared`; its tests
also import `testkit`. The process-group code is its own rather than
connector-claude's, because one connector never imports another. Nothing else
in the tree names `codex`, apart from the registration line in `boot.ts` and
server tests; the renderer never does (the boundary gate refuses it).

## Finding the binary

`resolveBinary` in `binary.ts` answers in this order:

1. the configured `binaryPath`, when it is set and not empty, taken as given —
   the probe's `--version` is what finds out whether it runs;
2. `codex` in each `PATH` entry;
3. `codex` in the directories the CLI's installers use, which a GUI process
   never inherits on its `PATH`: `/opt/homebrew/bin`, `/usr/local/bin`,
   `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`,
   `~/Library/pnpm` and `~/.bun/bin`.

A candidate counts only when it is a regular file with the execute bit set.
There is no fallback to a package runner. Resolution is redone per probe, per
session start and per MCP extension call, so an install that appears later is
found. `terminalCommand` spells a command for the user's own terminal — the
login command, for one — with the resolved binary's full path, prefixed with
`CODEX_HOME=…` when the instance has an account of its own.

The npm install is a node script (`node …/codex.js`) that starts a native
binary, so the process the connector spawns is `node`, not `codex`; the
process-group handling covers both.

## Version policy

The connector runs whatever is installed. `OLDEST_TESTED_VERSION` in
`probe.ts` is the release the recordings were made at, **0.156.1**. Below it
the probe adds a warning; at or above it, it says nothing; a version string
that does not parse is not refused. `recordedFrames.test.ts` fails if any
recording's manifest names an older CLI.

The app-server protocol is the CLI's, not a published contract, and the parts
Poseidon uses for plan mode and questions are marked experimental. So the
connector reads only the fields it needs, through the narrow schemas in
`protocol.ts` (`PROTOCOL_CLI_VERSION` names the release they were read
against), and the handshake opts into the experimental API on every
connection. Every recording was made with that handshake: changing it, or
moving to a new release that changes a frame, means recording again (see
[After a new CLI release](#after-a-new-cli-release)). The CLI's bindings
(`codex app-server generate-ts --experimental`) are read to write those
schemas, never committed.

## Config

`CodexConnectorConfig` (`configSchema.ts`) is what an instance's
`settings.connectors[].config` holds. Its `settingsForm` annotations are the
form the connectors page renders, served over `connectors.describe`.

| field          | meaning                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------- |
| `binaryPath`   | overrides discovery. Empty uses the discovered `codex`.                                  |
| `codexHome`    | `CODEX_HOME` for this instance: a separate Codex account. `~` is expanded.               |
| `defaultModel` | the model a new thread on this instance starts with, when the app-wide default is unset. |

`HOME` is never changed. The CLI keeps its login, its `config.toml`, its
sessions (rollouts) and its skills under `CODEX_HOME`, `~/.codex` when unset,
so a second account is a second `CODEX_HOME`. The directory must exist: the
CLI refuses a `CODEX_HOME` that does not (`failed to resolve CODEX_HOME`).

## The probe

`probe` in `probe.ts` asks three questions of the binary a session would run,
under the environment a session would get, from the system temp directory.
`fixtures/codex/probe/` is the probe recorded.

1. `codex --version` → `codex-cli 0.156.1`. A non-zero exit, or output with no
   version in it, is status `error`.
2. `codex login status` → "Logged in using ChatGPT" is signed in, "Not logged
   in" is not. The CLI prints this to stderr, so both streams are read
   whatever the exit code; anything else is a warning, and the handshake's
   answer decides.
3. A zero-turn app-server handshake, launched as `app-server --stdio` (the
   CLI's own spelling of its default transport, there so a replay can tell a
   probe from a session): `initialize`, `initialized`, `account/read` and
   `model/list`, following `nextCursor`, then the process group is stopped.
   No thread starts, so nothing reaches a model. A handshake that fails or
   takes over 20 seconds is a warning, not a failed probe.

A signed-out CLI is status `not-authenticated`, with the message naming the
login command (`codex login`, prefixed with the instance's `CODEX_HOME`). The
account reads as its email, or as how it signs in (ChatGPT, API key, Amazon
Bedrock). `listModels` runs the same handshake once per instance and keeps
its answer.

The model list (`models.ts`) leaves out rows the server marks `hidden`, puts
the `isDefault` row first, and labels each row with its display name under the
family "Codex". Efforts are the row's `supportedReasoningEfforts` that
Poseidon's ladder names; the protocol's effort is an open string, so a rung
Poseidon has no name for is dropped. Vision is read from the row's input
modalities. The model id `default` means the CLI's own default: a thread on it
names no model to the CLI, which is how every recording but `model-switch`
ran.

## The child environment

`childEnv` in `env.ts` builds the child's environment from nothing: `HOME`,
`PATH`, `USER`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, `SSH_AUTH_SOCK`, the proxy
variables, `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS` and the `LC_*` locales, then
`CODEX_HOME` from the instance's config. Every `CODEX_*`, `OPENAI_*`,
`CLAUDE_*`, `ANTHROPIC_*` and `POSEIDON_SERVER_*` variable, and `CLAUDECODE`,
is dropped by name as well as by omission: Poseidon may run inside another
agent's session, and a parent Codex session's `CODEX_SANDBOX*` would make the
child think it is already sandboxed, while a parent's `CODEX_HOME` would sign
it in to an account the instance never chose.

## The launch

A session starts the app-server as

```
codex app-server \
  -c mcp_servers.poseidon.url="<the thread's MCP endpoint>" \
  -c mcp_servers.poseidon.bearer_token_env_var="POSEIDON_CODEX_MCP_TOKEN"
```

in the thread's workspace root, in a process group of its own (`launch.ts`,
`spawn.ts`). The `-c` overrides add Poseidon's per-thread MCP server
(`services.mcpEndpoint`: the in-app browser and Poseidon's own tools) to the
CLI's configuration for this process only; nothing is written to
`config.toml`. The bearer is set only in the child's environment, under
`POSEIDON_CODEX_MCP_TOKEN`: never in argv, where `ps` would show it, and never
in a recording, since the tee does not write the environment
(`launch.test.ts` checks every recorded argv). The name contains `TOKEN` on
purpose: the CLI's default shell environment policy keeps variables named
like secrets out of the commands the model runs. Every recorded session but
one shows the CLI starting `poseidon` (`mcpServer/startupStatus/updated`), and
failing it, because those recordings point it at a port nothing listens on.
`mcp-tool-approval` points it at a live loopback endpoint instead
(`test/mcpStandIn.ts`, which lists one tool shaped as the gateway lists
`browser_open` and checks the bearer), and the model calls that tool.

The first message is `initialize` with `clientInfo` `poseidon` and
`capabilities: { experimentalApi: true, requestAttestation: false }`, then the
`initialized` notification. The app-server's messages carry no `jsonrpc`
member, and the client sends none either. The operator's own MCP servers from
`config.toml` start inside every session too; the recordings name them
`user-skill-<n>`.

## One session, one process

A thread's session is one app-server process for its whole life
(`session.ts`), opened by `threadOpen.ts`:

- a new thread is `thread/start` with the cwd, the approval policy and the
  sandbox its modes call for, and the model unless it is `default`;
- a resumed one is `thread/resume` with the stored thread id and
  `excludeTurns: true` (Poseidon keeps its own timeline). The CLI finds the
  thread in its own rollout, so a new process picks the conversation up
  (`resume`: the second process names the word the first was told). A thread
  the CLI has no rollout for — made under another `CODEX_HOME`, or cleaned up
  — is started afresh on the same process with a `session.warning`
  (`resume-missing`); a stored reference this connector cannot read does the
  same.

The reference (`sessionRef.ts`) is `{ threadId, cwd }`, the thread id being a
UUID. `send` is `turn/start` and returns `TurnInProgress` while a turn runs.
`interrupt` is `turn/interrupt`, which ends the turn and leaves the thread, so
the same process answers the next one (`interrupt`). `close` ends stdin — the
app-server exits 0 on end of input — then signals the group and proves it
gone; afterwards the handle answers `SessionClosed`. An app-server that exits
by itself is a fatal `runtime.error` followed by `session.ended` with reason
`crashed`.

## The notification catalogue

What `translate/translator.ts` does with each app-server notification. All of
these appear in the recordings; `recordedFrames.test.ts` translates every
recorded launch and fails on anything unmapped.

| Notification                                                       | Becomes                                                                             |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `item/started`, `item/completed`                                   | a row opened, then settled (see the tool vocabulary)                                |
| `item/agentMessage/delta`                                          | streamed assistant text                                                             |
| `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`      | streamed reasoning                                                                  |
| `item/plan/delta`                                                  | streamed plan text                                                                  |
| `item/commandExecution/outputDelta`                                | streamed command output, capped at 64 KB                                            |
| `item/fileChange/patchUpdated`                                     | the file change's diff                                                              |
| `turn/plan/updated`                                                | one `todo` row per turn, the model's checklist                                      |
| `thread/tokenUsage/updated`                                        | `usage.updated` and `context.updated`                                               |
| `turn/completed`                                                   | open rows failed, then `turn.completed`: `end_turn`, `interrupted` or `error`       |
| `error`                                                            | `runtime.error`, fatal when unauthorized (naming `codex login`); a retry: a warning |
| `warning`, `guardianWarning`, `configWarning`, `deprecationNotice` | `session.warning`                                                                   |
| `model/rerouted`                                                   | `session.warning` naming both models                                                |
| `mcpServer/startupStatus/updated`                                  | `mcp.status.updated`, every server with its latest state                            |
| everything in `IGNORED`                                            | nothing — each entry says why                                                       |
| anything else                                                      | `event.unmapped`, kept whole                                                        |

`IGNORED` holds, among others, `thread/started` and `turn/started` (the
responses already said it), `thread/status/changed`, `turn/diff/updated`
(Poseidon reads diffs from git), the thread's name and goal, the account and
its rate limits, `remoteControl/status/changed` (which carries the machine's
host name; the recorder scrubs it), `skills/changed`,
`serverRequest/resolved` (the session reads it for withdrawals), the
deprecated `thread/compacted` and `item/fileChange/outputDelta`, and the CLI's
own hooks.

A turn's usage is how far the thread's running `total` moved during the turn;
the session drops notifications that name another Codex turn, so the total a
resume repeats is not counted as the new turn's. Cached input is `cacheRead`,
and the context in use is the last request's whole count against the
`modelContextWindow` beside it.

## The tool vocabulary

Every item is one row, keyed by the item's id (`translate/tools.ts`):

| Item type             | Row                                             |
| --------------------- | ----------------------------------------------- |
| `agentMessage`        | `assistant_message`                             |
| `reasoning`           | `reasoning`: its summary, or its text           |
| `plan`                | `plan`: its markdown                            |
| `commandExecution`    | `command_execution`: command, cwd, output, exit |
| `fileChange`          | `file_change`, one row per changed path         |
| `mcpToolCall`         | `mcp_tool_call`, naming the server              |
| `webSearch`           | `web_search`, the query                         |
| `contextCompaction`   | `context_compaction`                            |
| `collabAgentToolCall` | `task`, the prompt it hands over                |
| `userMessage`         | nothing: the server writes the user's own row   |
| anything else         | `tool_call`, named by its type                  |

A finished row is never reopened. A late report of an item whose turn already
ended opens no second row (`approval-stop` showed a stopped turn's file change
arriving after the next turn began).

## Approvals

### The gate

Every approval the app-server asks for goes past the permission ladder
through the shared `makeApprovalGate` (`toolGate.ts`). The ladder answers
allow or deny at once; prompt opens a card and waits. Each request is answered
on a fiber of its own, so a card waiting on the user holds up no
notification, and the thread's modes are read per request, so a mode change
applies to the next one. It fails closed: a defect answers `decline`.

### Mapping onto Poseidon's vocabulary

`approvals.ts`:

- `item/commandExecution/requestApproval` → tool `Shell`, kind `command`,
  input `{ command, cwd }`. `command` is the script inside the CLI's
  login-shell wrapper (`/bin/zsh -lc '…'`, `unwrapShell`), because a rule and
  the card should read the script; "allow always" starts from
  `Shell(<first word> *)`.
- `item/fileChange/requestApproval` → one `Edit` request per path, kind
  `file_write`, input `{ file_path }`, "allow always" from `Edit(<path>)`. The
  request names only its item; the paths came with that item's
  `item/started`, which the recordings show always arrives first. A move's
  destination counts as a path too.
- `mcpServer/elicitation/request` whose `_meta.codex_approval_kind` is
  `mcp_tool_call` (`mcpApprovals.ts`) → tool `mcp__<server>__<tool>`, kind
  `mcp_tool`, `mcpTool: { server, tool }`, input the call's arguments, "allow
  always" from `Mcp(<server>.<tool>)` — the request Claude Code's MCP calls
  make. Codex asks about an MCP tool call this way, not with an approval
  request of its own: under `untrusted`, a tool that is not read-only and
  reaches outside the machine — every in-app browser tool that sends input or
  changes the page — is asked about before it runs. The elicitation names the
  server; the tool and its arguments come from the `mcpToolCall` item the CLI
  started just before asking, else from the message
  (`Allow the <server> MCP server to run tool "<tool>"?`) and
  `_meta.tool_params`. Its answer is the elicitation's own:
  `{ action: "accept", content: {}, _meta: null }`, `decline` or `cancel`
  (`mcp-tool-approval`: the card allowed `browser_open` once, and the call
  ran).

### The answers

| Poseidon's verdict                      | The CLI is told    |
| --------------------------------------- | ------------------ |
| allow (rules), allow once, allow always | `accept`           |
| allow for the session                   | `acceptForSession` |
| deny                                    | `decline`          |
| Stop, with the card open                | `cancel`           |
| close, or the CLI withdrew the request  | nothing            |

A file change runs only if every path is allowed, and is accepted for the
session only if every path was. "Always" is Poseidon's rule; nothing is
written to the CLI's own configuration. A request the CLI withdraws —
`serverRequest/resolved` for one still open, or its turn completing — aborts
its card, which resolves `deny` with nothing sent (`approval-stop`: one card
ended by Stop, one by close, each resolved once).

`serverRequests.ts` answers what has no card with the refusal that lets
nothing happen, and a `session.warning`: `item/permissions/requestApproval`
(more sandbox) is granted nothing for the turn, an
`mcpServer/elicitation/request` that is not a tool-call approval — an MCP
server asking the user for input — is declined, and the older protocol's `execCommandApproval` and
`applyPatchApproval` are denied. Anything else is answered "not handled".

### Runtime modes

`modes.ts`. The approval policy is `untrusted` in every mode; only the
sandbox varies:

| Runtime mode        | Approval policy | Sandbox              |
| ------------------- | --------------- | -------------------- |
| `approval-required` | `untrusted`     | `workspace-write`    |
| `auto-accept-edits` | `untrusted`     | `workspace-write`    |
| `full-access`       | `untrusted`     | `danger-full-access` |

Why not `never` for full access: the ladder, not the CLI, decides what a mode
allows, and the ladder's sensitive-path rung prompts even under full access.
With `never` the CLI would ask about nothing, and a sensitive path would never
reach the ladder. Under `untrusted` the CLI asks, the ladder allows what the
mode allows without a card, and prompts for the rest. The sandbox is the
OS-level backstop under it.

What the recordings show: on 0.156.1, under `untrusted`, the CLI asked about
every command, reads included — `sensitive-full-access` stopped `cat .env`
under full access for approval, and the card was denied (`deny` and the
conformance recording show a command asked about under approval required).
Across the recordings, every command and file change the CLI ran was asked
about first (nine items in seven recordings). The CLI does keep a list of
known-safe reads it may run without asking, though, and where that exemption
applies a read never reaches the ladder. So the session counts every item that ran without a
request for it: a file change, or a command that is not one of those reads,
ends the turn with a `session.warning` that the turn was not fully gated. A
known-safe read that ran unasked is the gap left open; it is not warned about.

## Plan mode

A plan turn sends `collaborationMode: { mode: "plan", settings: { model,
reasoning_effort, developer_instructions: null } }` on `turn/start` — an
experimental field, which is why the handshake opts in. The model is the
thread's, or the one `thread/start` resolved for a thread on `default`. After
the first plan turn every turn names its mode (`default` or `plan`), because
the CLI keeps the mode, with its model and effort, on the thread; a resumed
thread names it from its first turn. A thread that never used plan mode sends
none. The `plan` item is the plan row, and a turn that ends `end_turn` with one
emits `turn.plan.proposed` just before `turn.completed` (`plans.ts`).
Accepting is the server's next turn, out of plan mode (`plan-accept`).

## Questions

`item/tool/requestUserInput`, offered to the model in plan mode, is the
question card (`questions.ts`). `isOther` is a freeform answer, and a
question with no options is freeform; the protocol has no multi-select.
Answers go back as `{ answers: { [id]: { answers: [labels…, typed text] } } }`
(`question`: answered with its first option, and the plan names it). Stop
answers with no answers; a withdrawal or a close sends nothing. Each card
resolves once.

## Steering

`steer` is `turn/steer` with the running turn's id as `expectedTurnId`
(`steering.ts`, `session.ts`). The CLI keeps the same turn, so one
`turn/completed` ends it, and its usage covers both model requests
(`steering`: a steer while `sleep 5` ran, one answer naming the steered word).
A steer is refused with `NotSteerable` — which the server answers by queueing
the message — when no turn runs, the turn is stopping, the turn is a
compaction, or the CLI refuses it ("no active turn to steer").

## Compaction

A turn whose text is `/compact` is `thread/compact/start`
(`compaction.ts`). The CLI runs it as a turn of its own, whose id only its
`turn/started` names, so the session takes the id from there. The
`contextCompaction` item is the compaction row, and the token update after it
reports the smaller context (`compaction`).

## Attachments

An image — decided by its own bytes, never its name — is a `localImage` input
naming the file, which the CLI reads (`image`: the model names a PNG's
colour). Any other file is named by path in the prompt, copied under
`<attachmentsDir>/<threadId>/` when it is not there already. Mentions become
`@path`. A copy or read that fails leaves the original path and a warning,
not a failed turn (`attachments.ts`, `userInput.ts`).

## Resume, model and effort

Resume is covered above. Each `turn/start` names the model (left out for
`default`) and the effort, left out when the listed model does not offer it;
it repeats the approval policy and sandbox only when the mode changed.
`updateSettings` stores the new settings and emits `model.changed` at once, so
the next turn runs on them (`model-switch`: the second turn on another model at
effort `low`, in the same process).

## Capabilities

`CODEX_CAPABILITIES` in `capabilities.ts`, and the recording behind each value:

| Capability     | Value      | Why                                                                                          |
| -------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `modelSwitch`  | `per-turn` | `turn/start` names the model; `model-switch`                                                 |
| `effortSwitch` | `per-turn` | `turn/start` names the effort; `model-switch`                                                |
| `steering`     | `true`     | `turn/steer` into the running turn; `steering`                                               |
| `planMode`     | `true`     | `collaborationMode: plan`, the plan item proposed; `plan-accept`                             |
| `subagents`    | `false`    | collaboration agents become a plain `task` row, not Poseidon's tasks                         |
| `images`       | `true`     | `localImage` inputs; `image`                                                                 |
| `resume`       | `true`     | `thread/resume` from a new process; `resume`, `resume-missing`                               |
| `fork`         | `false`    | `thread/fork` exists; nothing in Poseidon needs it                                           |
| `interrupt`    | `turn`     | `turn/interrupt`, and the same process answers the next turn; `interrupt`                    |
| `rollback`     | `false`    | `thread/revert` exists; Poseidon's checkpoints are git                                       |
| `compaction`   | `true`     | `thread/compact/start`; `compaction`                                                         |
| `questions`    | `true`     | `item/tool/requestUserInput`; `question`                                                     |
| `runtimeModes` | all three  | `untrusted` everywhere, the ladder decides; `edit-approval`, `deny`, `sensitive-full-access` |
| `attachments`  | `files`    | images as inputs, anything else by path                                                      |

The conformance suite runs against the `conformance` recording in the gate,
approval case included.

## Extensions

The Customize page and the composer's `/` menu read these through the
connector-sdk's generic extensions. `CodexConnectorOptions.codexHome`
(`BootOptions.codex` on the server) redirects both for tests; otherwise they
use the instance's `codexHome`, else `~/.codex`.

**Skills** (`extensions/skills.ts`) are read, never written, from the roots
0.156.1 itself loads — checked against its app-server's `skills/list` on a
scratch `CODEX_HOME` and repo: the project's `.codex/skills` and
`.agents/skills`, then `CODEX_HOME/skills` and the shared `~/.agents/skills`.
A skill is `<root>/<entry>/SKILL.md`, named and described by its frontmatter;
the first root with a name wins, project before user. `CODEX_HOME/skills/.system`
holds the skills the CLI ships with and is not listed. There is no
`available`/`link`: Codex already loads every skill in `~/.agents/skills`, so
there would never be one to offer.

**MCP servers** (`extensions/mcpServers.ts`) go through the CLI's own
`codex mcp` commands, so the CLI keeps owning its TOML and Poseidon has no
TOML code: `list` is `codex mcp list --json`, `add` is `codex mcp add <name>
--url <url> [--bearer-token-env-var VAR]` or `codex mcp add <name> [--env K=V]
-- <command> <args…>`, and `remove` is `codex mcp remove <name>`, each with the
default-deny environment and the instance's `CODEX_HOME`, from the temp
directory. The CLI cannot carry an ownership marker on an entry, so the names
Poseidon added are kept in a ledger beside its config,
`CODEX_HOME/poseidon-mcp.json`; `managed` is membership in it. `add` over a
server of the same name the user configured is `conflict` (the CLI would
overwrite it silently), and so is `remove` of one; a ledger that cannot be
read counts as empty, so it fails toward refusing. What the CLI cannot write is
`invalid`, naming the fix: the project scope, a disabled server, and any
header but `Authorization: Bearer ${VAR}` (which is the bearer flag). A name
the CLI rejects comes back `invalid` in its own words. Listing shows the
CLI's literal headers, its per-header variables as `${VAR}`, and its bearer
variable as `Authorization: Bearer ${VAR}`. `mcp-servers` is this recorded
end to end on a scratch `CODEX_HOME` holding one hand-written server.

The per-thread `poseidon` server is not in this list: it is added per session
through `-c` (see the launch), never written to the config.

## Known CLI behaviour worth remembering

- **`login status` prints to stderr.**
- **The app-server exits 0 when its stdin closes,** which is how a session
  ends before any signal.
- **Its messages carry no `jsonrpc` member.**
- **`remoteControl/status/changed`** arrives on every connection and carries
  the host name and an installation id; the recorder scrubs both.
- **Commands run in a login shell,** `/bin/zsh -lc '…'` on the recording
  machine, which is why the gate unwraps them.
- **A stopped turn's items can be reported after the next turn started**
  (`approval-stop`).
- **`codex mcp add` overwrites a server of the same name without asking,**
  and `codex mcp remove` of a missing name exits 0 ("No MCP server named …
  found"). The extension checks the list first for both.
- **`CODEX_HOME` must exist,** or every command fails.
- **`thread/resume` of an unknown id fails with "no rollout found"**
  (`resume-missing`).

## After a new CLI release

The CLI updates on its own schedule. These catch drift, in the order they
tell you:

1. **`recordedFrames.test.ts`** translates every recorded launch and fails on
   any `event.unmapped`, and on a manifest older than `OLDEST_TESTED_VERSION`.
2. **The replayed suites** — `conformance.test.ts`, `recordedSession.test.ts`,
   `recordedInteractions.test.ts`, `recordedMcpTool.test.ts`,
   `extensions/mcpServersRecorded.test.ts`.
   The replayer exits 97 on any line the connector sends that the recorded run
   was not sent.
3. **The live suite**, the only thing that proves the CLI installed today is
   signed in and still speaks every method the connector uses:

   ```sh
   POSEIDON_LIVE_CODEX=1 POSEIDON_HOME=/tmp/poseidon-codex \
     pnpm -F @poseidon/connector-codex vitest run src/liveConformance.test.ts
   ```

   It generates the CLI's JSON schema (`app-server generate-json-schema
--experimental`) and asserts every request and notification the connector
   sends, and every server request and notification it handles, is still in
   it; then runs the conformance suite, a plain turn with nothing unmapped, an
   approval allowed once that writes its file, and a plan turn that proposes
   its plan, on the CLI's default model.
   `POSEIDON_LIVE_CODEX_HOME` points it at a separate account, and
   `POSEIDON_LIVE_CODEX_DEBUG=1` prints the connector's log lines and every
   event type.

4. **Re-recording**, when something did change: the commands are in
   [development.md](development.md#making-one), and a recording is never
   edited by hand. Recording on a newer release is when
   `OLDEST_TESTED_VERSION` and `PROTOCOL_CLI_VERSION` move.

Beyond the tests, read the new release's bindings
(`codex app-server generate-ts --experimental --out <scratch dir>`) for a
changed field in `protocol.ts`'s schemas, a new item type for the tool
vocabulary, a new server request, and whether `collaborationMode` and
`requestUserInput` are still experimental; and check again whether
`untrusted` still asks about reads.
