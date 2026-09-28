# Philosophy

Poseidon is an Electron desktop app that drives an agentic coding CLI. It does
not contain an agent. It spawns one, watches what it does, and gives the user a
place to see it and answer it.

That single decision — the app is a driver, not an agent — produces most of the
rules below. The rest come from wanting a thread to survive a crash, a second
harness to be addable without touching the UI, and a test suite that fails when
reality changes rather than when a machine is slow.

Each principle below says what it means concretely in this repository, where it
is enforced, and what a contributor has to do to honour it. Where a rule is
machine-checked, the check is named; a rule with no check is a rule that will
erode, and several here exist only because a check was added after something
went wrong.

The pieces these rules are about are described in
[architecture.md](architecture.md), what they do at runtime in
[how-it-works.md](how-it-works.md), the commands in
[development.md](development.md), and each harness's own behaviour in
[command-code-connector.md](command-code-connector.md),
[claude-code-connector.md](claude-code-connector.md) and
[codex-connector.md](codex-connector.md).

## 1. The harness is the source of truth

Poseidon never re-implements what the CLI does. It does not vendor it, bundle it,
pin it, or keep a stand-in copy of it.

`packages/connector-cmd/src/binary.ts` resolves, in order: the configured
`binaryPath`, `cmd` on `PATH` plus the global bin directories a GUI process does
not inherit, then `npx -y command-code@latest`. Nothing anywhere names a
version to install. `OLDEST_TESTED_VERSION` in
`packages/connector-cmd/src/probe.ts` is `"1.54.0"` and is only a warning floor:
below it the probe adds a line, at or above it the probe says nothing, now and
for every future release. A version string that will not parse does not warn
either. There is no update checker and no UI for one.

The same principle decides when the CLI may upgrade itself. The probe runs
`status --json` and `--list-models` _without_ `--no-auto-update`, because a
probe is the one safe moment for the binary to change. Turn spawns keep
`--no-auto-update`, because swapping the binary under a running conversation is
not.

It also decides what the app refuses to guess. The harness's project-directory
slug is a private rule (camel humps and repeated dashes are rewritten), so the
connector does not reimplement it: the transcript is located by the `sessionId`
the harness announced, and the MCP entry is written by asking the CLI itself
(`cmd mcp add-json --scope local`), not by writing the file at a path we
computed.

**To honour it:** when you need a fact about the CLI, get it from the CLI. Add a
recording under `packages/testkit/fixtures/cmd/` rather than a constant. If you
find yourself writing the harness's own logic a second time — a path rule, a
config format, a plan index — look for the command that does it instead. What
each CLI has been observed to do is written down once, in
[command-code-connector.md](command-code-connector.md),
[claude-code-connector.md](claude-code-connector.md) and
[codex-connector.md](codex-connector.md).

## 2. Contracts are the seam

`packages/contracts` holds every shape that crosses a boundary: ids, enums, the
23 `RuntimeEvent` variants a connector emits, the orchestration `Command` union
and its events, the read models and stream frames, the settings document, and
the RPC group. Nothing else defines a wire shape.

The contract is not the TypeScript; it is the TypeScript plus the JSON. Every
variant has a fixture under `packages/contracts/fixtures/`, and
`packages/contracts/test/fixtures.test.ts` decodes each one and encodes it back,
demanding the bytes on disk. The coverage cases derive their lists from the
schemas themselves, so a new variant without a fixture is a failing test rather
than a TODO, and a fixture nothing reads is also a failure.

Shapes grow by addition. New fields are optional so an older producer stays
valid — `Attachment` carries `mime`, `name`, `size` and `sha256` optionally for
exactly that reason. Nothing checks that a new field was added optionally; what
the round-trip test catches is the fixture that stopped matching, which is
usually the same mistake one step later. When a shape cannot grow additively, `PROTOCOL_VERSION` in
`packages/contracts/src/rpc.ts` is bumped, the server states it in `ServerHello`,
and a client that sees a different number goes to the terminal `incompatible`
connection state instead of retrying forever
(`packages/client-runtime/src/connection.ts`).

One escape hatch exists on the connector side and is deliberately loud:
`event.unmapped` is what a connector emits for a frame it does not understand,
and the schema rejects it unless `raw` carries the frame. Dropping unknown
frames silently would make harness changes invisible.

