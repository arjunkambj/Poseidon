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

The recordings come in two sets. The first was made while the CLI on the
recording machine was signed out (2.1.280): the launch, the handshake, the
control requests, the message receipts and the CLI's refusals, exactly, and
nothing a model did. The second was made once it was signed in (2.1.286, on
the CLI's default model, which on the recording account runs as Opus 5.5):
answered turns, tool calls and their cards, a plan, a question, a subagent and
a stopped one, an interrupt, a steer, a resume, a model switch, an image, one
piece of generated text, and the conformance suite with its approval case —
which is owed, not optional, because Claude Code can be made to ask on demand
([philosophy.md](philosophy.md#4-a-connectors-promises-are-executable)).
`packages/testkit/fixtures/claude/README.md` lists each. Where a claim still
rests on the SDK's declarations or on reading the CLI's own bundled code
instead of a recording, this document says so, and
[Still waiting](#still-waiting) lists everything that does, with what would
settle it.

Its companions: [architecture.md](architecture.md#the-claude-code-connector)
for the shape of the connector inside Poseidon,
[how-it-works.md](how-it-works.md) for what the rest of the app does with what
comes back, and [development.md](development.md#the-claude-code-end-to-end-suite)
for the commands that run and record it.

## Where the code is

The connector is `packages/connector-claude`. It implements the
`ConnectorDefinition` interface of `packages/connector-sdk`, and
`apps/server/src/boot.ts` registers it first, so a thread that picks no
instance runs on Claude Code whenever its probe says it can run.

| module                    | what it owns                                                               |
| ------------------------- | -------------------------------------------------------------------------- |
| `definition.ts`           | the `ConnectorDefinition`: probe, instance, start and resume, models       |
| `configSchema.ts`         | `binaryPath`, `configDir`, `defaultModel`, and the settings form           |
| `binary.ts`               | which executable `claude` means, and how to spell a command for the user   |
| `env.ts`                  | the default-deny child environment                                         |
| `probe.ts`                | `--version`, `auth status --json`, the zero-turn handshake, version floor  |
| `models.ts`               | the CLI's model rows and their effort ladders                              |
| `commands.ts`             | the CLI's own slash commands, for the composer's `/` menu                  |
| `capabilities.ts`         | what a Claude Code session can do, and why                                 |
| `spawn.ts`                | the SDK's `spawnClaudeCodeProcess`: a process group, and proof it is gone  |
| `queryOptions.ts`         | the SDK options a session starts with; runtime mode → permission mode      |
| `flagSettings.ts`         | effort and ultracode switched mid-session in one `applyFlagSettings` call  |
| `generateText.ts`         | one piece of text outside any session: a one-shot, tool-less `query()`     |
| `inputQueue.ts`           | the streaming-input prompt the session writes user messages to             |
| `userMessage.ts`          | one composer turn as the user message the CLI reads                        |
| `references.ts`           | skill and plugin references as prompt lines                                |
| `pluginOptions.ts`        | Poseidon's enabled plugins as SDK `plugins` and `mcpServers` entries       |
| `plugins.ts`              | the `plugins` extension: Claude Code's own installed plugins, read-only    |
| `skills.ts`               | the `skills` extension: the user's and project's skills, and linking       |
| `mcpServers.ts`           | the `mcpServers` extension: user and project servers, through `claude mcp` |
| `cli.ts`                  | one short CLI command for an extension, in the default-deny environment    |
| `sessionFiles.ts`         | the `sessions` extension: the CLI's own transcripts, read for an import    |
| `attachments.ts`          | images as content blocks, other files by path                              |
| `session.ts`              | one long-lived CLI process per thread: send, steer, interrupt, close       |
| `sessionRef.ts`           | the persisted session reference                                            |
| `toolGate.ts`             | the PreToolUse hook and `canUseTool`, both through the permission ladder   |
| `approvals.ts`            | the CLI's tool names in Poseidon's approval vocabulary                     |
| `interactions.ts`         | the question and plan cards AskUserQuestion and ExitPlanMode open          |
| `questions.ts`            | AskUserQuestion's input and the answer it takes back                       |
| `plans.ts`                | the plan ExitPlanMode hands over, and the CLI's plan file                  |
| `steering.ts`             | when a steered turn is over, and its summed usage                          |
| `translate/`              | SDK messages → `RuntimeEvent`s                                             |
| `translate/tools.ts`      | the tool rows                                                              |
| `translate/subagents.ts`  | tasks, and the rows nested under them                                      |
| `translate/compaction.ts` | the compaction row                                                         |
| `translate/notices.ts`    | the CLI's notices: warnings, and the ones left out on purpose              |
| `translate/result.ts`     | a `result` → usage, context and the turn's completion                      |

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
harness is the user's. `OLDEST_TESTED_VERSION` in `probe.ts` is the oldest
release the recordings were made at, **2.1.280**. Below it the probe adds a
warning; at or above it, it says nothing; a version string that does not parse
is not refused. The floor moves only when the recordings are made again on a
newer release, and `recordedFrames.test.ts` fails if any recording's manifest
names a CLI older than it. The signed-in recordings are at 2.1.286, but the
signed-out ones stay at 2.1.280: a CLI that is signed in cannot make them
again, and they are the only record of its refusals. So the floor stays at
2.1.280 until both sets are made on one release.

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

## Claude Code's own plugins

The instance carries the `plugins` extension (`plugins.ts`), so the composer's
`@` menu and the Customize page list the plugins the CLI itself has installed,
next to Poseidon's. It reads the CLI's files and runs nothing, so it works
signed out, and it never writes: installing, enabling and removing stay with
`claude plugin`.

- `<config>/plugins/installed_plugins.json` (version 2) maps
  `name@marketplace` to its installs. `<config>` is the instance's
  `CLAUDE_CONFIG_DIR`, else `~/.claude`. A missing file lists none, and so
  does a layout other than version 2; a file that is not JSON fails with its
  path.
- A `project` or `local` install names its project and is listed only for
  that project's workspace root.
- Whether a plugin is enabled comes from `enabledPlugins` in
  `<config>/settings.json`, overlaid in a project by its
  `.claude/settings.json` and then `.claude/settings.local.json`. A plugin no
  file names is enabled.
- The description is the plugin's own `.claude-plugin/plugin.json`
  `description`; the marketplace is the row's source.

The tests read `packages/testkit/fixtures/claude/plugins/`, the files the real
CLI wrote when it installed two plugins into a scratch config (its README says
how).

## Claude Code's own skills

The instance carries the `skills` extension (`skills.ts`), so the composer's
`/` and `$` menus and the Customize page's Skills tab list the skills a session
loads, and the tab gives Claude Code its first section. It reads the two roots
the user and project settings sources keep them in, `<config>/skills`
(`<config>` as for plugins) and `<workspaceRoot>/.claude/skills`, one skill per
`<entry>/SKILL.md`, named and described by its frontmatter; a user skill wins
its name, as it does in the CLI (personal over project), and dot entries are
skipped. Skills a plugin carries are listed with the plugin.

The CLI does not load the shared agents folder, `~/.agents/skills`, so the
extension also offers the skills there that the user root does not hold yet,
by entry or by name, and links one in as a relative symlink — the shape the
skills installer writes. The link's path is taken between real directories, so
a `~/.claude` that is itself a symlink into a dotfiles repo still gets one that
resolves, and a link whose target is gone is replaced. Nothing else is written.

## Claude Code's own MCP servers

The instance carries the `mcpServers` extension (`mcpServers.ts`), so the
Customize page's MCP tab lists, adds and removes the servers a session loads,
and Claude Code, the default harness, has the tab's first section. Poseidon's
two scopes map onto two of the CLI's:

- user: `mcpServers` in `<config>/.claude.json` — `$CLAUDE_CONFIG_DIR/.claude.json`
  for an instance with an account of its own, else `~/.claude.json`;
- project: `mcpServers` in `<workspaceRoot>/.mcp.json`.

The CLI's third scope, `local` (a project's entry in `.claude.json`, private to
one user), has no Poseidon scope and is not listed.

`.claude.json` is the CLI's own file, rewritten by every CLI that runs, so
Poseidon never writes it, nor `.mcp.json`. Writes go through the CLI's own
commands, spawned with the default-deny environment and the instance's
`CLAUDE_CONFIG_DIR` (`cli.ts`): `claude mcp add-json --scope user|project --
<name> <json>` and `claude mcp remove --scope user|project -- <name>`, run in
the workspace for the project scope, where the CLI finds `.mcp.json`, and in
the system temp directory otherwise. The name follows `--`, so one that looks
like a flag stays the server's. Reading is a read-only parse of the two files
rather than `claude mcp list` or `get`, because both health-check what they
list: they start every stdio server and connect to every http one, which a
page that only shows the entries has no business doing. An entry is `stdio`
(`command`, `args`, `env`; a bare `command` with no `type` is stdio too) or
`http` (`url`, `headers`); `sse` is shown as http, and anything else, `ws`
included, is not listed.

Ownership is kept in a ledger beside the config, `<config>/poseidon-mcp.json`
(`<config>` as for plugins), naming the servers Poseidon added in the user
scope and, per workspace, in the project scope. A server the ledger names is
`managed`; `add` refuses a name the user configured themselves in that scope
and `remove` refuses to delete one, both with `conflict`, and a ledger that
cannot be read counts as empty. The CLI refuses to add a name its scope already
holds, so editing one of ours is a remove and an add; when the add fails, the
entry as it was is added back before the failure is reported.

A file that exists but does not parse lists nothing, and every write to its
scope is refused with `conflict`: the CLI, finding its `.claude.json`
corrupted, backs it up and starts a fresh one, which would take the user's
other servers out of use. What the CLI cannot express is refused with
`invalid`: a disabled server, since the CLI adds servers enabled and turns one
off per project from `/mcp`, and the name `poseidon`, which every session gives
Poseidon's own MCP server. That server and a plugin's servers are passed per
session on the command line (`queryOptions.ts`), so they are in neither file
and never listed. Every listed server is shown enabled.

`fixtures/claude/mcp-servers/` is the extension run against 2.1.286 on a
scratch config and workspace (`mcpServersRecorded.test.ts`); it records the
CLI's `add-json` and `remove` answers, and what the CLI left in the two files
after each, which the replay puts back.

## Session files

The instance carries the `sessions` extension (`sessionFiles.ts`), which
lists the conversations the CLI recorded on its own and reads one back so it
can be imported as a thread. It opens the transcripts read-only and writes
nothing, beside them or anywhere.

- Transcripts are `<config>/projects/<directory>/<session id>.jsonl`, with
  `<config>` the instance's `CLAUDE_CONFIG_DIR`, else `~/.claude` — where a
  `--resume` looks, so an imported thread carries the conversation on. The
  directories beside them (a session's subagents) are not read.
- `list` takes the newest files by last write, at most 200, and reads only the
  first 256 KB of each for its directory, first prompt and message count, plus
  the last 64 KB for a title set late. The title is the last `custom-title`
  (the user's), else the last `ai-title`, else the first prompt cut to 80
  characters. A file longer than the head is listed without a count rather
  than with a short one.
- `read` reads the whole file a line at a time. It keeps `user` prompts (a
  string, or an array's `text` blocks) and the `text` blocks of `assistant`
  replies, joining the records of one reply by `message.id`. It skips `isMeta`
  and `isSidechain` records, a compaction's summary (`isCompactSummary`, the
  CLI's text rather than the user's; the messages it sums up stay in the file),
  tool results, the CLI's own wrappers (`<command-name>`,
  `<local-command-stdout>`, task notifications, …), the `<synthetic>` model's
  replies, every other record type, and lines that are not JSON. It keeps the
  newest 500 messages within a million characters and counts them all.
- The session reference it returns is `{ sessionId, cwd }`, the shape
  `sessionRef.ts` parses, so the thread's first turn resumes the conversation;
  if the CLI no longer has it, the session starts a new one and says so, and
  the server sends the imported messages with the first turn instead.
- `sourceIdOf` answers the `sessionId` of a thread's persisted reference, so
  the list names the sessions Poseidon's own threads run as those threads
  rather than as sessions to import.

The tests read `packages/testkit/fixtures/claude/session-files/`: hand-built
transcripts in the CLI's record shapes with made-up content (its README says
what each holds).

## The probe

`probe` in `probe.ts` asks three questions of the binary a session would run,
under the environment a session would get (`env.ts`), from the system temp
directory. `fixtures/claude/probe/` is the probe recorded signed out, and
`fixtures/claude/probe-signed-in/` the same probe once the CLI was signed in.

When no `claude` resolves, the probe asks nothing and reports
`not-installed` with `installCommand`, `npm install -g
@anthropic-ai/claude-code` (`INSTALL_COMMAND`), the package the CLI ships
as. That is the line the connectors page and the harness banner offer to
copy or run.

1. **`claude --version`** prints `2.1.286 (Claude Code)`. A non-zero exit or
   an unparsable answer is status `error`, with the CLI's own output as the
   message.
2. **`claude auth status --json`** prints a document with `loggedIn`,
   `authMethod` and `apiProvider`, and, signed in, the account's `email`,
   `orgId`, `orgName` and `subscriptionType` (on a claude.ai login,
   `authMethod: "claude.ai"`, exit 0). Signed out it prints `loggedIn: false`,
   `authMethod: "none"` **and exits 1**, so the output is read whatever the
   exit code. `loggedIn` true is
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
`supportedEffortLevels` (`low` to `max` in the recordings; `haiku` has none).
Signed out the list has five rows. Signed in, the recording account's has
twelve: `default` (Opus 5.5 there), `opus`, `claude-fable-5-1`, `sonnet`,
`haiku`, and seven dated or older models, of which `claude-opus-4-6` and
`claude-sonnet-4-6` offer every rung but `xhigh`.
`toModelOptions` (`models.ts`) keeps every row, labels it with its display
name, groups it under "Claude", and keeps the effort rungs Poseidon's ladder
knows. The row's `description` (for example "Sonnet 5 · Efficient for routine
tasks · $2/$10 per Mtok") is carried as the model's `description`, which the
UI shows as secondary text; an absent or blank one is left out. `listModels`
runs the same handshake once per instance and caches the result, so the model
picker does not start a CLI every time it opens.

`commands` is the CLI's slash commands (the SDK's `SlashCommand`: `name`,
`description`, `argumentHint`, and `builtin` on Claude Code's own ones). The
instance's `commands` extension answers them through `connectors.commands.list`
from the same cached handshake as the models: one CLI start per instance for
both, and asks that arrive together wait for the one in flight. A failed
handshake is not cached and answers `ConnectorExtensionFailed` with code
`internal`. `toHarnessCommands` (`commands.ts`) strips a leading `/`, leaves out
an empty description or argument hint, drops the CLI's internal rows, and keeps
one row per name: the built-in one when a row is marked, otherwise the first.
2.1.280 lists its plumbing beside the commands a user runs, all marked
built-in: a name led by `_` (`__remote-workflow`), `workflow-launch-exec`,
`heapdump`, and retired commands whose description starts `(removed)`; these
are dropped. Signed in, 2.1.286 lists the same plumbing among 55 rows, and one
more kind of retired row, a command kept as a pointer to its new name
(`extra-usage`, "Renamed to /usage-credits"), which is dropped too. That list
was read from the signed-in probe's capture before the recorder scrubbed it.
Because the handshake runs with `settingSources: []`, the list holds only the
CLI's built-in and bundled commands. The user's and the project's own
commands (`.claude/commands`, plugins, MCP prompts) are not listed, though the
CLI still runs them when a message names one. For the same reason the list
does not depend on the project, so the extension ignores its scope. The
recorder scrubs the command list down to one `scrubbed-entry` row, so the
replayed tests (`definition.test.ts`, `models.test.ts`) assert on that row,
and the mapping is unit-tested on the SDK's declared fields and on rows shaped
like the handshake lists of 2.1.280 signed out and 2.1.286 signed in
(`commands.test.ts`).

The account comes from `auth status` first and from the initialize response's
`account.email` otherwise. The recorded, signed-out response says only
`tokenSource: "none"`; signed in it carries `email`, `organization`,
`subscriptionType` and `apiProvider`.

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

| option                            | value                                                                 |
| --------------------------------- | --------------------------------------------------------------------- |
| `pathToClaudeCodeExecutable`      | the resolved binary                                                   |
| `spawnClaudeCodeProcess`          | `spawn.ts`'s, so the CLI leads a process group of its own             |
| `env`                             | `childEnv`                                                            |
| `cwd`                             | the thread's workspace root                                           |
| `sessionId` / `resume`            | a fresh id we mint, or the ref's id to resume                         |
| `settingSources`                  | `user`, `project`, `local`                                            |
| `systemPrompt`                    | the CLI's own preset (`claude_code`)                                  |
| `includePartialMessages`          | true: text and thinking stream as deltas                              |
| `forwardSubagentText`             | true: a subagent's text arrives, not only its tool calls              |
| `permissionMode`                  | from the thread's modes (see [Runtime modes](#runtime-modes))         |
| `allowDangerouslySkipPermissions` | true, which the SDK requires before `bypassPermissions` can be used   |
| `model`, `effort`                 | the thread's; left out for `default`, `minimal` or `ultra` effort     |
| `settings`                        | `{ ultracode: true }`, with `effort` xhigh, only when ultracode is on |
| `mcpServers`                      | `poseidon`, over HTTP, with the per-thread bearer                     |
| `plugins`                         | the enabled Poseidon plugins, only when there are some (below)        |
| `additionalDirectories`           | the thread's attachments directory                                    |
| `hooks`                           | one PreToolUse callback, for every tool                               |
| `canUseTool`                      | the approval gate                                                     |
| `maxTurns`, `maxBudgetUsd`        | only when a test or recording sets them; production sets neither      |

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

**Poseidon's plugins.** The session asks the host for its enabled plugins
(`ConnectorServices.sessionPlugins`) once, at start; a registry that fails is
a logged warning and no plugins. Each goes in as
`{ type: "local", path: <plugin dir>, skipMcpDiscovery: true }`, which the SDK
passes as `--plugin-dir`, so the CLI loads its skills, commands, agents and
hooks as it would any plugin (`pluginOptions.ts`). Its MCP servers do not come
from the CLI's own discovery: the registry has already read `.mcp.json` and
expanded `${CLAUDE_PLUGIN_ROOT}`, so they join `mcpServers` as
`plugin-<plugin>-<server>` — a key that can never be `poseidon`. With no plugin
enabled neither option changes, so the argv above is still the argv. The plugin
layout and the registry are described in [plugins.md](plugins.md).

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
it. `system/init` reports the server's status, with source `dynamic`. In the
connector-level recordings it is `failed`, because those tests point it at a
port nothing listens on; through the real server it is `connected`. A
signed-in account's init also lists the claude.ai connectors the account has
(source `claudeai`), some `needs-auth`, with their tools, and the CLI tells the
model about the ones that need authorising, which it then tends to mention in
its answer. The recorder replaces their names.

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
mention as `@path`, then one line per skill reference and one per plugin
reference (`Use the "<name>" skill.` / `Use the "<name>" plugin.`, each name
once; `references.ts`), then one line per non-image attachment. A turn with no
images is sent as a plain string. A turn with images is sent as content
blocks, images first and the text last, because the CLI reads a message as a
slash command only when its last block is text.

A CLI that stops while the session is open is a crash: a fatal
`runtime.error` naming the last stderr line, read once stderr has ended, then
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
| `user` message "[Request interrupted by user]", alone or beside results     | nothing: the turn's stop reason says it                                               |
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
kept. Its row is still completed, with no text. Under the CLI's default
thinking display (the connector passes no `--thinking-display`) every one does
on 2.1.286: the `thinking_delta`s carry empty strings and the snapshot's block
only a signature, in every signed-in recording, so a reasoning row marks where
the model thought and holds no text. The timeline draws such a row as a plain
"Reasoning" line with nothing to open; it still drives the live step's
"Thinking…" and how long the model thought. A row still open when the turn's
`result` arrives is completed there with the text its deltas grew, so none
stays in progress after the turn.

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

`rate_limit_event` is in every signed-in recording, status `allowed` on every
turn, which maps to nothing; so are `system/thinking_tokens` estimates and
`system/commands_changed`, left out on purpose (`translate/notices.ts`). None
of the other notices is recorded: each needs a CLI that retries, refuses or
nears a limit, so their reading rests on the SDK's declarations
(`translate/notices.test.ts`). A refused answer that a fallback
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
Signed in, 2.1.286 adds `RemoteTrigger` and, beside MCP servers that offer
resources, `ListMcpResourcesTool`, `ReadMcpResourceTool` and
`ReadMcpResourceDirTool`. The list names `Task`, but the model's delegations
are `Agent` calls in every recording that has one. ExitPlanMode is deferred:
in `plan-accept` the model fetched it with `ToolSearch` (`select:ExitPlanMode`)
before calling it.

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
said `ask` is recorded. In `sensitive-full-access` the CLI ran in
`bypassPermissions`, the hook answered `ask` for `cat .env`, and the CLI asked
`canUseTool` (`decision_reason_type: "hook"`) and kept its deny. In `subagent`
a subagent's `find` named `.git`, also a sensitive path, and asked the same way
under full access. The SDK warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` when a
session starts in `bypassPermissions` with a `canUseTool`, saying the callback
will not be asked; for a call a hook asks about, it is.

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
either, since they run commands or change the working directory. Recorded so
far: Agent passing with no verdict under full access (`subagent`), and
ToolSearch in a plan turn (`plan-accept`), which the ladder would have
refused. The others have not been called in a recording, and neither has
Skill.

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
calls ExitPlanMode, whose input the CLI fills with the file's markdown and
path (`plan`, `planFilePath`) before it asks `canUseTool`. `plan-accept` shows
the whole of it: the model read `app.js` (a read, allowed), fetched
ExitPlanMode with ToolSearch, wrote `<config dir>/plans/<slug>.md` (no
verdict from the hook; the CLI's plan mode allowed it), and called
ExitPlanMode. Refused with `PLAN_CAPTURED`, it answered with one line and the
turn ended `end_turn`. Accepted, the next turn ran in `default` mode, edited
`app.js` on an allowed card, and checked the result with a `node` command on
another.

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
and that next turn runs out of plan mode.

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
recorded `system/init` tool list has it. `question` shows a card answered: the
model called it directly with one single-choice question, a header and four
colours; the card took the first, the CLI handed the model
`"Which colour …?"="Red"` as the tool's result, and the model wrote `red` to
`colour.txt` on an allowed card.

## Subagents

A Task or Agent call's row is a task row, and `task.started` goes out beside it
with the call's `description` as title and its `model` when it sets one. The
CLI's `task_started`, `task_progress`, `task_updated` and `task_notification`
system messages name the call's `tool_use_id`, or a `task_id` their
`task_started` tied to it. They become `task.updated` while the task runs and
`task.completed` once it settles: `completed`, or `failed` for a failure, a
kill or a stop. The same messages report a shell command the CLI waited on
long enough to track (`task_type: "local_bash"`, `is_backgrounded: false`;
`steering`'s `sleep 5`): its row settles with its own result, so they add
nothing. A task_* message for a background shell command — whose row settled
with the CLI's placeholder when the command was launched — or of a kind the
connector does not know is kept as `event.unmapped`, whole, until a recording
shows how it maps onto that row; one for a task already settled restates it
and adds nothing.

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
`subagent` shows a delegation end to end, in this order: the Agent call,
`task_started` naming it, the prompt the subagent was handed as a user message
of its own (not shown again), `task_progress`, the subagent's `find` asked
about and allowed, its result and answer, then `task_updated` with
`completed`, `task_notification`, and only then the Agent call's own result.
So a task settles before the call's result arrives, and no late lifecycle
message finds a finished row to move.

Stopping one subagent (`stopTask` on the handle) calls the SDK's `stopTask`
with the CLI's `task_id` that the task's `task_started` tied to its call; the
CLI then reports the task stopped, which settles the row as failed, and the
turn goes on. A row whose task has settled, or whose id no `task_started` has
named yet, has nothing to stop. `subagent-stop` shows it: the `stop_task`
request, then `task_updated` with `killed`, `task_notification` with
`stopped`, the subagent's own "[Request interrupted by user]", and the Agent
call's result as an error, "[Request interrupted by user for tool use]". The
model then answered on its own and the turn ended `end_turn`.

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
on stderr (2.1.286, run by hand with an unknown id: that line on stderr, a
`result` with subtype `error_during_execution` carrying it in `errors` on
stdout, exit 1, and no request), which the SDK does not read from a custom
spawn, so a failed
handshake's `SpawnFailed` carries the end of the CLI's stderr (at most 500
characters) after the SDK's own message. The line can land after the CLI's
exit, which is when the SDK rejects, so the tail is read once the stderr
stream has ended (`drained` in `spawn.ts`), waiting at most two seconds.
`resume` shows a second turn recalling the first after a restart: the second
server's launch is `--resume=<id>`, its init names the same id, and the answer
is the word the first turn was told.

Rollback and fork are not offered (`rollback: false`, `fork: false`). The SDK
can rewind (`resumeSessionAt`) and fork (`forkSession`), but the connector
uses neither and no recording exercises either, and Poseidon's checkpoints are
git, which does not depend on them.

## Model and effort

`updateSettings` switches the model with the SDK's `setModel`, which sends no
model for `default` so the CLI's own default applies again. It switches the
effort with `applyFlagSettings({ effortLevel })` — one call, which also names
`ultracode` when that changed too ([Ultracode](#ultracode)). Both act on the
running process from its next request, and
`fixtures/claude/session-controls/` has the CLI answering `set_model` (an
explicit id, and none) and `apply_flag_settings` with success, in one process
with no restart. `model-switch` does it signed in between two answered turns:
`set_model` to the id the default runs as and `apply_flag_settings` with
effort `low`, both taken, the same session id before and after, and the
second turn answered. The session then emits `model.changed` with what the
CLI runs on: the new pick once the CLI took it, the previous one when it
refused, so the thread never shows a model, effort or ultracode the session
is not using.

The thread model `default` leaves the SDK's `model` option out altogether. On
the recording account the CLI's `system/init` named what it resolved to, and
that is the id each manifest's `model` records. Poseidon's `minimal` and `ultra`
efforts have no rung in the CLI and are left out, so the CLI's default effort
applies (`ultra` is Codex's multi-agent rung; Claude Code's counterpart is the
ultracode session mode, not an effort).

## Ultracode

Ultracode is a Claude Code session mode: xhigh effort plus standing
dynamic-workflow orchestration, in which the model may launch the CLI's
Workflow tool on its own. It is a setting, not an effort rung and not a slash
command. The thread keeps it as `ThreadSettings.ultracode`, off when absent,
and the server's rules keep it consistent with the effort (on sets xhigh, off
keeps the effort, an effort pick turns it off; see
[architecture.md](architecture.md)). The evidence is the SDK's declarations,
the CLI's bundle, and one live check, which settled what the bundle had wrong:

- **The SDK** (0.3.280, `sdk.d.ts`) declares `Settings.ultracode?: boolean` —
  "Enable ultracode for the session: xhigh effort plus standing
  dynamic-workflow orchestration", session-scoped, "typically provided via
  --settings or the apply_flag_settings control request", and requiring
  "workflows to be enabled and an xhigh-capable model".
  `Query.applyFlagSettings` merges into the flag settings layer "only in
  streaming input mode", which is the mode a session runs in, and a `null` or
  `false` `ultracode` resets it "to off with the current effort kept".
- **The CLI** (2.1.280, `strings` on `bin/claude.exe`) reads `ultracode` from
  its merged settings at start. Its SDK handler for `apply_flag_settings`
  applies `effortLevel` first, then `ultracode`. Whether workflows run is
  decided per request: ultracode is in force only while workflows are enabled
  (managed settings, org policy, `disableWorkflows`, availability) and the
  effort allows it; `get_settings` reports that as `applied.ultracode`. The
  bundle reading had the effort needing to resolve to xhigh, and the flag
  raising the effort to xhigh at start; the live check found neither.
- **The live check** (2.1.286, signed in, a Max account, 2026-10-01): the
  headless CLI started as the connector starts it, reading `get_settings`
  after each step, with one trivial turn ("Reply with exactly: ok", which
  started no workflow). `--settings '{"ultracode":true}'` with `--effort xhigh`
  gave `applied.ultracode: true` at xhigh; the flag without the effort gave
  `applied.ultracode: true` at the CLI's default, medium, so the flag does not
  raise the effort. `apply_flag_settings` took `{ ultracode: false }` (applied
  off, effort kept), `{ ultracode: true }` (applied on, effort still where it
  was), `{ effortLevel: "low" }` alone with the flag set (the flag stays in
  the flag layer but is no longer applied) and both keys together (applied on
  at xhigh), each with success. None was refused on this account. So with the
  flag set, `applied.ultracode` was true at xhigh and at medium and false at
  low; high was not tried. The headless CLI honours the flag from both the
  inline settings and `apply_flag_settings`, and the effort the mode runs at
  must be named beside it.
- **The refusal** "apply_flag_settings: ultracode is not available for this
  session (dynamic workflows are off, the model does not support xhigh effort,
  or an effort cap … excludes it)" is in the bundle, in the Remote Control
  handler. The SDK handler has no such gate that the bundle shows, so an
  account without workflows may take the flag and simply never run one; the
  check's account has workflows, so it does not say.
- **The interactive switch** is `/effort ultracode`, a local-jsx command that
  needs the terminal UI and is not reachable over the SDK. There is no
  `/ultracode` command.
- **The keyword.** The word "ultracode" in a prompt opts that one turn into the
  Workflow tool (`settings.workflowKeywordTriggerEnabled`, default true; the
  CLI injects a system reminder). It works through Poseidon today as plain
  text; nothing is added for it.
- **Which models.** `ModelInfo` has no ultracode flag, only
  `supportedEffortLevels`; a model that lists `xhigh` is the per-model proxy
  for "xhigh-capable". `CLAUDE_CAPABILITIES.ultracode` says the session can
  switch the mode at all.

What the connector does:

- **Launch** (`ultracodeLaunchOptions` in `queryOptions.ts`): a thread with
  ultracode on starts the session with the SDK's inline
  `settings: { ultracode: true }` — the `--settings` flag layer — and
  `effort: "xhigh"`, whatever the thread's effort says. Off adds nothing, so
  the launch is exactly what it was before.
- **Mid-session** (`flagSettings.ts`): `updateSettings` makes one
  `applyFlagSettings` call for the effort and the flag together —
  `{ effortLevel }` for an effort alone, `{ ultracode: false }` for the flag
  going off, both keys when both changed, and `effortLevel: "xhigh"` beside
  the flag whenever it goes on, since the CLI does not raise the effort for
  it; no call when neither changed. Taken with ultracode going on, the
  session runs at xhigh. Refused, the effort and the flag go back to what
  they were. Either way `model.changed` says what the CLI runs on, with
  `ultracode` whenever the call named it, so a refusal turns the thread's flag
  back off through the event.
- **`generateText`** never uses ultracode.
- **The Workflow tool** stays gated: it is not one of the no-permission tools
  (`approvals.ts`), so in approval-required each workflow launch asks on a
  card. Its call opens an ordinary tool row, not a task row, so the CLI's
  task_* messages for it (`task_type: "local_workflow"`, with
  `workflow_name`) are kept as `event.unmapped` until a recording shows how
  they map ([Subagents](#subagents)).

The switch the user sees is the composer's Ultracode toggle, beside the plan
toggle, offered where these capabilities carry `ultracode` and the model lists
`xhigh`; picking a model without `xhigh` while it is on also switches it off
([how-it-works.md](how-it-works.md), "Ultracode").

## Writing one piece of text

`generateText` (`generateText.ts`) writes a commit message, a pull request's
text or a thread title outside any session. It is one `query()` with a string
prompt and options that make it a single answer and nothing else:

| option                                    | why                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `maxTurns: 1`, `persistSession: false`    | one answer; no transcript is written (`--no-session-persistence`)                        |
| `settingSources: []`                      | none of the user's settings, hooks, CLAUDE.md or plugins                                 |
| `tools: []`, `allowedTools: []`           | no built-in tool at all (`--tools ""`)                                                   |
| `mcpServers: {}`, `strictMcpConfig: true` | no MCP server, the user's own included                                                   |
| `canUseTool`                              | denies whatever still asks: the call is read-only                                        |
| `model`, `effort`                         | the request's; `default`, `minimal` and `ultra` are left out as for a turn               |
| `systemPrompt`                            | the request's `system`, as the whole system prompt, when given                           |
| `cwd`, `env`, `spawnClaudeCodeProcess`    | a fresh `poseidon-generate-*` temp directory, `childEnv`, and a process group of its own |

The directory is removed after the call, once the process group has been
stopped. The answer is the `result` message's text. An error subtype, a
`success` with `is_error` — which is how the CLI says "Not logged in · Please
run /login" — a result with no text, or a query that ends without one fails
with `GenerationFailed` carrying the CLI's own words (or the tail of its
stderr). A missing binary is `SpawnFailed`.

`jsonSchema` is not sent. The SDK declares `outputFormat` (`json_schema`), but
the CLI delivers it as a `StructuredOutput` tool call that ends the turn, which
is exactly what `tools: []` and the deny-all `canUseTool` refuse, and no
signed-in recording shows which wins. The caller parses the text either way.

`fixtures/claude/generate-text-signed-out/` was made with the CLI signed out:
the SDK turned these options into `--max-turns 1`,
`--tools ""`, `--setting-sources=`, `--strict-mcp-config`,
`--no-session-persistence` and `--effort low`, carried the system prompt in its
`initialize` request, and the CLI's `system/init` listed no tools and no MCP
servers before it refused for the login. `generateText.test.ts` replays it
through the definition and gets that refusal as `GenerationFailed`.
`fixtures/claude/generate-text/` is the same call signed in: the same argv,
an init with no tools and no MCP servers, one request on the default model
(a third of a cent at list price), and "Fix Flaky Login Test" as the result's
text, which the test replays as the answer.

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
  menu, though the CLI still runs them when typed. The CLI's internal and
  retired rows are dropped by the connector (see [The probe](#the-probe)).
- **What is left out** (`slash-menu.tsx`): every name Poseidon's own entries
  take (`model`, `effort`, `mode`, `plan`, `default`, `clear-draft`, and
  `compact` even while it is hidden), every enabled skill's name, and `clear`,
  which would reset the conversation behind the timeline.
- **Command Code** has no such extension; its `/` menu shows no Harness group
  ([command-code-connector.md](command-code-connector.md)).
- **No `/ultracode`.** The CLI has no such command — its switch is
  `/effort ultracode`, which needs the terminal UI — so the menu gets no
  entry for it ([Ultracode](#ultracode)).

## Attachments

`attachments.ts` sniffs each attached file's bytes
(`@poseidon/shared/imageBytes`). PNG, JPEG, GIF and WebP go to the model as
base64 image content blocks ahead of the text (`session-controls` has the CLI
reading such a message). Any other file is named by its path in the prompt,
as Command Code's are: the server's staged file where it is, and a file from
anywhere else copied into the thread's attachments directory first. That
directory is among the CLI's `additionalDirectories`, so the model can read
what is named there. A file that cannot be read or copied is still named, with
a `session.warning` saying why. `image` shows a model answering from one: a
2×2 red PNG staged through the server went as a block, and the model named its
colour without a tool call.

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
own. `steering` records the other way, a message folded into a running loop:
written while the turn's `sleep 5; echo one` ran, it was receipted `queued`,
`started` once the command's result was in and before the next request, and
the turn's one `result` answered both messages.

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
`interrupt` shows what an interrupt leaves: the CLI answered the request at
once (`still_queued: []`), wrote the partial snapshot, its "[Request
interrupted by user]" line as a user message, and a `result` with subtype
`error_during_execution`, `is_error` true and `terminal_reason:
"aborted_streaming"`, and receipted the message `cancelled`. The turn ends
`interrupted`, with no error row. The next message went to the same process
and session id, and was answered.

## Capabilities

`CLAUDE_CAPABILITIES` in `capabilities.ts`, and why each value is what it is:

| Capability       | Value        | Why                                                                                                                                                                                                   |
| ---------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelSwitch`    | `in-session` | `setModel` on the running process; `session-controls`, and `model-switch` signed in                                                                                                                   |
| `effortSwitch`   | `in-session` | `applyFlagSettings({ effortLevel })`; `model-switch` has the call taken and the next turn answered by the same process, and the ultracode live check read each new effort back through `get_settings` |
| `steering`       | `true`       | one more message to the running CLI, the turn held by its receipts; `steering` (folded into the loop) and `signed-out-steer` (run next); `false` once the CLI's init lists no `msg_lifecycle_v1`      |
| `planMode`       | `true`       | permission mode `plan`, the plan handed over through ExitPlanMode; `plan-accept`                                                                                                                      |
| `subagents`      | `true`       | Agent calls, the task_* messages, and nested rows; `subagent`                                                                                                                                         |
| `images`         | `true`       | image content blocks; `image` has the model naming the picture's colour                                                                                                                               |
| `resume`         | `true`       | `resume: <sessionId>` against the CLI's own transcript; `resume`                                                                                                                                      |
| `fork`           | `false`      | the connector never calls `forkSession`, and no recording forks a session                                                                                                                             |
| `interrupt`      | `session`    | `Query.interrupt()` inside the one long-lived process; `interrupt` has the next message answered by the same process                                                                                  |
| `stopTask`       | `true`       | `Query.stopTask(task_id)` with the CLI's id for the row; `subagent-stop`                                                                                                                              |
| `rollback`       | `false`      | `resumeSessionAt` exists, but the connector never calls it and no recording rewinds; Poseidon's checkpoints are git                                                                                   |
| `compaction`     | `true`       | `/compact` runs as the CLI's command; `session-controls` (signed out; a signed-in `/compact` waits for the operator's approval)                                                                       |
| `questions`      | `true`       | AskUserQuestion as the question card; `question`                                                                                                                                                      |
| `runtimeModes`   | all three    | the PreToolUse hook puts every call in every mode past the ladder; `sensitive-full-access` has an `ask` reaching the card under `bypassPermissions`                                                   |
| `attachments`    | `files`      | images as blocks, anything else by path under a readable directory                                                                                                                                    |
| `textGeneration` | `true`       | `generateText`: one tool-less `query()` with no session; `generate-text` answered, `generate-text-signed-out` refused                                                                                 |
| `ultracode`      | `true`       | `Settings.ultracode` at launch and through `applyFlagSettings`; the live check in [Ultracode](#ultracode), no recording                                                                               |

Every value but `ultracode`, `compaction` and the two left `false` rests on a
recording made signed in. `ultracode` rests on the SDK's declarations, the
CLI's bundle and the live check, which showed the flag taken but not a
workflow run; `compaction`, on the signed-out recording of the command's path.

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
  `mcp_tool_ui_meta_v1`; 2.1.286 adds `sdk_mcp_tools_list_changed` and
  `sdk_mcp_manifests`. 2.1.150's init has no `capabilities` field and it
  sends no receipts (`receiptless-steer`).
- **A probe's handshake is stopped, not ended:** its recorded exit is 143.
- **An interrupted turn is an error result** (`interrupt`):
  `error_during_execution`, `is_error: true`, `terminal_reason:
"aborted_streaming"`, after a user message "[Request interrupted by user]";
  the message's receipt ends `cancelled`.
- **A budget cap ends the turn before a pending call is asked about.** A
  session whose first request cost more than its `maxBudgetUsd` got its
  `error_max_budget_usd` result while the call the request made was still at
  the hook, and the CLI asked `canUseTool` about that call after the result
  (a first conformance recording, under a ten-cent cap, since remade under
  fifty). Production sets no cap.
- **A session's first request writes the prompt cache** and costs ten to
  twenty cents at list price on the default model (Opus 5.5); the next ones in
  the session read it and cost a few cents, or a third of a cent for a
  one-shot with no tools (`generate-text`).
- **A shell command the CLI waits on long enough is a task** too
  (`local_bash`, not backgrounded; `steering`), reported by `task_started` and
  `task_notification` beside its own result.
- **Thinking comes back empty** under the default thinking display (every
  signed-in recording).
- **`claude mcp add-json` never replaces a server:** a name the scope already
  holds exits 1 with "MCP server <name> already exists in user config", and a
  name outside letters, digits, `-` and `_` exits 1 with "Invalid name"
  (`mcp-servers`). It checks little else: an http `url` that is not a URL is
  written as given. Refusals go to stderr, successes to stdout, and `remove`
  adds a "File modified:" line naming the file.
- **A `.claude.json` that does not parse is replaced,** not refused: any
  command, `mcp add-json` included, backs it up under `<config>/backups/`,
  starts a fresh one without the user's servers, and exits 1.
- **`claude mcp list` and `get` health-check** every server they show,
  starting stdio ones and connecting to http ones, and have no JSON output.

## Still waiting

The signed-in recordings (CLI 2.1.286, 2026-10-01) settled what the list here
used to hold: every scenario that was waiting is recorded and replayed in the
gate, conformance with its approval case; the live suites ran once on the
CLI's default model; the capability values rest on the recordings named in
[Capabilities](#capabilities); and the round's fixes and additions each have
their recording — the no-permission tools as far as `subagent` and
`plan-accept` call them, thinking blocks, the order of a foreground subagent's
lifecycle and its result, and a stopped one. The harness command list is the
exception: it was read from the signed-in probe's capture before the recorder
scrubbed it, and no recording keeps it, so `commands.test.ts` holds it. The
resume fallback's wording was read off a run of the CLI by hand. What still
rests on the SDK's declarations, the CLI's bundle or unit tests, and why:

- **A signed-in `/compact`.** It costs a summarisation request, so it is made
  only with the operator's approval; `session-controls` has the command's
  path signed out.
- **The notices** other than `rate_limit_event` at `allowed`: `api_retry`,
  the model-refusal messages with a fallback's `retracted_message_uuids`, the
  `informational` and `notification` shapes, and a rate limit's warning
  statuses. Each needs a CLI that retries, refuses or nears a limit, which a
  scenario cannot ask for.
- **Background agents** (`run_in_background`): whether the headless CLI holds
  its `result` until they finish, or runs a turn of its own that would close
  the wrong Poseidon turn. None of the recorded delegations was backgrounded.
- **`system/local_command_output`**, which 2.1.280 never wrote signed out; the
  local commands were not recorded again signed in.
- **The no-permission tools not yet called**: TodoWrite, the task-list tools
  and EnterPlanMode running without a card, and Skill still asked.
- **`lastAssistantUuid` taking a synthetic local-command snapshot's uuid**,
  which matters only once rollback is offered.
- **Rollback and fork**, which stay `false`: nothing calls
  `resumeSessionAt` or `forkSession`, and no recording is made for them.
- **Ultracode beyond the flag.** The live check ([Ultracode](#ultracode))
  showed the flag taken at launch and mid-session and started no workflow, on
  purpose. Still unrecorded: a Workflow call's approval card in
  approval-required and what its input shows; how the `local_workflow`
  task_started and task_notification messages render (kept unmapped today);
  whether the headless CLI holds its `result` until a workflow finishes; an
  account without workflows taking or refusing the flag; and a switch, while
  ultracode is on, to a model without `xhigh`.

### Owner commands

Run these in your own shell, from the repository root, once `claude auth
status` says `"loggedIn": true`. The recording and live commands spend the
account's subscription on the CLI's default model.

Record the end-to-end scenarios through the server:

```sh
POSEIDON_RECORD_CLAUDE=1 pnpm -F server exec vitest run test/e2e-claude/turn.test.ts test/e2e-claude/interrupt.test.ts test/e2e-claude/resume.test.ts test/e2e-claude/approval.test.ts test/e2e-claude/plan.test.ts test/e2e-claude/question.test.ts test/e2e-claude/subagent.test.ts test/e2e-claude/subagent-stop.test.ts test/e2e-claude/model.test.ts test/e2e-claude/attachment.test.ts test/e2e-claude/steering.test.ts
```

Record the connector's own: the probe (free), `generate-text` (the
signed-out session recorders skip themselves on a signed-in CLI), and the
conformance suite:

```sh
POSEIDON_RECORD_CLAUDE=1 pnpm -F @poseidon/connector-claude exec vitest run test/recordProbe.test.ts
POSEIDON_HOME=/tmp/poseidon-h1 POSEIDON_RECORD_CLAUDE=1 pnpm -F @poseidon/connector-claude exec vitest run test/recordSession.test.ts -t "generate-text: one"
POSEIDON_RECORD_CLAUDE=1 pnpm -F @poseidon/connector-claude exec vitest run src/conformance.test.ts
```

Run the live suites once:

```sh
POSEIDON_HOME=/tmp/poseidon-h1 POSEIDON_LIVE_CLAUDE=1 pnpm -F @poseidon/connector-claude exec vitest run src/liveConformance.test.ts
POSEIDON_HOME=/tmp/poseidon-h1 POSEIDON_LIVE_CLAUDE=1 POSEIDON_CLAUDE_APPROVED_MODEL=<the default's id> pnpm exec vitest run apps/server/test/e2e-claude
```

`POSEIDON_CLAUDE_APPROVED_MODEL` names the explicit id the CLI's default runs
as (`claude-opus-5-5` on the recording account), which `model.test.ts`
switches to; without it that scenario stops live rather than spend on a model
nobody approved. The run of 2026-10-01 passed all nine cases of the live
conformance suite and every end-to-end scenario but the signed-out one, which
failed for the CLI being signed in; it now skips itself live on a signed-in
CLI.

A new recording replaces the old whole; check it against the recording
hygiene rules in [development.md](development.md#making-one) before it is
committed.

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
   POSEIDON_LIVE_CLAUDE=1 pnpm -F @poseidon/connector-claude exec vitest run src/liveConformance.test.ts
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
