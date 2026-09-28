# Command Code connector reference

Poseidon drives one agentic harness: the Command Code CLI, spelled `cmd`. This
document describes how the connector finds that binary, what it spawns, what
comes back, and what it writes into the user's machine while a session is open.

Everything here is read off the code as it stands and off the real recordings
under `packages/testkit/fixtures/cmd/`, which are captures of the actual CLI —
argv, stdout frames with their arrival chunks, stderr, the transcript as it
grew, every PreToolUse invocation with both halves of the exchange. Where a
claim rests on a recording, the recording is named. In the shared recording
format (`packages/testkit/src/recording.ts`) they are the `cmd` kind over the
`stdio-ndjson` transport; their manifests predate the format's version and
transport fields, and read as version 1 without being edited.

Its companions: [architecture.md](architecture.md) for the connector boundary
this fills in, [how-it-works.md](how-it-works.md) for what the rest of the app
does with what comes back, and [development.md](development.md) for the
commands that run and record it.

## Where the code is

The connector is `packages/connector-cmd`. It implements the
`ConnectorDefinition` interface of `packages/connector-sdk` and is the only
connector in the tree.

| module             | what it owns                                                       |
| ------------------ | ------------------------------------------------------------------ |
| `definition.ts`    | the `ConnectorDefinition`: probe, instance, extensions             |
| `binary.ts`        | which executable `cmd` means, and how to spell the call            |
| `probe.ts`         | `status --json`, `--list-models`, version policy, context window   |
| `modelNames.ts`    | a model's readable name, derived from its id                       |
| `spawn.ts`         | argv construction, the env allowlist, the process handle           |
| `turnArgs.ts`      | one turn's prompt and argv, including the plan-mode exception      |
| `generateText.ts`  | one piece of text outside any session: the one-shot print run      |
| `session.ts`       | one session: sends, the pump, teardown                             |
| `ndjson.ts`        | the stdout frame envelope and the line splitter                    |
| `translate.ts`     | frames, transcript lines and exits → `RuntimeEvent`s               |
| `items.ts`         | the tool vocabulary and a session's tool rows                      |
| `messages.ts`      | folding a whole message into rows                                  |
| `deltas.ts`        | `*_delta` frames → `content.delta`                                 |
| `textRows.ts`      | which row a piece of assistant text belongs on                     |
| `transcript.ts`    | locating and tailing the on-disk session transcript                |
| `sessionRef.ts`    | the persisted session reference and whether it is still resumable  |
| `hookScript.ts`    | the generated PreToolUse hook script and its ticket file           |
| `hookAnswers.ts`   | answering hook posts: allow, deny, or park for the user            |
| `approvals.ts`     | tool name → approval kind and "allow always" pattern               |
| `config.ts`        | the two files we write into the user's machine, and their teardown |
| `sessionMcp.ts`    | the MCP entries one session registers: Poseidon's and its plugins' |
| `mcpServers.ts`    | the MCP servers extension: the user and project `mcp.json` files   |
| `skills.ts`        | the skills extension: skill discovery and linking shared skills    |
| `plans.ts`         | reading (and saving) the plan a plan turn produced                 |
| `questions.ts`     | `ask_user_question` input and answers                              |
| `subagents.ts`     | the three subagent frames as progress on one row                   |
| `attachments.ts`   | staging a turn's files and naming them in the prompt               |
| `exitCodes.ts`     | what each exit code means and whether it is fatal                  |
| `capabilities.ts`  | what a Command Code session can do                                 |
| `activeProcess.ts` | the turn a session currently has running                           |

## Finding the binary

`resolveBinary` in `packages/connector-cmd/src/binary.ts` answers in this
order:

1. the configured `binaryPath` from the connector config, when it is set and
   not empty;
2. `cmd` on `PATH`, searching each `PATH` entry and then the global bin
   directories a GUI process never inherits: `/usr/local/bin`,
   `/opt/homebrew/bin`, `~/.bun/bin`, `~/.local/share/pnpm`,
   `~/.npm-global/bin`;
3. `npx -y command-code@latest`, when `npx` itself resolves — so a machine with
   no global install still works. The package spec travels as `prefixArgs` and
   is prepended to every call.

A candidate counts only when it is a regular file with the execute bit set.

`resolveForSession` is the session's variant and never returns null: when
nothing resolves it falls back to `BARE_CMD` — the literal string `cmd` against
whatever `PATH` the server inherited.

Resolution is shared by the probe, the turn spawn and every `cmd mcp` call, and
it is redone per session start so an install that appears later is found. A
packaged macOS app launched from Finder inherits launchd's `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`), which contains neither Homebrew nor any
Node version manager, so resolving once in the probe and spawning the bare name
later is the difference between a green connectors page and ENOENT on the first
message.

## Version policy

The connector runs whatever `cmd` the user has installed, at whatever version
it is, and never prefers a pinned copy of its own. Nothing is pinned anywhere:
the npx fallback asks for `command-code@latest`.

`OLDEST_TESTED_VERSION` in `packages/connector-cmd/src/probe.ts` is `1.54.0`.
It is a warning floor, not a requirement. Strictly below it the probe adds a
warning; equal or above says nothing, today and for every release after. A
version string that does not parse does not warn either — refusing to run on a
build whose version we cannot read would be the pin this connector deliberately
does not have. There is no update checker and no UI for any of this.

The probe runs `status --json` and `--list-models` **without**
`--no-auto-update`: a probe is the one safe moment to let the CLI upgrade
itself. Turn spawns keep `--no-auto-update`, because swapping the binary under
a running conversation is not safe.

## The probe

`probe(config)` returns a `ConnectorProbe`. It runs two child processes against
the resolved binary, both with the same environment allowlist a turn gets, so a
`COMMAND_CODE_API_KEY` supplied through `extraEnv` is not reported as "not
authenticated" while turns work fine.

`installed` is true once `resolveBinary` found something to run, whatever the
probe then saw; nothing resolvable reports `not-installed` with `installed:
false`. A signed-out CLI — exit 3, or `authenticated: false` in the status
JSON — reports a `loginCommand` that runs `login` (`CMD_LOGIN_SUBCOMMAND`), the
subcommand the recorded `cmd --help`
(`packages/testkit/fixtures/cmd/probe/help.stdout.txt`) lists for signing in
and the exit-3 message names. `terminalCommand` in `binary.ts` spells it against
the resolved binary: the configured or found path (`/opt/homebrew/bin/cmd
login`), or `npx -y command-code@latest login` for the npx fallback, which only
runs when no `cmd` was found and so must not be told to run one. No
`installCommand` is reported: nothing resolves only when `npx` is missing too,
and no recording or doc names another way to install.

### `status --json`

Timeout 30s. The recorded output
(`packages/testkit/fixtures/cmd/probe/status.stdout.txt`) is one line:

```json
{
  "authenticated": true,
  "version": "1.55.1",
  "user": "user",
  "provider": "command-code",
  "model": "meta/muse-spark-1.3-contributor",
  "context_window": 1048576
}
```

| field            | used for                                                     |
| ---------------- | ------------------------------------------------------------ |
| `authenticated`  | `false` → probe status `not-authenticated`, `auth: "absent"` |
| `version`        | reported, and compared against `OLDEST_TESTED_VERSION`       |
| `user`           | the `account` shown on the connectors page                   |
| `provider`       | read but not surfaced                                        |
| `model`          | which `--list-models` row the context window is attached to  |
| `context_window` | the denominator for the composer's "context window used"     |

Output that is not JSON is not fatal — a running binary is still worth probing
further.

The context window is cached per resolved binary display name
(`contextWindowFor`). A session started later reads it from there, and while it
is unknown no `context.updated` event is emitted at all, because there is no
denominator to report a percentage against. `run_end` carries the tokens a
conversation occupies; nothing on the wire carries the ceiling.

### `--list-models`

Timeout 60s. The output is a two-column table under section headers; the
recorded captures are `packages/testkit/fixtures/cmd/probe/list-models.stdout.txt`
(70 models on 1.55.1) and
`packages/testkit/fixtures/cmd/probe-list-models-1.66.0.stdout.txt` (82 models
plus one decision model on 1.66.0). `--list-models --json` prints the same
table; there is no machine-readable listing. `parseModelList` reads it:

- A model row is `<id><two or more spaces><tagline>`. A line without that
  column gap is a section header and becomes the `family` for the rows under
  it — seven of them in the 1.55.1 recording: `Open Source`, `Anthropic`,
  `OpenAI`, `Google`, `Sakana`, `Meta`, `xAI`; 1.66.0 adds `Stealth` and
  `Decision models (headless only)`.