**To honour it:** change `packages/contracts` first, add the fixture in the same
commit, and let the round-trip test tell you what you broke. Never define a
second version of a wire shape next to its consumer.

## 3. Nothing above the connector boundary knows which harness is running

`packages/connector-sdk/src/definition.ts` defines what a connector is: its own
config schema, its own binary discovery and probe, and a translation of whatever
its harness emits into `RuntimeEvent`. Above that line — the orchestration
engine, the projections, the transport, the renderer — no code names a harness.

This is enforced by grep. `scripts/check-boundaries.mjs` fails the gate when a
non-test source under `apps/web`, `packages/client-runtime` or `apps/server`
imports a connector package other than the SDK, or writes a quoted connector
kind (`"cmd"`, `"claude"`, `"codex"`, `"opencode"`). Tests and the server's
composition root, `boot.ts`, are the exceptions: they assemble the real
connector on purpose. For the renderer it goes further and refuses the strings
`command code` (spaced or not), the quoted literal `"cmd"`, and `claude`,
`codex` and `opencode` as words anywhere under `apps/web/src`. It reads every
file, not only sources, and it checks file names as well as contents — a
connector name reads the same in a CSS class, an SVG title or a filename. The
spaced spelling was added after "Command Code" walked through a one-word
pattern and into the Skills tab's own description.

The same script keeps the names of the products Poseidon was compared against
out of the tree entirely — `apps/`, `packages/`, `scripts/` and the top-level
docs. An idea borrowed from elsewhere is described in our own words.

Capabilities are how the UI adapts without knowing. A connector declares
`ConnectorCapabilities` — `modelSwitch`, `effortSwitch`, `steering`, `planMode`,
`subagents`, `images`, `resume`, `fork`, `interrupt`, `rollback`, `compaction`,
`questions`, `runtimeModes`, `attachments`, and optionally `stopTask` — and the renderer branches on those
(`packages/connector-cmd/src/capabilities.ts`). The mode picker offers the
connector's `runtimeModes`, the composer refuses attachments when `images` is
false, and the decider steers a message into a running turn only for a
session whose `steering` is true — a harness without it keeps the queue.
A fork of a thread's latest turn is made by the harness itself when its
session declares `fork`, and is a transcript copy everywhere else.

**To honour it:** if the UI needs to behave differently for one harness, add a
capability flag to the contract and let the connector declare it. Never add a
string comparison against a connector kind above the SDK.

## 4. A connector's promises are executable

