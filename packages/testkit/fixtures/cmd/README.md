# Command Code recordings

**Every directory here is a real recording of the real Command Code CLI.**
Nothing in it is hand-written, reconstructed or synthesized. If the CLI changes,
these are re-recorded — they are never edited by hand to make a test pass.

|             |                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| CLI         | `/opt/homebrew/bin/cmd` (the operator's global install)                                                                       |
| Version     | **1.55.1**; **1.56.0** for the six after it; **1.65.0** for `skill/`; **1.66.0** for `fork/` and the two `generate-text` ones |
| Recorded on | **2026-09-18**, **2026-09-24** for `skill/`, **2026-09-28** for `fork/` and `generate-text*/`                                 |
| Model       | `meta/muse-spark-1.3-contributor` (the account default); `poolside/laguna-s-2.1-free` for `fork/` and `generate-text*/`       |
| Recorded by | `packages/testkit/scripts/record-cmd.mjs`                                                                                     |

Each `manifest.json` carries the model its own frames name, the CLI version it
ran on and the day it was recorded, so a recording made on a different model or
a later release says so rather than inheriting this table. The connector runs
whatever `cmd` the user has installed, so the recordings are not pinned to one
release either — the tests only insist that none predates
`OLDEST_TESTED_VERSION`.

Each run was spawned with the argv and environment
`packages/connector-cmd/src/spawn.ts` builds, in a throwaway git repo, with the
recording PreToolUse hook installed through the same
`.commandcode/settings.local.json` mechanism `config.ts` uses.

`packages/connector-cmd/src/recordedArgs.test.ts` holds that claim to account:
it reads every manifest's `connectorArgs` back into a `buildArgs` input, rebuilds
it and demands the same list. Two kinds of difference are allowed and both are
written down in that file — the recordings that drop `--yolo`
(`plan-no-yolo`, which is the argv a plan turn is spawned with today;
`shell-allow` and `shell-deny`), which are the counter-examples
that say what the flag is for, and `--tools-enable ask_user_question`, which
joined the argv after most of these were taken and un-withholds one tool without
changing anything else they are cited for. Anything else fails the build.

`generate-text/` and `generate-text-effort/` are not turns: they record the
one-shot argv `packages/connector-cmd/src/generateText.ts` spawns for a
commit message or a title — `--no-session --max-turns 1`, no `--yolo`, no
`--tools-enable` — in an empty directory of their own outside the repo, where
no hook is installed. The same test holds them to `generateTextArgs`, and
names them as the recordings that carry no `--yolo` by design.

## Re-recording

Recording spends the operator's paid plan, so it is never run from CI:

```sh
node packages/testkit/scripts/record-cmd.mjs --list
node packages/testkit/scripts/record-cmd.mjs shell-allow
node packages/testkit/scripts/record-probe.mjs      # no model turns
```

`--model <id>` overrides the account default, and the recorder refuses any id
but the three the operator authorised — `meta/muse-spark-1.3-contributor` (the
default), `poolside/laguna-s-2.1-free` and
`inclusionai/ling-3.0-flash-sante:free` — before it spawns anything. Most of the
seventy models `--list-models` offers bill real money.

## What each directory holds

`manifest.json` is the index: the argv and env keys the run used, the exit code
and signal, the session id, stdout chunk arrival order, transcript growth
samples, hook count, plan files and touched files, and — for a turn after the
first — the byte count of every earlier session's transcript as it stood when
that turn ended (`earlierSessions`). Beside it:

| file                | what it is                                               |
| ------------------- | -------------------------------------------------------- |
| `stdout.ndjson`     | every NDJSON frame, in arrival order                     |
| `stderr.txt`        | `--verbose` stderr, including `session: <uuid>`          |
| `transcript.jsonl`  | the on-disk session transcript as it ended up            |
| `checkpoints.jsonl` | the `<id>.checkpoints.jsonl` the CLI wrote               |
| `hooks.json`        | every PreToolUse invocation: the CLI's stdin, our answer |

Multi-turn scenarios prefix each file with `turn1.` / `turn2.`.

## The scenarios

| directory               | what it proves                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe/`                | `status --json`, `--list-models`, `--version`, `--help`, bad model                                                                                                                                   |
| `text/`                 | a text-only answer; `text_delta` streaming                                                                                                                                                           |
| `shell-allow/`          | `shell_command` allowed through the hook — and still refused without `--yolo`                                                                                                                        |
| `shell-deny/`           | the same call denied by the hook — `tool_hook_blocked`                                                                                                                                               |
| `shell-yolo/`           | the same call with `--yolo`; the hook still fires and the call runs                                                                                                                                  |
| `file-edit/`            | `edit_file` against a real file                                                                                                                                                                      |
| `plan/`                 | `--permission-mode plan --yolo` writing a plan, then the accept follow-up                                                                                                                            |
| `plan-no-yolo/`         | plan mode without `--yolo`: the plan file itself is refused                                                                                                                                          |
| `plan-guard/`           | plan mode with `--yolo`, told to edit: the workspace stays untouched                                                                                                                                 |
| `plan-write/`           | the same, told to write a new file and not to plan — still untouched, and still no hook                                                                                                              |
| `question/`             | `ask_user_question` with the connector's argv — the tool is withheld                                                                                                                                 |
| `question-tools/`       | the same with `--tools-enable ask_user_question` — it fires, and the hook sees the questions                                                                                                         |
| `image/`                | an image attachment staged the way the connector stages one                                                                                                                                          |
| `mcp/`                  | an `mcp__<server>__<tool>` call — PreToolUse fires for it                                                                                                                                            |
| `subagent/`             | an `agent` delegation — one hook for the delegation, none for what the subagent then does                                                                                                            |
| `skill/`                | a skill reference written the way `prepareTurn` writes it — `activate_skill` fires for it                                                                                                            |
| `interrupt/`            | SIGINT mid-turn — exit 130, no `run_end`, no `result`                                                                                                                                                |
| `resume/`               | a second turn resuming the first session id                                                                                                                                                          |
| `fork/`                 | `--session <id> --fork-session`: a new session with the history, the first left untouched                                                                                                            |
| `shell-twice/`          | the same shell call twice in one session — what "allow always" has to answer                                                                                                                         |
| `file-edit-twice/`      | two editing turns in one session — two checkpoints with a real diff between them                                                                                                                     |
| `interrupt-resume/`     | a SIGINT'd turn, then a resume of it: the harness refuses, because it wrote no transcript                                                                                                            |
| `max-turns/`            | `--max-turns` exhausted — exit 8, `subtype: "max_turns"`                                                                                                                                             |
| `generate-text/`        | the one-shot `generateText` argv: one answer on the `result` line, no transcript written — but `<id>.checkpoints.jsonl` and `<id>.meta.json` still left in a project directory (`projectDirListing`) |
| `generate-text-effort/` | the same with `--effort low` on a model that takes none: refused on stderr before any frame, exit 1                                                                                                  |

## Putting them back on the wire

`packages/testkit/bin/replay-cmd.mjs` replays a recording as if it were `cmd`.
It has no behaviour of its own — it chooses nothing and synthesises nothing —
and it is what every test that used to drive an invented stand-in now spawns:

```ts
import { replayConfig } from "@poseidon/testkit/replayCmdProcess";
const config = replayConfig("shell-yolo", { home: tempHome });
// → { binaryPath, extraEnv }: point a connector instance at it
```

It puts stdout back in the recorded chunk boundaries, appends the transcript
progressively into the project directory the harness really used, invokes the
project's installed PreToolUse hook at the recorded points with the recorded
payload and blocks on the answer, and exits with the recorded code. A test that
wants a different outcome names a different recording.

`interrupt-resume/` is the one recording whose second turn is a _failure_, kept
deliberately. Handed `--session <id>` for the session its own first turn was
interrupted in, the harness answers:

```
Error: --session "<id>" is neither an existing .jsonl transcript nor a known session-id prefix.
```

and exits 1 with no `run_start` — a SIGINT'd run never writes the transcript
that makes its id resumable. It is the evidence behind the filesystem check in
`packages/connector-cmd/src/sessionRef.ts`, and the counter-example the "opens
exactly one turn" assertions in `recordedFrames.test.ts` are scoped against.

`probe-insufficient-credits.ndjson` is the one loose file: a real capture from
2026-09-15, when the account had no credits, and the only recording of
`run_error` and the exit-10 path. It cannot be made again now the plan is paid
for, so it is kept in the raw shape the first probe wrote it in.

## Scrubbing

Recordings are scrubbed on the way in: the operator's home directory becomes
`<HOME>`, the scratch root becomes `<SCRATCH>`, their account name becomes
`user`, and anything token-shaped becomes `<REDACTED>`. Session ids and trace
ids are left alone — they are per-run identifiers with no meaning off this
machine, and the tests match on them.

Conclusions drawn from these recordings are written up in
`docs/command-code-connector.md`.