- The table has no name column. The second column is a tagline ("Muse Spark
  1.2 at ~95% off"), so it becomes the model's `description`, shown only as
  secondary text, and never its name. The CLI's bundle does know a name, but
  never prints it, and a minified, self-updating bundle is not something to
  parse.
- The `label` is derived from the id by `modelNameFromId`
  (`packages/connector-cmd/src/modelNames.ts`), which matches the CLI's own
  names on most rows (`google/gemini-3.5-flash` → "Gemini 3.5 Flash"):
  1. drop everything up to the last `/` (the provider is the family);
  2. strip a `:tag` suffix and a trailing `-free` segment; a free one
     (`:free` or `-free`) appends " (Free)", any other tag appends it in
     parentheses, so `meituan/longcat-2.0` and `meituan/longcat-2.0:free`
     never share a name;
  3. split on `-` and join adjacent short numbers by position
     (`claude-opus-5-5` → "Claude Opus 5.5");
  4. capitalise each word; a single letter glued to a version is upper-cased
     (`v4` → "V4", `k2.5` → "K2.5", `a55b` → "A55B"), as is a parameter count
     (`27b` → "27B"); a word glued to its version is split (`qwen3.8` → "Qwen
     3.8"); a small table cases the brand words (GPT, GLM, DeepSeek, MiniMax,
     MiMo, LongCat), and GPT and GLM keep a hyphen before their version
     ("GPT-5.4 Mini");
  5. fall back to the raw id if nothing is left.

  What still differs from the CLI's names is cosmetic ("Flashx" for "FlashX",
  no "(latest)" suffix), and the fixture tests pin that every name is unique
  and none is a tagline.

- Splitting on the column gap rather than on a `/` is what keeps the bare ids
  out of the header bucket. Anthropic's and OpenAI's rows are bare model names
  (`claude-opus-5`, `gpt-6-astra`); every other family's are `provider/model`.
- A lone token with a `/` in it is an id with no description, not a family.
- Ids may carry a `:tag` suffix. A model is free when its id ends in `:free`
  (`meituan/longcat-2.0:free`, `inclusionai/ling-3.0-flash-sante:free`) or its
  description contains `FREE` — which is how `poolside/laguna-s-2.1-free`, whose
  suffix is part of the name rather than a tag, is also marked free.
- `(default)`, `(recommended)`, `FREE` and effort markers are stripped from
  the description. Free and vision detection read the raw tagline. A row with
  no tagline has no `description` at all, since the contract rejects an empty
  one.
- Rows under a header containing `headless only` (1.66.0's `typesafe/jev`,
  which answers typed questions with probabilities and cannot run an agent
  turn) are `hidden`: the pickers leave them out unless the user switches one
  on in Settings → Models.
- Table chrome is skipped: lines starting with `Available models`, `Pass the
full id`, `cmd `, or `Docs:`.
- An effort ladder is honoured where a row carries one (`[low,medium]`), but no
  row in the recorded output has one. A row without a marker offers every rung
  the contract knows — `low, medium, high, xhigh, max` — rather than a
  narrower ladder nobody measured. Every recorded `model_request_end` on the
  account default reports `"effort":"xhigh"`, so assuming `low/medium/high`
  would hide two rungs the CLI uses by default.

The context window from `status --json` is attached to that one named model,
not to every row.

A `--list-models` that fails is a warning on an otherwise usable probe, not a
failure: the model list comes back empty.

### Exit codes

`EXIT_MESSAGES` in `packages/connector-cmd/src/exitCodes.ts` is the table. It
is consulted by the probe and again by the translator when a turn's process
exits.

| code  | meaning                              | fatal | what the user is told                                                       |
| ----- | ------------------------------------ | ----- | --------------------------------------------------------------------------- |
| `0`   | success                              | —     | nothing                                                                     |
| `1`   | generic error                        | yes   | `cmd failed — see the output above`                                         |
| `3`   | not authenticated                    | yes   | `command code is not authenticated — run \`cmd login\``                     |
| `4`   | permission denied by the CLI's rules | yes   | `command code refused the tool call: permission denied by its own rules`    |
| `5`   | rate limited                         | no    | `rate limited by command code — wait a moment and send again`               |
| `6`   | network                              | no    | `could not reach command code — check the network and send again`           |
| `7`   | API 5xx                              | no    | `command code's API returned a server error — send again`                   |
| `8`   | `--max-turns` exhausted              | no    | `stopped at the turn limit (--max-turns)`                                   |
| `9`   | no response produced                 | yes   | `command code produced no response`                                         |
| `10`  | insufficient credits                 | yes   | `insufficient credits — top up at https://commandcode.ai/billing and retry` |
| `130` | interrupted (SIGINT/SIGTERM)         | —     | nothing; the turn settles `interrupted`                                     |

`fatal: false` is the difference between "the turn failed, try again" and "this
session is over". The three transport failures leave the session alive so the
supervisor can back off and retry; `0` and `130` are not failures at all and
are deliberately absent from the table.

The probe short-circuits on two of them:

- Exit `3` returns `not-authenticated` with `auth: "absent"` and skips the
  model list — no turn can run until the user logs in.
- Exit `10` returns `error` with `auth: "present"` and `helpUrl` set to
  `CMD_ACCOUNT_HELP_URL` (`https://commandcode.ai/billing`, the page the CLI's
  own exit-10 message names, defined in `packages/connector-cmd/src/probe.ts`).
  The credentials are good; what fixes this is a billing page, and the
  connector is the only layer that knows its address.

Any other non-zero code with no `authenticated` field in the output reads as
the table's sentence with the CLI's own stderr detail in brackets.

The one recording of the exit-10 path is
`packages/testkit/fixtures/cmd/probe-insufficient-credits.ndjson`, captured on
2026-09-15 while the account had no credits. It is also the only capture of a
`run_error` frame, and it cannot be made again now the plan is paid for.

Exit codes `4`, `5`, `6`, `7` and `9` come from the CLI's documented set; the
recordings cover `0`, `1`, `8`, `10` and `130`.

## Spawning a turn

Print mode is one turn per process. There is no stdin control protocol and no
way to inject a message mid-turn, so steering is a queued next turn and
interrupt is a signal.

### argv

`buildArgs` in `packages/connector-cmd/src/spawn.ts` builds a stable order so
tests can assert it:

```
cmd -p "<prompt>" --output-format json --verbose -t --skip-onboarding --no-auto-update
    [--no-session | --session <sessionId>]
    [--model <id>] [--effort <level>]
    [--permission-mode <standard|plan|auto-accept>] [--yolo]
    [--max-turns <n>]
    [--add-dir <dir>]...
    [--tools-enable <name>]...
    [--skill <dir>]...
```

The npx fallback's `prefixArgs` (`-y command-code@latest`) go in front of all
of it.

The six leading flags are on every turn:

| flag                   | why                                                              |
| ---------------------- | ---------------------------------------------------------------- |
| `-p <prompt>`          | print mode: run this one turn and exit                           |
| `--output-format json` | the NDJSON event stream plus a final result line                 |
| `--verbose`            | tool progress on stderr, and `session: <uuid>` as its first line |
| `-t`                   | auto-trust the project — a headless run cannot answer a prompt   |
| `--skip-onboarding`    | skip taste onboarding, which is interactive                      |
| `--no-auto-update`     | do not swap the binary under a running conversation              |

`prepareTurn` in `packages/connector-cmd/src/turnArgs.ts` decides the rest for
a real turn:

- **model and effort** come from the thread's settings, per turn. The
  capabilities say `modelSwitch: "per-turn"` and `effortSwitch: "per-turn"`,
  and that is literally what the flags are — the next process carries the new
  value; nothing changes mid-turn.