The engine is written against five promises — a session announces itself before
it reports work, every turn completes exactly once, every approval it opens is
resolved, nothing is emitted after `close`, and `close` proves the process tree
is gone — and they are a suite rather than a paragraph
(`packages/connector-sdk/src/conformance.ts`; the five are spelled out in
[architecture.md](architecture.md#the-conformance-suite)).

The suite drives the real definition — `createInstance`, `startSession`, `send`,
`close` — and inspects nothing a connector did not put on its event stream;
`isProcessGone` is the single hook it takes from outside, because proof that a
process tree is gone cannot come from the stream.

Breaking one of these does not fail loudly on its own. It strands a thread,
leaks a process, or leaves an approval card on screen forever.

**To honour it:** a new connector's test file is one call to
`runConnectorConformance`. Do not mark a case skipped to get green; the only
optional case is the approval one, and only for a harness that cannot be made to
ask for permission on demand.

## 5. The event log is the state

Everything durable is an append-only event.
`apps/server/src/persistence/EventStore.ts` owns `events` and
`command_receipts`; `apps/server/src/orchestration/decider.ts` is a pure
function from command plus folded stream state to events, with no clock, no I/O
and no id minting of its own; `apps/server/src/orchestration/Engine.ts` is the
single writer, serialised behind one semaphore, and writes events, projections
and the receipt inside one SQLite transaction.

Consequences the design depends on:

- **Replay is exact.** The decider takes its ids and its clock from `DecideEnv`,
  so a scripted conversation replays byte-identically in tests.
- **Projections cannot get ahead of their events.** They are written in the same
  transaction. A thread's read model _is_ its `ThreadDetailSnapshot`, stored as
  JSON (`apps/server/src/persistence/ReadModels.ts`), so a read is a single row
  and a rebuild is a pure re-fold.
- **A projection shape change is a re-fold, not a migration.**
  `PROJECTOR_VERSION` in `Engine.ts` is compared against the stamped
  `projector_version` at boot; a mismatch clears the projection tables and folds
  the whole log again.
- **A rejection is a result.** A refused command receipts as `rejected` and
  appends nothing.
- **An unreadable event is refused at write time.** `InvalidEvent` exists because
  one row that the schema rejects used to stop the thread opening and take the
  server down on the next boot replay.
- **A crash is recoverable.** `SessionSupervisor.ts` scans the thread read model
  at boot, resumes threads still bound to a `sessionRef` with backoff, and writes
  `thread.session.lost` rather than leaving a thread wedged.
  `CheckpointReactor.ts` replays work orders with no recorded outcome, so a crash
  between an accepted restore and the git work cannot drop the restore.

Migrations under `apps/server/src/persistence/migrations/` are numbered
contiguously from `0001`, applied in order, and never edited once merged;
`migrations.test.ts` enforces the numbering, the lineage table and idempotency.

**To honour it:** add a fact by adding an event and folding it, not by adding a
column the fold does not write. New migrations append at the next id. Nothing
outside the engine writes durable state.

## 6. Approval is required by default, and the gate fails closed

`apps/server/src/permissions/PermissionService.ts` is one ladder, evaluated in
order: a `deny` rule, then plan mode (read-only), then a sensitive path, then an
`allow` rule, then reads, then the thread's runtime mode. What each step answers
is in [architecture.md](architecture.md#permissions). One rung is the whole
principle.

**Ask outranks allow.** The sensitive-path check sits _above_ every remembered
`allow` and above `full-access`, because full access means everything except
secrets and explicit denials.

The user widens it, never the app: rules live in the `permission_rules` table,
scoped to a thread, a project or globally, and the `Settings.permissions` array
on the wire is a projection of that table, not a second place a rule can live.
"Sensitive path" means credentials and key material specifically
(`sensitivePaths.ts`), not caution in general.

The matcher is shared, not duplicated:
`packages/shared/src/permissionPattern.ts` is dependency-free and imported by
both the server and the renderer, so an "allow always" preview in the UI uses the
exact semantics the engine will enforce.

Failing closed is the harder half. `apps/server/src/hooks/HookBridge.ts` blocks
the CLI's `PreToolUse` POST until the user answers, up to 590s, then denies, and
every failure path in the generated hook script prints a deny. Three real
failures shaped that design; each one is written up against the recording that
shows it in [command-code-connector.md](command-code-connector.md):

- **The gate's failure mode was to open.** The CLI redacts secret-looking
  variable names out of a hook's environment, the bearer never arrived, and
  under `--yolo` every tool call ran unapproved. The bearer now travels as a
  path to a `0600` ticket file.
- **Plan mode fires no `PreToolUse` hook at all**, so none of the ladder runs
  there. A plan turn is therefore the one turn spawned _without_ `--yolo`
  (`packages/connector-cmd/src/turnArgs.ts`), so print mode's own refusal of
  writes and shell is what makes "Plan first" read-only.
- **Approving an `agent` delegation approves everything the subagent goes on to
  do**: the harness fires one hook for the delegation and none for its inner
  calls. The card has to show the subagent's brief, because that brief is all
  the user gets to judge.

On Claude Code the gate is in-process, and it is built so that "ask outranks
allow" survives the CLI's own permission system
(`packages/connector-claude/src/toolGate.ts`). The SDK's `canUseTool` alone is
asked only when the CLI would prompt, so a call the user's own `~/.claude`
rules allow, or any call under `bypassPermissions`, would never reach the
ladder. So a PreToolUse hook, which runs for every call in every mode, asks the
ladder first and answers "ask" for its "prompt", which the CLI hands to
`canUseTool` and the card. A hook that cannot reach a verdict answers "ask", a
`canUseTool` that cannot answer denies, and a turn whose tool calls ran while
the gate saw none ends with a warning on the thread. A subagent's calls reach
the hook one by one, so there the delegation does not approve what follows.
[claude-code-connector.md](claude-code-connector.md#the-gate) has the detail.

**To honour it:** a new tool kind gets a place in the ladder and a row in the
table test before it gets a card. When you touch the hook path, ask what happens
when a piece of it is missing, and make that answer "deny".

## 7. The renderer renders

`apps/web` holds no state the server owns, and no component calls the RPC
client. The connection is built once, in `apps/web/src/state/app-runtime.tsx`;
the client is reached only inside atom definitions — those of
`packages/client-runtime/src/atoms.ts` and its sibling factories
(`terminalAtoms.ts` among them), plus the settings atoms in
`apps/web/src/lib/app-runtime.ts`. Every component reads through the hooks in
`apps/web/src/state/hooks.ts` and writes by dispatching a `Command` through
`dispatchAtom` and awaiting its receipt — or, for what is not thread state in
the event log, such as the settings document or a terminal's input, through
the atom that makes that one call.

Nothing enforces that automatically the way the neutrality grep enforces
connector-neutrality, so it is a convention the code keeps rather than a guarded
invariant: a component that reaches for `Connection` itself is the thing to
catch in review.

The client's fold (`packages/client-runtime/src/clientState.ts`) is a projection
of the server's projection: it merges deltas and decides nothing. When a
component needs a piece of state that no atom carries, the answer is usually a
new event and a new field on the snapshot, not local state in React.

Boundaries back this up. `apps/web` may import only `ui`, `contracts`,
`client-runtime` and `shared`; it may not reach a connector package, the server,
or testkit, in tests or out of them. `packages/shared` has no Effect dependency
so the renderer can use it, and the renderer may import `@poseidon/shared/ids` but
not `/paths`.

**To honour it:** add the atom in `client-runtime`, the hook in
`apps/web/src/state/hooks.ts`, and read it. If a component is about to hold a
`useState` that another window would also need to be right, it belongs on the
wire.

## 8. The server is the only side that sees the disk

The folder picker, file search, file reads, git status and diffs, checkpoints and
attachment staging are all server RPCs. The renderer receives listings and
contents; it never opens a path. `apps/server/src/fs/Directories.ts` says why in
its own header: every capability beyond "which folder do you want" is a
capability a remote client would also get.

The same file shows the shape the rule takes in practice — absolute paths only,
because a relative one resolves against a working directory the user never chose;
the answer names the symlink-resolved path actually read; an unreadable
subdirectory is absent rather than fatal; and failures are flattened into
messages written for a person, never an errno or a path the client never named.

Bytes are treated the same way. A staged image crosses the wire exactly twice —
up in `attachments.stage`, down per thumbnail in `attachments.read` — and never
enters the event log: `thread.turn.start` carries a reference
(`apps/server/src/attachments/AttachmentStore.ts`). A replayed log must not
re-send every screenshot ever pasted.

And the checks live on the same side as the disk. The composer validates a file
before it uploads megabytes, but that copy is a courtesy: size, media type and
containment are decided again in `attachments.stage`, from the bytes rather than
from anything the client said about them.

The integrated terminal keeps the rule rather than bending it: the shell runs
on the server, the renderer sends it keys and receives text, and the directory
it starts in is the server's to decide from the thread or project that owns it
(`workspaceOf` in `apps/server/src/terminal/TerminalService.ts`) —
`terminal.open` takes no path.

**To honour it:** new filesystem capability goes in `apps/server`, behind an RPC
with a narrow surface, and gets asked "what does this give a remote client?"
before it gets written. Nothing in `apps/web` imports `node:fs`.

## 9. The shell's OS decisions live in one folder, behind pure functions

`apps/desktop/src/platform/` holds the shell's OS decisions: the title-bar style,
the `data-desktop*` attributes `packages/ui` keys its shell styles off, whether
closing the last window quits, the product name and user-model id per channel,
and the loopback CDP port. Each is a pure function of a platform string, unit
tested without Electron — `desktopAttributes(platform)`,
`quitsWhenAllWindowsClosed(platform)`. The preload asks; it does not test
`process.platform` itself.

The same instinct runs through the desktop app generally: `ServerSupervisor.ts`
takes its spawn spec and spawn call as injected dependencies so it is testable
under plain node, and `main/quit.ts` is Electron-free so the shutdown sequence
can be driven in a test.

**To honour it:** when you need `process.platform`, export a named predicate from
`apps/desktop/src/platform/` and call that. The one place outside the desktop app
that reads it is `packages/connector-cmd/src/spawn.ts`, which spawns detached
everywhere but Windows.

## 10. Tests wait on facts, never on time

Every write is a command and every command returns a `CommandReceipt` carrying
the event-log position its effects are visible at, so "did my write happen?" is
exactly answerable. `packages/testkit/src/receipts.ts` records receipts as they
arrive and awaits the one a test cares about by `commandId`; streams are awaited
through `makeStreamCollector`.

This is lint-enforced. In any `*.test.ts`, `setTimeout`, `setInterval` and
`setImmediate` are restricted globals, and `Effect.sleep`, `Clock.sleep` and
`TestClock.sleep` are restricted properties, each with the same message: tests
wait on a Deferred, a Queue or a receipt.

The payoff is that a scenario that never happens ends as a failed `awaitItem`
rather than a slow pass.

**To honour it:** if you cannot see how to await something, the production code
is usually missing the signal — add the receipt, the event, or the stream item,
and await that.

## 11. Tests replay reality

Every directory under `packages/testkit/fixtures/cmd/` is a recording of a real
run of the real CLI: argv, stdout frames in their arrival chunks, stderr, the
transcript as it grew, the checkpoints file, every `PreToolUse` invocation with
both halves of the conversation, and the files the run touched. Nothing in it is
hand-written or reconstructed. When the CLI changes, recordings are re-recorded —
never edited to make a test pass.

Every harness gets the same treatment. Its recordings live under
`packages/testkit/fixtures/<kind>/` in one versioned format
(`packages/testkit/src/recording.ts`): a manifest that says which transport the
harness used, and frames tagged with the direction they travelled. A process
that prints NDJSON, a JSON-RPC peer, an SDK stream and an HTTP server with
server-sent events are recorded and replayed the same way.

The replayer (`packages/testkit/bin/replay-cmd.mjs`,
`packages/testkit/src/replayCmdProcess.ts`) has no behaviour of its own: it
chooses nothing and synthesises nothing. It puts stdout back on the recorded
chunk boundaries, grows the transcript in the recorded place, invokes the
project's installed hook at the recorded points with the recorded payload and
blocks on the answer, and exits with the recorded code. A test that wants a
different outcome names a different recording.

Three tests keep the recordings honest:

- `packages/connector-cmd/src/recordedArgs.test.ts` reads every manifest's
  `connectorArgs` back into a `buildArgs` input, rebuilds it, and demands the
  same list. The two allowed differences are written down in that file.
- `packages/connector-cmd/src/recordedFrames.test.ts` fails if any recorded frame
  reaches `event.unmapped`, and pins the observations the design rests on — the
  plan recordings' `hookCount: 0` and empty `touchedFiles`, so a CLI release that
  starts firing `PreToolUse` in plan mode says so on the next run.
- The live suites run the same scenarios against the operator's actual binary,
  opt-in behind `POSEIDON_LIVE_CMD=1`
  (`apps/server/src/hooks/cmdLiveConformance.test.ts`,
  `apps/server/test/e2e`). They spend a real plan, so they are skipped by
  default, and they refuse to run on any model but the authorised ones.

Claude Code's recordings are kept honest the same way:
`packages/connector-claude/src/recordedFrames.test.ts` fails on any recorded
message left unmapped, the `sdk-stream` replayer exits 97 the moment the
connector sends a line the recorded run was not sent, and
`POSEIDON_LIVE_CLAUDE=1` runs `src/liveConformance.test.ts` and
`apps/server/test/e2e-claude` against the operator's own `claude`, on its
default model only. Codex's are kept honest the same way:
`packages/connector-codex/src/recordedFrames.test.ts`, the `stdio-jsonrpc`
replayer's exit 97, and `POSEIDON_LIVE_CODEX=1` running
`src/liveConformance.test.ts` against the operator's own `codex`.

`apps/server/test/e2e/harness.ts` is where this pays off: it boots the real
server graph from `apps/server/src/boot.ts`, dials it with the real client over a
real WebSocket, and applies the renderer's own folds, so the assertions look at
what a user would see. The replay driver and the live driver differ in exactly
one thing — the binary.

**To honour it:** to test a new CLI behaviour, record it. Recording spends money
and is never run from CI; the scripts, the scrubbing and when to re-record are
in [development.md](development.md#recordings-of-the-real-cli).

## 12. Deny by default, and keep files small enough to read

`scripts/boundary-rules.mjs` holds an explicit allowlist per workspace — the
table is in [architecture.md](architecture.md#boundaries). A workspace with no
rule may import no workspace package at all, and a relative specifier that
climbs out of its own directory is a violation whatever it lands on — packages
are consumed through their `exports` map, so
`../../../packages/testkit/src/receipts` is a boundary crossing wearing a path.

`apps/server` additionally gets `testkit`, `client-runtime` and `connector-cmd`
in test files only, because it is bundled to `out/main.cjs` for packaging and an
import from `src/main.ts` would ship a test framework. `connector-cmd` is also
allowed in exactly one production file, the composition root `boot.ts`.
`apps/desktop` gets `testkit` in test files only, for the same reason.
`apps/web` is deliberately not in that list. The rules are pure functions, and
`pnpm check:boundaries` runs their tests before `scripts/check-boundaries.mjs`
walks the tree.

The walk also refuses barrel files anywhere under `packages/`: a package
exports one entry per module through its `exports` map. Apps keep their route and
entry-point `index` files.

`scripts/check-file-sizes.mjs` caps non-test source at 800 lines anywhere in
`apps/`, `packages/` and `scripts/`, and renderer components under
`apps/web/src/components` at 400. Tests, the two fixture roots and generated
files are exempt, by path and by exact suffix rather than by directory name, so
ordinary source cannot hide behind one.

Lint adds the rest: no `@ts-ignore`, `@ts-expect-error` only with a reason and a
URL, no `as any` outside tests and generated files, no raw colours and no inline
styles anywhere, and no arbitrary values, no dynamic class names and no
restyling of design-system components outside `packages/ui/src/components`.

**To honour it:** adding a workspace means adding its rule first. Widening a rule
is a decision; make it explicitly, in the same commit as the import that needs
it. When a file reaches the cap, split it along a seam that already exists rather
than moving code somewhere exempt.

## 13. One command is the gate

```
pnpm check
  oxlint
  oxfmt --check          (sources and markdown docs)
  tsc                    (every workspace)
  vitest                 (every workspace)
  scripts/check-boundaries.mjs
  scripts/check-file-sizes.mjs
  knip                   (dead exports and dependencies)
```

Nothing is exempt because it is inconvenient, and the escape hatches knip allows
are narrow and named: a `@public` JSDoc tag on an export that is deliberate API
with no consumer yet, or a per-file entry in `knip.json`. When you start
importing a dependency that was pre-declared there, delete its line in the same
commit.

`pnpm build` is the other half: the server bundle, the web assets, and the macOS
app through electron-builder.

**To honour it:** run `pnpm check` before you ask anyone to look at the change,
and never route around a failing step. What each stage does, and how to run one
on its own, is in [development.md](development.md#the-gate).

---

## Where each rule is enforced

| Principle                         | Enforced by                                                                                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts are the seam            | `packages/contracts/test/fixtures.test.ts`                                                                                                                                                     |
| Connector promises                | `packages/connector-sdk/src/conformance.ts`                                                                                                                                                    |
| Renderer neutrality               | `scripts/check-boundaries.mjs` (string and filename grep over `apps/web/src`)                                                                                                                  |
| No harness named above the SDK    | `scripts/check-boundaries.mjs` (connector imports and kind literals)                                                                                                                           |
| Reference products never named    | `scripts/check-boundaries.mjs` (encoded names over the whole tree)                                                                                                                             |
| Package boundaries, no barrels    | `scripts/check-boundaries.mjs`                                                                                                                                                                 |
| File sizes                        | `scripts/check-file-sizes.mjs`                                                                                                                                                                 |
| Migration lineage                 | `apps/server/src/persistence/migrations.test.ts`                                                                                                                                               |
| Permission ladder                 | `apps/server/src/permissions/permissions.test.ts`, `permissionService.test.ts`                                                                                                                 |
| No timers in tests                | `.oxlintrc.json` (`no-restricted-globals`, `no-restricted-properties`)                                                                                                                         |
| Recordings describe the CLI       | `recordedArgs.test.ts`, each connector's `recordedFrames.test.ts`, the replayer's divergence exit (97), the `POSEIDON_LIVE_CMD=1`, `POSEIDON_LIVE_CLAUDE=1` and `POSEIDON_LIVE_CODEX=1` suites |
| The whole product still assembles | `apps/server/test/e2e`                                                                                                                                                                         |