- **`--session <id>`** when there is a resumable session to continue.
- **`--yolo` on every ordinary turn**, and on no plan turn. See
  [Plan mode](#plan-mode).
- **`--permission-mode plan`** when the thread's interaction mode is `plan`.
- **`--add-dir <attachmentsDir>/<threadId>`** when the turn has attachments.
- **`--tools-enable ask_user_question`**, always. `TOOLS_ENABLED` lists that
  one tool and nothing else; `--tools-all` would also un-withhold whatever else
  a headless run hides, sight unseen.
- **`--skill <dir>`** once per skills directory of the session's enabled
  Poseidon plugins (`SessionPlugin.skillsDirs`, each a directory of
  `<name>/SKILL.md` folders), read once at session start. `cmd --help`: "Load
  extra skills from a path (a skill directory or a directory of skills);
  repeatable". With no plugin enabled, or none carrying skills, the argv is
  what it was before plugins existed, which is why every recording still
  rebuilds. Command Code has no plugin loader, so a plugin's commands, agents
  and hooks are not loaded ([plugins.md](plugins.md#what-each-harness-gets)).

`--max-turns` and `--no-session` are passed by no turn, so a turn runs at the
CLI's own default cap — `cmd --help` says "Cap conversation turns in -p mode
(default 100; exit 8 on cap-hit)". The recordings set `--max-turns` because
the recorder does. The one caller that passes both is `generateText`
([Writing one piece of text](#writing-one-piece-of-text)).

`packages/connector-cmd/src/recordedArgs.test.ts` holds this to account: it
reads every recording's `connectorArgs` back into a `buildArgs` input, rebuilds
it, and demands the same list.

### Writing one piece of text

`generateText` (`generateText.ts`) writes a commit message, a pull request's
text or a thread title outside any session. It is one print-mode process with
`buildArgs`'s one-shot flags:

```
cmd -p "<system>\n\n<prompt>" --output-format json --verbose -t --skip-onboarding --no-auto-update
    --no-session --model <id> [--effort <level>] --max-turns 1
```

- **No `--yolo`**, and no `--tools-enable`, hook, MCP config or skills. Without
  `--yolo` print mode refuses every write and shell call itself
  (`fixtures/cmd/shell-allow/`), so the call is read-only whatever the model
  tries.
- **A directory of its own**: a fresh `poseidon-generate-*` under the system
  temp directory is the working directory, removed after the call once the
  process group is gone. The environment is the same `envAllowlist` a turn
  uses, with the instance's `extraEnv` and no `POSEIDON_*` control plane.
- **The system text goes in front of the prompt**, because print mode has no
  system-prompt flag. It has no schema flag either, so `jsonSchema` is not sent
  and the caller parses the text.
- **The prompt fits one argv string.** Linux caps a single argument at
  128 KiB and Windows the whole command line at 32,767 characters, while the
  caller's caps count characters. `fitArgument` cuts the prompt's end, where
  the diff is, to 120 KiB of UTF-8 (30,000 characters on Windows) with a line
  saying so, so a diff of CJK text or emoji is shortened instead of failing
  the spawn with `E2BIG`.
- **Effort only when asked for, and dropped when refused.** The model listing
  marks no effort ladder, so every model offers every level and the caller
  cannot tell which take one. A model that takes none refuses the flag before
  any request — "Laguna S 2.1 has no adjustable reasoning effort." on stderr,
  exit 1 (`fixtures/cmd/generate-text-effort/`). On that refusal the call runs
  once more without `--effort`, and the instance remembers the model so later
  calls leave the flag out from the start
  (`fixtures/cmd/generate-text-effort-retry/`). `minimal` goes as `low`
  (`cmdEffort`).
- **The answer is `finalText` on the `result` line.** A non-zero exit (read
  through `EXIT_MESSAGES`), a stream with no `result` line, a `result` that is
  not `success`, or one with no text fails with `GenerationFailed`, carrying the
  CLI's own error or the tail of its stderr. A process that will not start is
  `SpawnFailed`.
- **What `--no-session` still leaves is removed.** It writes no transcript, but
  the real run left `<id>.checkpoints.jsonl` and `<id>.meta.json` in a project
  directory named after the temp directory (`projectDirListing` in
  `fixtures/cmd/generate-text/manifest.json`). One per generated title would
  pile up in `~/.commandcode/projects`, so the files named after the run's
  session id are removed, and their directory once it is empty.

`fixtures/cmd/generate-text/` is a real run of exactly this argv on
`poolside/laguna-s-2.1-free`, and `generateText.test.ts` replays it through the
definition: the text, the argv, the temp directory and the tidy-up. The retry
without `--effort` replays `generate-text-effort-retry/`, and the error path
`generate-text-effort/` and `max-turns/`. The server wraps every
call in its own timeout; interrupting the call closes its scope, which kills
the process group.

### The prompt

One string, assembled by `prepareTurn`: the user's text, then one `@path` line
per mention, then one line per skill reference, then one line per plugin
reference to one of the session's plugins, then one line per attachment,
joined by blank lines. Empty parts are dropped. A mention is a
workspace-relative path and nothing else (`Mention` in
`packages/contracts/src/orchestration.ts`) — the connector writes it as `@path`
text and the harness resolves the path itself. The user's text still carries
the composer's `#path` token; the `@path` line is what the harness reads.

A skill reference (`TurnReference` in `packages/contracts/src/runtime.ts`, kind
`skill`) becomes one sentence, `Use the "<name>" skill.`, with the name
JSON-quoted; a skill referenced twice is named once. The user's text still
carries the composer's `$name` token, which means nothing to the harness; the
sentence is what the model acts on. `fixtures/cmd/skill/` was recorded with
exactly the prompt `prepareTurn` builds for `Greet me with $greeting.` and one
reference to a project skill `greeting`: the model's first act was
`activate_skill {name: "greeting"}` (a `skill` row), and it then answered as the
skill's body told it to. `turnArgs.test.ts` fails if `prepareTurn` stops
building that prompt, and `recordedSession.test.ts` replays the recording
through a session sent that reference.

Command Code has no plugins of its own. The only plugins a session has are
Poseidon's enabled ones, whose skills its argv loads (`--skill`, above); a
reference to one of those becomes `Use the "<name>" plugin.`, named once. Any
other plugin reference is left out of the prompt and reported as a
`session.warning` naming it. A turn with no references builds the same prompt
it did before references existed.

### Environment

`envAllowlist` builds the child's environment from three sources, applied in
this order so Poseidon's own keys always win:

1. **Inherited variables that pass the allowlist.** Exact names: `HOME`,
   `PATH`, `USER`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, `SSH_AUTH_SOCK`,
   `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`,
   `NODE_EXTRA_CA_CERTS`. Plus `COMMAND_CODE_API_KEY`, and any name beginning
   `LC_` or `POSEIDON_`.
2. **The operator's `extraEnv`** from the connector config, filtered by the
   deny half only. Naming a variable on the connectors page _is_ the decision,
   so running it through the inherited-env allowlist as well would silently
   drop `CMD_LOCAL_ONLY=1` (the env form of `--local-only`, which an operator
   sets precisely to keep their traffic off Command Code), `NODE_OPTIONS`,
   `GH_TOKEN`, `TZ` and every corporate variable besides.
3. **The session's own control plane**, applied last and never filtered:
   `POSEIDON_HOOK_URL`, `POSEIDON_HOOK_TICKET_FILE`, `POSEIDON_THREAD_ID`, and
   `POSEIDON_MCP_TOKEN` when the server has an MCP endpoint.

Two guards run over that:

- **Dropped by prefix, on every route:** `POSEIDON_SERVER_`, `ANTHROPIC_`,
  `OPENAI_`. Our own server internals and other vendors' credentials never
  reach the harness.
- **Reserved:** `POSEIDON_HOOK_*`, `POSEIDON_MCP_*` and `POSEIDON_THREAD_ID` are
  dropped from `extraEnv`. `extraEnv` is written through the settings RPC from
  the connectors page, and pointing `POSEIDON_HOOK_TICKET_FILE` at a path that
  does not exist would make the hook script read no bearer, take its "no
  Poseidon session owns this run" path, and exit silently — which under `--yolo`
  is every tool call running unapproved while the header still says
  `approval-required`.

The child's `HOME` decides where it resolves `~/.commandcode`, so when
`extraEnv.HOME` is set the session passes the same directory to the transcript
and plan readers.

### The process

`spawnProcess` spawns with `stdio: ["ignore", "pipe", "pipe"]` and
`detached: true` off Windows, so the child leads its own process group.

ENOENT and its relatives arrive on the `error` event rather than from `spawn()`,
so the handle waits for an explicit `spawn` acknowledgement before calling it a
process.

Shutting a turn down is a ladder, and it signals the **group** (`kill(-pid)`),
falling back to the direct pid when the child was not a group leader:

```
SIGINT to the group
  └─ wait up to 5s for exit
       ├─ exited      → sweep
       └─ still alive → SIGKILL to the group → wait → sweep
sweep: pgrep -g <pid>, SIGKILL each survivor (5s timeout; absent pgrep is a no-op)
```

A bare SIGINT leaves a child that ignores it — or a `shell_command` grandchild
holding the stdout pipe — running forever, and with it a turn that never
settles and a thread that can never send again. The sweep is asynchronous: an
`execFileSync` here would block the whole Node event loop, and this runs on
every interrupt and every session close.

Exit resolves before the pipes finish draining, so the pump waits up to two
seconds for the stdout reader to run out its buffered chunks and flush the
unterminated tail. A grandchild that inherited the pipe holds it open forever;
the timeout keeps that from wedging the pump.

### The stdout line cap

`makeLineSplitter` holds at most `MAX_LINE_CHARS` = 33,554,432 characters of
unterminated line. Most frames are a couple of kilobytes, but `run_end` is not: it carries
`result.nextState.messages`, the whole conversation with its content blocks,
and `packages/testkit/fixtures/cmd/image/` shows those include a base64 image
block. Every later turn of a session replays that history, so once a screenshot
is in a thread each `run_end` grows by the transcoded bytes.

Past the cap the line is dropped, everything up to the next newline with it,
and the session emits a `session.warning` naming the first 200 characters —
because `event.unmapped` is where ingestion sends frames it does not recognize
and nothing downstream shows one, so a silently lost `run_end` said nothing at
all.

## The NDJSON frame catalogue

Every stdout line is one JSON object: `{"type":"event","event":{…}}`, except
the final `{"type":"result",…}` line. `parseFrame` classifies a line that is
JSON but not one of those two envelopes as an error rather than dropping it,
because dropping it would hide a protocol change.

These are the frame types actually observed, counted across every recording in
`packages/testkit/fixtures/cmd/`:

| frame                 | count | what it carries                                                  |
| --------------------- | ----- | ---------------------------------------------------------------- |
| `message_update`      | 77    | the whole message so far, re-sent after every delta              |
| `turn_start`          | 53    | one agent step opening                                           |
| `message_start`       | 53    | a message opening                                                |
| `model_request_start` | 53    | `model` for the request about to go out                          |
| `model_trace`         | 53    | the harness's own tracing                                        |
| `text_delta`          | 50    | `delta.text` — streamed assistant text                           |
| `model_request_end`   | 49    | `model`, `usage`, `stopReason`, **`effort`**                     |
| `message_end`         | 49    | the finished content blocks                                      |
| `turn_end`            | 49    | `turnNumber`, `hadToolCalls`, `usage` for that step              |
| `run_start`           | 28    | `sessionId` — the run opening                                    |
| `tool_queued`         | 27    | `toolCallId`, `toolName`, **`input`**                            |
| `run_end`             | 25    | `result`: `nextState`, `usage`, `stopReason`, `turnCount`        |
| `tool_running`        | 21    | `toolCallId`, `toolName`, `description` — which is always `null` |
| `tool_completed`      | 21    | `result` (text and image blocks), `deferred`                     |
| `thinking_delta`      | 17    | `delta.thinking` — streamed reasoning                            |
| `thinking_start`      | 12    | reasoning opening                                                |
| `thinking_end`        | 11    | the finished reasoning `text`                                    |
| `tool_hook_blocked`   | 6     | `hookOutput` — the refusal the model is shown                    |
| `tool_update`         | 4     | `partial` — a long-running tool's output so far                  |
| `tool_hooks`          | 4     | the hook's verdict: `phase`, `outcome: {kind, text}`             |
| `subagent_start`      | 1     | `toolCallId`, `subagentType`, a title                            |
| `subagent_progress`   | 1     | one per inner tool call: `toolName`, `toolInput`                 |
| `subagent_stop`       | 1     | `tokensUsed` for the whole delegation                            |
| `notice`              | 1     | an informational notice                                          |
| `run_error`           | 1     | `error: {name, message}` — only in the credits capture           |

And the final line, `{"type":"result", …}`: 22 `success`, 2 `max_turns`, 2
`error` across the same set.

### What a turn is

`turn_start`/`turn_end` count **agent steps** — one model round trip each,
three of them inside one `shell-allow` turn. One _user_ turn is one process:
`run_start` to `run_end`. Mapping `turn_start` to `turn.started` produced three
`turn.started` events for one turn and one `turn.completed`.

```
process spawn
  run_start                 → session.started (once) + turn.started
    turn_start              ── agent step 1
      model_request_start   → model.changed (when the model moved)
      message_start
      thinking_start
      thinking_delta …      → item.started + content.delta (reasoning)
      thinking_end          → item.completed (reasoning)
      text_delta …          → item.started + content.delta (text)
      tool_queued           → item.started (the row, with its input)
      message_end           → settles the message's blocks
      model_request_end     → model.changed (model and/or effort)
    turn_end                → usage.updated
    ... more agent steps ...
  run_end                   → context.updated, nextState replay,
                              usage.updated, turn.completed
  result                    → runtime.error (on subtype "error")
process exit                → settle open rows, runtime.error, turn.completed
```

### Frame → `RuntimeEvent`

`makeTranslator` in `packages/connector-cmd/src/translate.ts` owns this map.
One translator lives for the whole session, not per process, so dedupe keys
survive the one-process-per-turn boundary.

| frame                                     | events                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `run_start`                               | `session.started` (first announce, or a new id) + `turn.started`             |
| `turn_start`                              | none; bumps the delta-run counter so two steps cannot share a key            |
| `turn_end`                                | `usage.updated` (the run's cumulative tokens, plus any cost so far)          |
| `message_start`, `message_update`         | none — the deltas already stream it and `message_end` closes it              |
| `model_trace`, `thinking_start`, `notice` | none; recognized and deliberately silent                                     |
| `model_request_start`                     | `model.changed`, only when the model actually moved                          |
| `model_request_end`                       | `model.changed` with `effort`, only when model or effort moved               |
| `message_end`                             | `item.started` / `item.updated` / `item.completed` for its content blocks    |
| `thinking_end`                            | `item.completed` on the reasoning row the deltas opened                      |
| `tool_queued`                             | `item.started` — the row, carrying the call's input                          |
| `tool_running`                            | `item.updated` — the description, when there is one                          |
| `tool_update`                             | `item.updated` — the partial output                                          |
| `tool_completed`                          | `item.completed`                                                             |
| `tool_hooks` with `outcome.kind: "block"` | `item.completed` failed, carrying `outcome.text`                             |
| `tool_hook_blocked`                       | `item.completed` failed, carrying `hookOutput`                               |
| `subagent_start`/`_progress`/`_stop`      | `item.updated` — progress on the `agent` row that spawned it                 |
| `run_error`                               | none; the message is _held_ for the `result` line or the exit                |
| `run_end`                                 | `context.updated`, the `nextState` replay, `usage.updated`, `turn.completed` |
| any `*_delta`                             | `item.started` on first sight + `content.delta`                              |
| anything else                             | `event.unmapped` with the raw frame attached                                 |
| `result` with `subtype: "error"`          | `runtime.error` (fatal) + `turn.completed` (`error`)                         |
| `result` with `subtype: "max_turns"`      | `turn.completed` (`max_turns`)                                               |
| `result` otherwise                        | `turn.completed` (`end_turn`)                                                |

`recordedFrames.test.ts` replays every recording through the translator and
fails if a single `event.unmapped` comes out, so a new frame type in a later
CLI release fails the build rather than arriving as an unreadable blob in the
timeline.

### Three things worth stating plainly

- **The input lives on `tool_queued`.** `tool_running` carries no input and its
  `description` is `null` in every recording, so a row built from it shows an
  empty command. `makeToolRows` remembers the input the queue frame carried and
  never lets a later empty object replace it.
- **`run_end.result.nextState.messages` is authoritative.** It is replayed
  through the same message fold the transcript uses; dedupe on `meta.messageId`
  makes it a no-op when the streaming sources already showed everything. On a
  resumed session the replay can carry the whole history, so everything up to
  and including the persisted resume marker is skipped.
- **Cost appears in exactly one place.** `run_end.result.usage` has no cost
  field. The only dollar figure the harness produces is the transcript's
  per-assistant `usage.costUsd`, which is why `usage.updated` restates the
  running cost on every emission — the projection replaces the usage object
  rather than merging into it, so an update that left the cost out erased it
  from the screen mid-turn.

### Errors, said once

Three paths describe the same death: the `run_error` frame, the final `result`
frame with `subtype: "error"`, and the exit code. Every fatal `runtime.error`
plants an error row on the timeline, so an out-of-credits turn used to show
three red rows and move the thread to `error` three times.

So `run_error` only _holds_ its message; the `result` line supersedes it,
because that is the one carrying wording the user can act on (the billing URL);
and the exit code is the backstop for a run that never got that far. A clean
exit clears whatever was held — there is nothing to say about a request that
was retried and worked.

### What a dead process leaves open

`onExit` settles it. A text row keeps whatever it streamed and completes; a row
that streamed nothing fails; every tool call still `in_progress` fails with a
reason — `the turn was interrupted before this call finished` on exit 130,
`the harness exited before this call finished` otherwise. Without this, an
interrupted run (`fixtures/cmd/interrupt/`: exit 130 after `thinking_delta` and
then nothing — no `message_end`, no `result`, no `run_end`) left a spinner
under a thread that read idle, and, because the status is what goes into the
event log, still spinning after a reload.

## The transcript

`~/.commandcode/projects/<slug>/<sessionId>.jsonl`.

**The slug is not one we can compute.** All 22 scenario manifests carry
`transcriptDirMatchesConnectorSlug: false`. The harness splits some camel humps
into dashes, collapses repeated dashes (`501--volumes` → `501-volumes`), and
splits a dotted segment too:
`.../mcpslug.suYi/wsCamelCase` is filed under `…-mcpslug-su-yi-ws-camel-case`
(`packages/connector-cmd/src/config.ts`). Rather than reimplement a private
rule, `findTranscriptPath` looks the session up by the
one identifier the harness hands us: `run_start.sessionId` is unique, so the
file is the `<sessionId>.jsonl` under whichever project directory holds it. The
`slugFor` guess is kept only as the first probe, because it is right often
enough to skip the scan.

The harness slugs its _resolved_ cwd, so a workspace reached through a symlink
(macOS `/tmp` → `/private/tmp`) writes under the physical path. The session
resolves `workspaceRoot` through `realpathSync` before deriving anything.

**Timing.** The file does not exist at `run_start`. It appears seconds into the
turn, already holding the run's first lines, and thereafter grows **once per
completed message**, at each agent-step boundary, with the last flush landing
_with_ `run_end`. A single-round-trip turn writes it exactly once, at the end
(`fixtures/cmd/text/`: one growth sample at 3851 ms of a 3851 ms run); a
three-step turn writes it three times (`fixtures/cmd/shell-allow/`).

So the transcript is one whole model round trip behind the frames and cannot
drive a live UI. The frames are the live source. The transcript is history:
what survives a restart, what carries `costUsd`, and what a resumed session
reads to pick up where a dead one stopped.

`tailTranscript` therefore polls (50 ms) rather than using `fs.watch`, which the
platforms disagree about for a path that does not exist yet, and takes a
_locator_ rather than a path. Positioning is decided once, when the file first
resolves:

- a file that was already there when the tailer started holds a previous run's
  history — skip to its end, or to just after the resume marker when one is
  given and found;
- a file born while we were watching is this run's own and is read from byte
  zero, even though it was born with content. Skipping to end here dropped the
  opening lines of every session.

Partial writes are held until their newline lands, and the unterminated tail is
flushed when the tailer stops, so a final entry that never got its newline is
not silently dropped. A file that shrinks was truncated or replaced and the
offset resets to zero.

Two lines matter to the translator: `type: "session"` (carries the session id)
and `type: "message"` (the message, its `model`, and `usage.costUsd`). Anything
else becomes `event.unmapped`. Priced lines are remembered by id so a re-read
line cannot charge twice.

A turn drains the whole transcript before it settles: the harness's last flush
lands with or after `run_end` and the tailer is a poller, so the assistant line
carrying `usage.costUsd` reliably arrived after `turn.completed` — after the
engine stops tagging events with that turn — and the turn's price was never
reported. Re-reading what the tailer already delivered costs nothing. The
drain waits for the process to exit first, bounded at a second: that final flush
lands a few milliseconds after `run_end` and before the exit, so a drain run the
moment `run_end` is read can beat it and still miss the price.

## The tool vocabulary

Tool name → `ItemKind`, in `packages/connector-cmd/src/items.ts`:

| tool                    | item kind              |
| ----------------------- | ---------------------- |
| `shell_command`         | `command_execution`    |
| `edit_file`             | `file_change` (edit)   |
| `write_file`            | `file_change` (create) |
| `read_file`             | `tool_call`            |
| `read_directory`        | `tool_call`            |
| `glob`                  | `tool_call`            |
| `grep`                  | `tool_call`            |
| `todo_write`            | `todo`                 |
| `agent`                 | `task`                 |
| `activate_skill`        | `skill`                |
| `web_search`            | `web_search`           |
| `web_fetch`             | `web_search`           |
| `mcp__<server>__<tool>` | `mcp_tool_call`        |
| anything else           | `tool_call`            |

And tool name → approval kind, in `packages/connector-cmd/src/approvals.ts`:
`shell_command` → `command`; `edit_file`/`write_file` → `file_write`; anything
starting `read_` plus `glob` and `grep` → `file_read`; `mcp__*` → `mcp_tool`;
`web_search`/`web_fetch` → `web`; everything else → `other`.

The "allow always" button on an approval card starts from an editable pattern
in Poseidon's own vocabulary (see
[architecture.md](architecture.md#permissions)); `approvals.ts` maps Command
Code's tools onto it:

| call                               | suggestion             |
| ---------------------------------- | ---------------------- |
| `shell_command {command: "git …"}` | `Shell(git *)`         |
| `shell_command` with no command    | `Shell(*)`             |
| `edit_file {file_path}`            | `Edit(<path>)`         |
| `write_file {file_path}`           | `Edit(<path>)`         |
| `read_file` / `read_directory`     | `Read(<path>)`         |
| `web_fetch {url}`                  | `Fetch(<url>)`         |
| `web_search {query}`               | `Fetch(<query>)`       |
| `mcp__<server>__<tool>`            | `Mcp(<server>.<tool>)` |
| anything else                      | the bare tool name     |

An MCP call's request also carries `mcpTool: {server, tool}`, parsed from the
`mcp__<server>__<tool>` name (the server is the first segment; the tool keeps
any further `__`), which is what an `Mcp(…)` rule matches. Rules users saved
in the CLI's own spellings — `Write(…)`, `WebFetch(…)`, `WebSearch(…)`, a
literal `mcp__server__tool` — still match, as aliases.

A path is read from whichever of `file_path`, `path`, `filePath` or `file` the
call carries.

**One call, up to five sightings.** `tool_queued` with its input,
`tool_running` with neither input nor description, maybe `tool_update`, then
`tool_completed` or a refusal, and finally the transcript's own
`tool_use`/`tool_result` pair one round trip later. `toolCallId` is the key
that lands them all on one row, and it is the same id in the frames and in the
transcript. A finished row is never regressed to `in_progress` by a late
duplicate.

**A blocked call still gets an ordinary `tool_result`** in the transcript, with
no `is_error`, because the refusal is what the model is told. The frames are
the authority on whether a call ran, so a row already marked failed is not
talked back into "completed".

Tool output is truncated at `MAX_TOOL_OUTPUT_CHARS` = 65,536 characters with a
`...[truncated]` marker, so a build log or a minified file cannot inflate the
event log and the stream budget.

## The PreToolUse hook

This is the approval channel. Print mode has no interactive one.

### The script

`~/.poseidon/bin/cmd-hook.mjs`, generated by
`packages/connector-cmd/src/hookScript.ts`: dependency-free Node, mode 0700,
written through a temp file and rename so a running `cmd` never reads a
half-written script, and rewritten only when its content hash differs.

It reads the hook payload on stdin, POSTs it to the server's `HookBridge` at
`POST /hooks/pretooluse` with a per-session bearer, and prints the bridge's
`hookSpecificOutput` back so the harness applies the decision. Every failure
path — bridge down, non-2xx, timeout, garbage response — prints a **deny**: a
hook that cannot reach the bridge must never accidentally let a mutation
through.

### The ticket file

**The bearer arrives in a file, not in the environment.** Command Code redacts
secret-shaped variable names out of the environment it hands a hook. A live run
with a logging wrapper showed `POSEIDON_HOOK_URL` and `POSEIDON_THREAD_ID`
arriving — along with probes named `..._KEY`, `..._PASS` and `..._TICKET` —
while `POSEIDON_HOOK_TOKEN`, `..._BEARER`, `..._SECRET`, `..._AUTH`,
`..._PASSWORD` and `..._CREDENTIAL` were all stripped. The script therefore saw
a URL and no bearer, took its "no Poseidon session owns this run" exit — print
nothing, exit 0 — the harness fell back to its own flow, and under `--yolo`
that means every tool call ran unapproved, silently. The safety gate's failure
mode is to open.

Renaming the variable to something the denylist has not learned yet would make
the approval path depend on a heuristic we cannot see. So the environment
carries a _path_, `POSEIDON_HOOK_TICKET_FILE`, pointing at
`~/.poseidon/bin/tickets/<threadId>.ticket` — mode 0600, written when the
session opens a turn and deleted when the session closes. `POSEIDON_HOOK_TOKEN`
is still read first when it survives, so a harness that does not redact needs no
file.

### The silent exit

The hook block installed into a project's `.commandcode/settings.local.json`
outlives the session that wrote it, so a user's own interactive `cmd` in that
project invokes the script with neither `POSEIDON_HOOK_URL` nor a bearer. That
run belongs to the user, not to us: the script exits 0 with **no output**,
which hands the call back to the harness's own prompt flow rather than denying
every tool call in that project forever. Our spawned sessions always carry the
environment, so deny-on-unreachable still applies to them.

### The payload

What the CLI puts on the hook's stdin, as recorded in every scenario's
`hooks.json`:

```json
{
  "session_id": "2fb84057-affc-43d4-a3f5-c09b63f0661a",
  "transcript_path": "<HOME>/.commandcode/projects/<slug>/<sessionId>.jsonl",
  "cwd": "<SCRATCH>/repo",
  "hook_event_name": "PreToolUse",
  "permission_mode": "bypass",
  "tool_use_id": "call_01a0b19d022870c28310188426e69d72",
  "tool_name": "shell_command",
  "tool_display_name": "SHELL",
  "tool_input": { "command": "cat note.txt", "description": "Display contents of note.txt" }
}
```

`permission_mode` is neither the argv spelling nor the CLI's documented set: it
is `default` on an ordinary run (`fixtures/cmd/shell-allow/`,
`fixtures/cmd/shell-deny/`) and `bypass` under `--yolo` (every other recording
that has a `hooks.json`).

The hook's own environment carries `COMMANDCODE_PROJECT_DIR`,
`COMMANDCODE_SESSION_ID`, `COMMANDCODE_HOOK_EVENT` and `COMMANDCODE_CWD` —
those four are what the recorder captures. A separate live observation, not
reproducible from anything in the tree, also saw `COMMANDCODE_SCRATCHPAD` and
`COMMANDCODE_PERMISSION_MODE`.

The connector reads `tool_name`, `tool_input` and `tool_use_id` and ignores the
rest; `tool_use_id` is not a UUIDv7, so the wire ids are minted fresh.

### The answers

`makeHookAnswerer` in `packages/connector-cmd/src/hookAnswers.ts` runs the
permission engine and answers one of three ways:

| engine decision | reply                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `allow`         | `{permissionDecision: "allow"}`                                                                 |
| `deny`          | `{permissionDecision: "deny", permissionDecisionReason: "denied by Poseidon permission rules"}` |
| `prompt`        | opens `request.opened`, parks, then answers `allow`/`deny` with `decided <x> via Poseidon`      |

`ask_user_question` takes a fourth road — see below.

Anything that throws answers deny. A dead process leaves every parked post
hanging, so `releasePending` answers each of them — `deny` for approvals, empty
answers for questions — rather than letting the hook sit to its ceiling.

### Timeouts

Three nested limits, and they are ordered on purpose:

```
600s  the harness's own hook cap
 590s  HOOK_TIMEOUT_SECONDS — the timeout we write into the hook block,
       and the HookBridge route's own ceiling before it denies
  570s  TIMEOUT_MS — the script's fetch AbortSignal
```

The bridge caps request bodies at 1 MiB.

### `--yolo`, and why the gate still works

`--yolo` does **not** skip PreToolUse. `fixtures/cmd/shell-yolo/` is a
`shell_command` under `--yolo`: the hook fires, with `permission_mode:
"bypass"`, and gates the call.

And a deny under `--yolo` really stops the call. That is the one claim the whole
gate rests on, so it is recorded against the argv the connector actually builds:
`fixtures/cmd/shell-deny-yolo/` is `--yolo` plus `--tools-enable
ask_user_question`, a `cp note.txt copied.txt` the prompt asks for and the model
calls the shell tool to run, and a hook that answers deny. The frames carry `tool_hooks` with `outcome.kind:
"block"` and then `tool_hook_blocked`; the recorder diffs the whole workspace
afterwards and `copied.txt` is not in it. `fixtures/cmd/shell-deny/` is kept
beside it as the counter-example — the same deny without `--yolo`, where print
mode would have refused the call anyway, so it proves nothing about the gate.

The reverse is also true and less obvious: **a hook that allows is not enough.**
`fixtures/cmd/shell-allow/` ran without `--yolo`, the hook answered allow, and
print mode refused anyway, with `tool_hook_blocked` carrying:

> `Error: Tool "shell_command" requires permissions. Use --yolo (or
--dangerously-skip-permissions) to enable file writes and shell commands in
print mode.`

The refusal names whichever tool was queued — `fixtures/cmd/plan-no-yolo/`
carries the same sentence with `write_file` in it.

Hence `--yolo` on every ordinary turn.

### When the gate is not there

The gate's failure mode is to open: a hook that does not run produces no
decision and the harness falls back to its own flow. Two guards:

- The hook command written into `settings.local.json` is shell-quoted. The
  harness runs a hook's `command` through `/bin/bash`, so on an account whose
  home is `/Users/First Last` the unquoted path split into two words, the hook
  never ran, and under `--yolo` every shell call and file write in that session
  ran without raising a card. A path that needs no quoting is still written
  exactly as before, so no existing settings file changes.
- Every turn counts the tool calls it queued and the hook posts it answered.
  Across the 25 recorded turns that are not plan turns those counts match
  exactly, one post per queued call, so a turn that queued tools and posted
  nothing gets a `session.warning`: `N tool call(s) ran without reaching
Poseidon's approval gate — the PreToolUse hook did not fire, so this turn was
not gated`. Plan mode is exempt and is the only place the two counts diverge:
  the three plan-mode turns queue five tool calls between them and post
  nothing, because no hook fires there by design.

## Plan mode

A plan turn is spawned with `--permission-mode plan` and **without `--yolo`**.
It is the only turn that omits the flag, and the reason is the whole of plan
mode's enforcement.

**Plan mode skips PreToolUse entirely.** `hookCount` is 0 for every plan-mode
turn across the four plan recordings — `plan/` turn 2 is the ordinary accept
follow-up and fires two hooks, which is the contrast that makes the point —
and `plan-guard`'s `read_file` produced no hook although the same
tool fires one in an ordinary run (`fixtures/cmd/file-edit/`). So none of the
permission ladder runs there — not the user's deny rules, not the CLI's own
"plan mode is read-only", not the sensitive-path prompt. Poseidon's gate is not
merely unaffected by `--yolo` in plan mode; it was never present.

Adding `--yolo` on top therefore removed the last thing standing: print mode's
own refusal. `fixtures/cmd/plan-guard/` and `fixtures/cmd/plan-write/` are that
experiment — plan mode with `--yolo`, told outright to mutate. Both left the
workspace untouched, which is two observations of good behaviour and not an
enforcement mechanism, in a mode the UI labels "Plan first".

Without `--yolo` the CLI refuses every write and every shell call itself
(`fixtures/cmd/plan-no-yolo/`), which is what the mode claims to be. The plan
survives the refusal, because the whole body of the refused `write_file` is in
the `tool_queued` frame that announced the call: the connector writes the file
itself (`materializePlan`) and proposes it as before. That refused write is
shown as a saved plan — the row reads `plan saved` and completes — rather than
as a red failure.

### Finding the plan

Plan mode puts a markdown file in `~/.commandcode/plans/`. Interactive sessions
also record it in `plans-index.json` beside it:

```json
{ "version": 1, "plans": { "<file>": {
    "title": …, "sessionId": …, "cwd": …,
    "status": …, "createdAt": …, "updatedAt": …, "annotations": [] } } }
```

**Print mode does not write that index.** In `fixtures/cmd/plan/` the model
puts the plan there with an ordinary `write_file` and `plans-index.json` is
untouched. An index-only lookup therefore finds nothing for every plan turn
this connector runs.

So `readPlanProposal` asks three sources in order:

1. `plans-index.json`, filtered to entries whose `sessionId` is this session's,
   newest `updatedAt` (or `createdAt`) first. Timestamps may be epoch millis or
   ISO strings.
2. The plan files this turn's own `tool_queued` frames named — a write whose
   parent directory is `plans` and whose name ends `.md`. Only the base name is
   taken, because the plans directory is fixed and a frame's absolute path may
   not be one this process can open.
3. An mtime scan: the newest `.md` in the plans directory written at or after
   the moment the turn was spawned, with one second of slack for clock skew.

The scan is a guess and it is fenced, because the plans directory is global —
every thread of every project writes into it, and so do the user's own
interactive sessions. It skips any file another live session has already
claimed, so two concurrent plan turns cannot propose each other's plan. Claims
are released when the session closes.

A settled plan turn emits two events for one proposal: an `item.completed` of
kind `plan` (the row that stays in the thread's history) and
`turn.plan.proposed` (the card the user answers, which clears the moment they
do). Both go out while the turn is still open — after `turn.completed` the
engine no longer tags events with that turn id. A plan already proposed is not
proposed twice; the key is `<path>#<updatedAt>`, so a revised plan does
re-propose.

A plan-mode turn that produced no plan is a normal outcome, and every failure
in this path resolves to "nothing proposed".

The user's answer to a plan card comes back as an ordinary `send`, so
`respondToPlan` on the session handle does nothing.

## `ask_user_question`

The tool is **withheld** in print mode. `fixtures/cmd/question/` is the
connector's own argv with a prompt that insists on the tool: the model cannot
reach it and asks its question as prose, which no card renders and no answer
returns to.

`--tools-enable ask_user_question` un-withholds it, and every turn now passes
that flag. With it (`fixtures/cmd/question-tools/`) the tool fires and PreToolUse
receives the real payload:

```json
{
  "questions": [
    {
      "header": "Indent style",
      "question": "Do you prefer tabs or spaces?",
      "options": [
        { "label": "Tabs", "description": "Use tab characters for indentation." },
        { "label": "Spaces", "description": "Use space characters for indentation." }
      ]
    }
  ]
}
```

Print mode has no interactive channel, so the bridge answers by **denying the
tool and putting the user's answers in `permissionDecisionReason`**. The model
reads them as context instead of waiting for a prompt that will never come.

Nothing in `normalizeQuestions` trusts the payload, because the wire contract is
not forgiving — `questionId`, `question` and every option's `optionId`/`label`
are non-empty strings, and one missing field fails the encode at the transport
and loses the whole card. So ids are minted when absent, a bare string option
becomes `{optionId, label}`, a question that only has a header uses it as its
text, anything with no text at all is dropped, and no input can make it throw.
Alternate spellings are accepted for every field (`prompt`/`text`/`query` for
the question, `choices`/`answers` for the options, and so on).

The minted ids never travel back out. `describeAnswers` resolves each answer
against the question it came from, so the model receives the question text and
the option labels it wrote itself:

```json
[{ "question": "Do you prefer tabs or spaces?", "selected": ["Spaces"] }]
```

The CLI reports that denial as `tool_hook_blocked`, so the row would otherwise
read as a red failure carrying the user's own answers as an error message,
followed by a "do not retry this tool" sentence addressed to the model.
`readableAnswers` strips the policy sentence and renders the answers as
`question → answer` lines, and the row completes rather than fails.

## Subagents

The harness reports a delegation through three frames of its own, all carrying
the `toolCallId` of the `agent` call that spawned it: `subagent_start`
(`subagentType`, a title), `subagent_progress` (one per inner tool call:
`toolName`, `toolInput`), `subagent_stop` (`tokensUsed`). They become progress
lines on that one `task` row, which `tool_completed` finally replaces with the
subagent's answer.

**The subagent's own tool calls are not gated.** PreToolUse fires exactly once,
for the delegation, with `tool_name: "agent"` and the subagent's brief as the
input:

```json
{
  "description": "Read note.txt file",
  "prompt": "Read the file note.txt … report exactly what it says."
}
```

The subagent in `fixtures/cmd/subagent/` then ran `read_file` and no hook fired
for it. Two consequences the approval design owns:

- **Approving an `agent` call approves everything it goes on to do.** The gate
  is the delegation, not the work, and the prompt in that one payload is all
  the user gets to judge. Anything stricter would have to come from Poseidon,
  not from a hook the harness never calls.
- **`subagent_progress` is the only visibility there is.** Unread, the row would
  sit silent for the whole delegation.

## Session ids and resume

`run_start.sessionId` is the id. `--verbose` also prints `session: <uuid>` as
the first line of stderr, which the pump reads as a fallback so the transcript
tailer can start even if `run_start` has not arrived.

The connector persists a `CmdSessionRef`:

```ts
{
  (sessionId, transcriptPath, cwd, lastMessageId);
}
```

`lastMessageId` is the newest transcript message already emitted —
`meta.messageId`, or the transcript line's own `id` when the message is
anonymous. On resume the tailer picks up right after it: lines written while
the server was down get emitted, earlier ones do not repeat. A ref persisted
before this field existed reads as `null`, which folds the whole file.

The ref is written the moment `run_start` names the session, not only at
process exit, and re-announced afterwards with the marker the turn advanced it
to. Its `transcriptPath` starts as the slug guess — `session.started` fires
seconds before the harness creates the file — and is re-pointed at the real
file once the lookup finds it.

**A session id is only resumable while its transcript exists.** `--session
<id>` against an id with no `.jsonl` on disk is not a fresh start; it is a
failed run:

```
Error: --session "<id>" is neither an existing .jsonl transcript nor a known session-id prefix.
```

and the process exits 1 before emitting a single frame. A run killed by SIGINT
never writes its transcript, so the id from its `run_start` names a session that
no longer exists anywhere — which left every turn after the user pressed Stop
failing, forever, on a thread that looked perfectly healthy
(`fixtures/cmd/interrupt-resume/`, turn 2).

So `makeSessionRefLocator.resumable` asks the filesystem before an argv is
built — the same question the harness asks, so the answer cannot drift from it
— and a session with no transcript continues in a new session with a
`session.warning` saying so (`fixtures/cmd/interrupt-continue/`).

A resumed session folds the existing transcript up to the marker _silently_
before its first turn, so the translator knows what a previous runtime already
emitted and the `run_end` `nextState` replay does not re-emit the whole
conversation with fresh item ids.

The fold stops at the marker only on a message line. The translator starts out
holding the marker, so a check after the transcript's header line used to end
the fold before it had read a single message.

#### Forking a session

`--fork-session` beside `--session <id>` copies that session into a new one and
leaves the original as it was. `fixtures/cmd/fork/` records it (CLI 1.66.0,
`poolside/laguna-s-2.1-free`): a first turn in session A; a second turn spawned
with `--session A --fork-session`; a third that resumes what the second named.
What it shows:

- the forked turn's `run_start`, `result` and stderr name a **new** session B,
  and the model still answers from A's history;
- B's transcript sits beside A's and opens with a copy of A's messages under
  the same `meta.messageId`s. Its header keeps A's id in `id` and names B in
  `sessionId`, so the translator reads a header's `sessionId` first — reading
  `id` sent the next turn back to A;
- the recorder read A's transcript again after each later turn
  (`earlierSessions` in the manifest), and its byte count never changed;
- the third turn, `--session B` without the flag, resumes B.

`resumeSession` with `fork: true` opens a session that runs its first turn with
`--fork-session` and every later one as a plain resume of the session
`run_start` named. The copied messages are deduped against the fold of A that
runs before the first turn, so the fork's timeline shows only its own turns. A
ref with no transcript left on disk cannot be forked, so that resume fails with
`SpawnFailed` instead of quietly starting a fresh session; the server then
starts one itself and sends the fork's transcript with the first message.

### Capabilities

`CMD_CAPABILITIES` in `capabilities.ts`, and why each value is what it is:

| Capability                   | Value      | Why                                                                          |
| ---------------------------- | ---------- | ---------------------------------------------------------------------------- |
| `modelSwitch`/`effortSwitch` | `per-turn` | `--model` and `--effort` are argv of each turn's process                     |
| `steering`                   | `false`    | one print-mode process per turn; a second message is queued                  |
| `planMode`                   | `true`     | `--permission-mode plan`                                                     |
| `subagents`                  | `true`     | subagent frames become progress on the `agent` row that spawned them         |
| `images`                     | `true`     | staged and named by path; see [Attachments](#attachments)                    |
| `resume`, `fork`             | `true`     | `--session <id>`; a fork's first turn adds `--fork-session`                  |
| `interrupt`                  | `turn`     | SIGINT to the turn's process group; the session and its transcript remain    |
| `rollback`                   | `false`    | the harness cannot rewind its conversation; Poseidon's checkpoints are git   |
| `compaction`                 | `false`    | the harness compacts by itself; print mode cannot be asked to                |
| `questions`                  | `true`     | `ask_user_question`, enabled on every turn                                   |
| `runtimeModes`               | all three  | Poseidon's permission engine decides every mode through the PreToolUse hook  |
| `attachments`                | `files`    | any file can be staged and named, though the renderer only stages images yet |
| `textGeneration`             | `true`     | `generateText`: one print run, no session, one turn, no `--yolo`             |

Command Code's own effort ladder is `low` to `max`. The contract's `minimal`
never appears in a model's `efforts`, because nothing recorded shows the CLI
accepting it. A thread can still carry it — a saved default, or the whole
ladder offered while a model is not in the catalog — and the CLI exits 1 on an
effort the model does not support, so `cmdEffort` (`turnArgs.ts`) sends
`--effort low` for it instead.

### One turn at a time

`send` holds a one-permit semaphore through the whole
check → settle → spawn → install sequence, so two concurrent sends cannot both
observe an empty process slot. A send arriving while a turn is running fails
with `TurnInProgress` and the caller queues it. A send arriving between
`turn.completed` and the process being fully reaped waits the pump out: the
active process carries two latches, `turnDone` (the completion event has been
emitted) and `settled` (every post-exit side effect has landed).

A signal death nobody asked for ends the session with `reason: "crashed"`,
which is what lets the supervisor resume from the persisted ref. A child the
user interrupted reads as exit 130 whatever signal actually finished it off,
because the kill ladder ends in SIGKILL and node reports that as a null code.

## Attachments

Print mode has no image flag — `cmd --help` lists none at any version we have
run. So the connector stages the files and names their paths in the prompt:

1. each attachment is placed under `<attachmentsDir>/<threadId>/`. Most are
   already there, because the server stages composer uploads straight into that
   directory; one that came from elsewhere is copied in, under
   `<sha256 prefix or index>-<safe name>` so it cannot collide or escape;
2. that directory is passed as `--add-dir`, which puts it in the run's
   workspace scope;
3. the prompt gains one line per attachment:
   `Attachment (image/png): /absolute/path` — or `Attachment: /absolute/path`
   when the media type is unknown. The type is stated because a path alone does
   not say "look at this as a picture", and the harness has to choose to read
   it.

Nothing here runs a shell. The paths end up as one argv element each and as
text inside the prompt, so a file name is never interpreted.

A copy that fails is not fatal: the original path is used, and the turn emits a
`session.warning` naming the file. A turn the user asked for beats no turn.

This works end to end. `fixtures/cmd/image/` stages a PNG exactly this way; the
model called `read_file` on it, the harness answered with `Read image red.png
and attached it below for viewing (618 B, image/jpeg)` plus a base64 image block
— it transcodes to JPEG — and the model answered with the colour of the pixels.

## What the connector writes into the user's machine

Four things, in three places. All of them are put back.

| path                                        | what                            | ownership marker                   |
| ------------------------------------------- | ------------------------------- | ---------------------------------- |
| `~/.poseidon/bin/cmd-hook.mjs`              | the generated hook script       | ours entirely; rewritten by hash   |
| `~/.poseidon/bin/tickets/<threadId>.ticket` | the session bearer, mode 0600   | deleted when the session closes    |
| `<root>/.commandcode/settings.local.json`   | the PreToolUse hook block       | a hook _command_ naming our script |
| `~/.commandcode/projects/<slug>/mcp.json`   | the `poseidon` MCP server entry | the server name `poseidon`         |

### The hook block

```json
{
  "matcher": ".*",
  "hooks": [{ "type": "command", "command": "<hookPath>", "timeout": 590 }]
}
```

appended to `hooks.PreToolUse`. `.*` is a regex over the tool name; an empty
matcher risks matching nothing, which would leave every tool ungated under
`--yolo`. The path is shell-quoted when it needs it.

The merge preserves every other key and every other hook entry. **Ownership is
decided per hook command, not per entry**, so a user hook sharing a matcher
entry with ours survives the removal. A command counts as ours when it equals
the script path (quoted or not) or ends in `/cmd-hook.mjs`.

A `settings.local.json` that exists but is not strict JSON — a comment, a
trailing comma, an array — is left untouched, and the session says so:
`.commandcode/settings.local.json is not valid JSON — left it untouched, so
tool calls are not gated by Poseidon`. Merging onto the `{}` a failed parse
would otherwise yield would replace the user's permission lists.

Teardown is conditional twice over. The install returns the hash of the exact
bytes it wrote, and the revert runs only while the file on disk still hashes to
that; a file the user or `cmd` has edited since is not ours to undo. And a
per-path retain count keeps the first session to close from pulling the hook out
from under a second session running in the same project. A file we created and
left empty is deleted rather than left as a husk.

While the block is in place the file is kept out of the user's commits. The
block names this machine's hook script by absolute path, so a commit that picked
it up — `git add -A`, or the commit dialog with every file checked — would push
a hook that points nowhere anywhere else, and the teardown's delete would then
leave a tracked deletion in the tree. So the install adds the anchored line
`/.commandcode/settings.local.json` to the repository's `info/exclude` (from
`git rev-parse --git-path info/exclude`, which every worktree of the repository
shares; it is never committed), unless git already ignores or tracks the file.
A retain count per exclude file keeps the line until the last session in any of
the repository's worktrees closes, and the teardown then takes out just that
line.

### The MCP entry

The `poseidon` server goes into the **local scope**, which is
`~/.commandcode/projects/<slug>/mcp.json` — not `<projectRoot>/.mcp.json`, which
lives inside the user's git repo and would be committed with a dead loopback URL
in it.

**The CLI writes that file, not us.** The slug is the same private naming rule
the transcript locator refuses to reimplement, and writing the file ourselves
put the entry in a directory the harness never reads whenever the workspace path
had a camel hump or an underscore in it — which meant Poseidon's browser tools
were advertised to nobody in those projects, silently, while working fine in
others. So:

```sh
cmd mcp add-json poseidon '{"transport":"http","enabled":true,
  "url":"<endpoint>","headers":{"Authorization":"Bearer ${POSEIDON_MCP_TOKEN}"}}' \
  --scope local --no-auto-update
cmd mcp remove poseidon --scope local --no-auto-update
```

The bearer stays a `${POSEIDON_MCP_TOKEN}` placeholder: the harness resolves env
references at launch, and the per-session token must never touch disk.

Each `cmd mcp` call gets 10 seconds and is killed with SIGKILL after that.
It used to get forever, and synchronously — and since this runs on the first
turn of every thread and on every session close, a `cmd mcp` blocked on a config
lock wedged the whole server: the WebSocket did not drain, another thread's
approval card hung, no timer fired.

A refusal is reported rather than assumed away: `the harness refused to register
Poseidon's MCP server, so its tools are unavailable this session`.

Each enabled Poseidon plugin's MCP servers are registered beside it by
`sessionMcp.ts`, through the same command, as
`poseidon-plugin-<plugin>-<server>` (characters outside `[A-Za-z0-9_-]` become
`-`), with `transport` `http` (`url`, `headers`) or `stdio` (`command`, `args`,
`env`) as the plugin's `.mcp.json` declared them, `${CLAUDE_PLUGIN_ROOT}`
already expanded. A refused one is a `session.warning` naming the server and
its plugin; the session goes on without it.

Every entry is held per workspace root (resolved through symlinks) and name, because every
thread of a project shares one file; the first thread to close must not remove
it under a second one still running turns. The **name** is the ownership
marker, so a server the user added under any other name is untouched.

That file is the project's, and every `cmd -p` in the project loads all of it;
no flag narrows a run to some of its servers. So a plugin turned off after
another thread in the project started with it on still reaches a new thread's
turns until the other thread closes. Before each turn `sessionMcp.ts` checks
the entries every other live session holds in the same project, and a plugin
this session did not start with gets one `session.warning`: `the MCP servers
of the plugin "<name>" are still registered in this project by another running
session, …`.

Both project-level files are reverted by the session that installed them, and
the server's session manager closes every open session at shutdown — otherwise
the finalizers never ran and every server exit left a hook block and an
`poseidon` entry naming a dead port behind, one per session, in files the user
owns.

### What the Customize page edits

Separately from the session's own files, an instance carries two extensions
(`connector-sdk/src/extensions.ts`) the Customize page reaches through
`connectors.skills.*` and `connectors.mcp.*`:

- **MCP servers** (`mcpServers.ts`): `~/.commandcode/mcp.json` for user scope
  and `<workspaceRoot>/.mcp.json` for project scope. Every server Poseidon
  writes carries an `_poseidon` marker, and add/remove refuse an entry without
  it; a disabled server is parked under `_poseidonDisabled`, because Command Code
  launches everything under `mcpServers`; a file that does not parse is never
  rewritten.
- **Skills** (`skills.ts`): read from `~/.commandcode/skills` and
  `<workspaceRoot>/.commandcode/skills`, project winning a name collision. A
  skill in `~/.agents/skills` can be linked into the user root as a relative
  symlink; nothing is copied.

`makeCmdConnectorDefinition({ commandCodeHome, agentsSkillsRoot })` moves both
homes, which is how tests keep off the real ones. Left unset, they sit under the
instance's `extraEnv.HOME` when it sets one — the home the CLI itself resolves —
and under the user's home otherwise. Writes from every instance of the
definition share one semaphore, so two never interleave on one file.

The instance carries no `commands` extension, so `connectors.commands.list`
answers `unavailable` and the composer's `/` menu lists no harness commands for
its threads. The only list of Command Code's slash commands is the "Slash
Commands" block of `cmd --help` (`fixtures/cmd/probe/help.stdout.txt`), and
those are the interactive app's commands (`/theme`, `/copy`, `/ide` and the
like). Nothing recorded shows which of them a headless `-p` run executes rather
than sending to the model as text, so the connector does not offer them.

## Known CLI behaviour worth remembering

- **`--output-format json` does stream text.** `text_delta` carries
  `{delta: "<text>"}` and `thinking_delta` the same for reasoning;
  `message_update` re-sends the whole message after every delta, and
  `message_end` carries the finished content blocks. `fixtures/cmd/text/` is one
  `text_delta` for a one-word answer; `fixtures/cmd/plan/turn1` has eleven.
- **The transcript is not a live source.** See [The transcript](#the-transcript).
- **`ask_user_question` is withheld** unless asked for by name.
- **There is no image flag.** Attachments are staged and named in the prompt.
- **`--permission-mode` accepts `standard`, `plan`, `auto-accept`.** What the
  _hook_ is told in `permission_mode` is neither: `default` ordinarily, `bypass`
  under `--yolo`.
- **The plan file is written mid-run by an ordinary `write_file`, and nothing in
  `run_end` references it.** `plans-index.json` is not updated by a headless
  run.
- **PreToolUse fires for MCP tools** — `fixtures/cmd/mcp/` shows the `.*`
  matcher covering `mcp__rec__echo` with the server-defined input — **and for a
  subagent delegation exactly once.**
- **An anonymous delta run needs its kind in the key.** An agent step streams
  `thinking_delta*` and then `text_delta*` with neither a message id nor an
  index (`fixtures/cmd/resume/turn2`, and the same shape in `mcp`,
  `shell-twice/turn2`, `question-tools`, `plan-write`, `plan-no-yolo` and
  `shell-deny`), so a kind-less key put the answer on the row the thinking
  opened.
- **SIGINT prints `Interrupted.` on stderr and stops.** No `run_end`, no
  `result`, exit 130, and no transcript.
- **`--max-turns` exhaustion is exit 8 with `result.subtype: "max_turns"`** and
  `stopReason: "max_turns"` (`fixtures/cmd/max-turns/`).
- **An unknown `--model` fails before the model call**, exit 1, with
  `Error: unknown model "…".` on stderr and nothing on stdout — so it costs
  nothing.

## After a new CLI release

The connector is not pinned, so a release arrives without warning — the probe's
own `status --json` call is allowed to auto-update the binary. Four things
catch drift, in the order they will tell you:

1. **`recordedFrames.test.ts`** replays every recording and fails on any
   `event.unmapped`. It also asserts the plan invariants (`hookCount: 0` on
   every plan-mode turn, `touchedFiles: []` in `plan-guard` and `plan-write`),
   so a release that starts firing PreToolUse in plan mode says so.
2. **`recordedArgs.test.ts`** rebuilds every recording's argv from `buildArgs`
   and demands the same list, so a flag that changes spelling is caught at the
   point it changes.
3. **The live conformance suite**, which is the only thing that proves the argv
   is argv the _current_ `cmd` accepts, that the session id still arrives on
   stderr, and that a deny under `--yolo` still stops a call:

   ```sh
   POSEIDON_LIVE_CMD=1 pnpm vitest run apps/server/src/hooks/cmdLiveConformance.test.ts
   POSEIDON_LIVE_CMD=1 pnpm vitest run apps/server/test/e2e
   ```

   Both spend the account's plan, so they are skipped without the variable and
   the gate runs the same scenarios against the recordings.

4. **Re-recording**, when something did change. The scripts, the authorised
   models and the scrubbing are in
   [development.md](development.md#recordings-of-the-real-cli); recordings are
   never edited by hand to make a test pass.

Beyond the tests, the things to read after an upgrade:

- `cmd --help`, against the flag list above — particularly `--tools-enable`,
  `--permission-mode`, `--yolo` and `--add-dir`.
- `cmd status --json`, for a field that appeared or moved (`context_window` is
  the one the composer depends on).
- `cmd --list-models`, for a column layout or an id shape the parser does not
  expect — a new bare-id family, an effort ladder actually being printed, or a
  name column (or JSON listing) appearing, which would replace
  `modelNameFromId`.
- Whether an image flag has appeared, which would replace the whole attachment
  staging path.
- Whether the hook environment still redacts secret-shaped names, which would
  let the ticket file go.

`OLDEST_TESTED_VERSION` moves only when the recordings are remade on a newer
release, and it is a floor for warnings, never a requirement.
