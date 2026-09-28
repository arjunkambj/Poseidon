# How it works

Poseidon is an Electron desktop app that drives the Command Code CLI — an
agentic coding harness that normally runs in a terminal — from a graphical
interface. This document traces what actually happens at runtime, in order,
with the real names of the processes, commands, events, RPC methods and files
involved, and a path into the source for each step.
[architecture.md](architecture.md) describes the pieces themselves,
[philosophy.md](philosophy.md) the rules they keep,
[development.md](development.md) how to run them, and
[command-code-connector.md](command-code-connector.md) and
[claude-code-connector.md](claude-code-connector.md) what the CLI on the far
end does.

Three processes matter.

```
┌─────────────────────────────┐
│ Electron main               │  apps/desktop/src/main
│  ServerSupervisor ──────────┼──spawn──┐
│  window + preload bridge    │         │
└──────────┬──────────────────┘         │
           │ IPC                        ▼
┌──────────┴──────────────────┐  ┌──────────────────────────────┐
│ Renderer (React)            │  │ Server (Effect, node)        │
│  apps/web                   │◄─┤  apps/server                 │
│  atoms, timeline, composer  │ws│  event store, decider,       │
└─────────────────────────────┘  │  reactors, permissions,      │
                                 │  hook bridge, MCP gateway    │
                                 └──────────┬───────────────────┘
                                            │ spawn, one per turn
                                            ▼
                                 ┌──────────────────────────────┐
                                 │ cmd (the user's own install) │
                                 │  print mode, NDJSON on stdout│
                                 └──────────────────────────────┘
```

The server starts two other kinds of child besides `cmd`: `agent-browser` for
the browser pane (§10), and a login shell per open terminal (§11).

The renderer never touches the filesystem, git or a child process: everything
it knows arrives over one authenticated WebSocket. The server is the single
writer of durable state, and it is event-sourced — a client dispatches a
`Command` and reads the events that come back. The connector is the only part
that knows what a Command Code CLI is; everything above it is written against
the connector-neutral `RuntimeEvent` vocabulary in
`packages/contracts/src/runtime.ts`.

---

## 1. Boot

### The supervisor spawns the server

`apps/desktop/src/main/index.ts` takes the single-instance lock, registers the
app's own `poseidon://` scheme as privileged, and constructs a `ServerSupervisor`
(`apps/desktop/src/backend/ServerSupervisor.ts`) before the first window
opens. Once Electron is ready it starts the browser bridge — the loopback CDP
endpoint for the pane's webviews ([§10](#10-the-browser-pane)) — unless
`POSEIDON_REMOTE_DEBUG=0`, and only then spawns the server, so the server's
environment can name it.

What is spawned comes from `apps/desktop/src/backend/serverArgs.ts`:

| build    | command            | argv                                            |
| -------- | ------------------ | ----------------------------------------------- |
| packaged | `process.execPath` | `out/server/main.cjs` (asar-unpacked)           |
| from src | `process.execPath` | `--import <tsx loader> apps/server/src/main.ts` |

Both run under `ELECTRON_RUN_AS_NODE=1`. The dev form uses `--import` rather
than the `tsx` CLI deliberately: the CLI re-execs node as its own child, and
the grandchild does not inherit the supervisor's fd 3, so the handshake never
arrives (`serverArgs.ts` documents the failure in full).
`apps/desktop/src/backend/serverEnv.ts` builds the environment: the shell's own,
plus `POSEIDON_DEV`, `POSEIDON_SERVER_BROWSER_BRIDGE` (the bridge's `ws://`
origin, or `disabled`) and `POSEIDON_SERVER_BROWSER_BRIDGE_KEY` (the launch key
the server mints thread URLs from). An inherited bridge variable is dropped.
The `POSEIDON_SERVER_` prefix keeps both out of the harness, whose spawn drops
exactly that prefix, and the server deletes both from its own environment as
soon as it has read them.

The child is spawned with `stdio: ["ignore", "inherit", "inherit", "pipe"]`.
Stdout and stderr are the server's log; **fd 3 carries the handshake**.

### The server assembles itself

`apps/server/src/main.ts` is argument parsing and a runtime call; the graph is
`apps/server/src/boot.ts`, which builds, in one `Layer.build`:

- SQLite (`persistence/Sqlite.ts`) and the migrations
  (`persistence/Migrations.ts`), so every table exists before the first read;
- the event store and read models (`persistence/EventStore.ts`,
  `persistence/ReadModels.ts`);
- the orchestration engine (`orchestration/Engine.ts`), the session manager
  and the reactors (`ProviderCommandReactor`, `CheckpointReactor`,
  `AttachmentReactor`, `makeSessionSupervisor`);
- the connector registry, seeded with the Command Code and Claude Code
  definitions in that order (`packages/connector-cmd/src/definition.ts`,
  `packages/connector-claude/src/definition.ts`), and the `ConnectorManager`
  that reconciles it against the settings document;
- permissions, git/files, attachments, the browser service and the MCP
  gateway;
- the HTTP server on `127.0.0.1` with port `0` (the OS picks), and the
  WebSocket route.

`boot` sets `POSEIDON_HOME` for the whole process before anything resolves a
path, which is why every directory in this document hangs off `~/.poseidon` by
default (`packages/shared/src/paths.ts`).

Two things happen after the graph is built and before the handshake:
`connectorHost.install(...)` fills in the endpoints only a running server can
supply (the per-thread MCP endpoint, the hook endpoint and handler registry,
and the permission ladder), and `ConnectorManager.ready` is awaited so no
client is admitted while connector routing would still answer `NoConnector`.
Probes keep running behind the handshake.

### The handshake

`apps/server/src/rpc/bootstrap.ts` writes one JSON line:

```json
{ "url": "ws://127.0.0.1:52431/ws", "token": "<uuidv7>", "serverInstanceId": "<uuidv7>" }
```

to fd 3 when one exists, and to stdout otherwise (a process with an IPC channel
— a test runner's worker — is never a desktop spawn, so it takes the stdout
path). In dev it also writes `~/.poseidon/dev/connection.json`, created `0700`
and written `0600`, then `chmod`ed again because `writeFileSync` does not lower
an existing file's mode. That file holds a bearer for a socket that accepts
`orchestration.dispatch`, so its permissions are not cosmetic.

The token and the `serverInstanceId` are minted fresh on every boot.

### Backoff and restart

The supervisor's state is `starting | ready | restarting | failed`. The
constants in `ServerSupervisor.ts`:

| constant                   | value  | what it bounds                              |
| -------------------------- | ------ | ------------------------------------------- |
| `INITIAL_BACKOFF_MS`       | 500    | first restart delay, doubling               |
| `MAX_BACKOFF_MS`           | 10 000 | the ceiling                                 |
| `MAX_CONSECUTIVE_FAILURES` | 5      | then `failed`, and the crash dialog         |
| `HANDSHAKE_TIMEOUT_MS`     | 15 000 | a child that never writes fd 3 is SIGKILLed |
| `KILL_GRACE_MS`            | 5 000  | SIGINT, then SIGKILL                        |
| `MAX_HANDSHAKE_BYTES`      | 65 536 | bytes without a newline before giving up    |

A malformed handshake takes the same failure path as a crash: the child is
killed and the backoff schedules another attempt. A successful handshake resets
the failure count and the backoff. After five consecutive failures the
supervisor stops and `showServerCrashDialog` reports the reason rather than
spinning.

Every transition is pushed to the renderer through the preload bridge
(`apps/desktop/src/main/serverStateBridge.ts`,
`apps/desktop/src/preload/bridge.ts`), which is how a renderer reconnects to a
restarted server without reloading the window.

### The dev loop

`pnpm dev` runs `apps/desktop/scripts/dev.mjs` alongside Vite. The script
esbuild-watches the main/preload bundles and restarts Electron on a successful
rebuild; Electron restarts the supervised server. The renderer is served by
Vite on port 3001, and `apps/web/vite.config.ts` mounts one extra middleware,
`GET /__poseidon/connection`, which serves the dev connection file. That route
refuses a cross-origin read — the body is a bearer token — and 404s when no dev
server is running.

---

## 2. Connect

### Finding the server

`packages/client-runtime/src/resolver.ts` asks each channel in order:

1. `window.poseidon.getServerState()` — the supervisor's live view, including a
   restarted server's new port, token and boot id;
2. `window.poseidon.getConnection()` — the older preload getter;
3. `GET /__poseidon/connection` — the dev Vite plugin;
4. `?server=<url>&token=<t>` search params.

`null` from all of them means "no channel configured", and the UI shows its
connect screen.

### The socket supervisor

`packages/client-runtime/src/connection.ts` builds the `Connection` service
every atom shares. Effect's socket protocol is single-use, so reconnecting
means rebuilding the socket, the protocol and the `RpcClient` underneath
callers; `Connection.client` is a per-call accessor that resolves to whichever
client is currently live and waits through a reconnect.

Credentials are re-read on **every** attempt, not captured once, because a
restarted server binds a different port and mints a different token. An attempt
with nothing to dial fails with `no-credentials` and is retried on the same
backoff as a refused socket — which is the state the desktop renderer boots in
while the supervisor is still starting the server.

The token travels on the upgrade query (`ws://host/ws?token=…`) because the
browser WebSocket API cannot set headers. `apps/server/src/rpc/server.ts`
compares it with `timingSafeEqual` and answers `401` before the RPC protocol
ever runs.

Backoff is 100 ms doubling to a 2 s ceiling. An attempt is only an epoch once
the protocol's own `onConnect` hook has fired: building the protocol does not
dial, and an attempt that "succeeded" against a dead port used to report
`connected` over a socket that could not carry a request.

Status is one of `connecting | connected | reconnecting | disconnected |
incompatible`. `incompatible` is absorbing — see below.

### Hello, subscribe, resume

Every subscription in `packages/client-runtime/src/atoms.ts` is a
`hello → subscribe` loop:

```
client["server.hello"]({})
  → { protocolVersion, serverInstanceId }
  │
  ├─ protocolVersion ≠ PROTOCOL_VERSION (3) → markIncompatible, Stream.never
  │
  ├─ serverInstanceId changed → drop the cached snapshot, afterSequence = undefined
  └─ otherwise                → afterSequence = doc.snapshotSequence
  │
  └─ client["threads.subscribe"]({ threadId, afterSequence })
       snapshot | event… → "synchronized" → live events
```

`retainedInstanceId` in `connection.ts` is the rule that keeps a plain socket
drop from looking like a server restart: the boot id is cleared only when a
channel reports a _different_ one. A status change does not touch it.

The server side is `OrchestrationEngine.subscribeThread`
(`apps/server/src/orchestration/Engine.ts`): it subscribes to the events PubSub
_before_ reading the baseline so nothing commits in the gap, emits either a
snapshot or the replay after `afterSequence`, then `{ kind: "synchronized" }`,
then live events through a `LiveBuffer`. The buffer coalesces on
`STREAM_COALESCE_MS` (50 ms) and enforces the budgets in
`packages/contracts/src/rpc.ts`:

| budget                | value |
| --------------------- | ----- |
| `STREAM_BUDGET_ITEMS` | 1000  |
| `STREAM_BUDGET_BYTES` | 8 MiB |

A subscription that exceeds either ends with `{ kind: "resnapshot-required" }`
rather than growing a backlog. The client drops its cached document and
resubscribes from scratch — `Stream.retry` covers a failed attempt,
`Stream.repeat` covers the clean end the server sends after a resnapshot.

Read models with no subscription (`projects.list`, `connectors.list`,
`keybindings.get`) are refetched once per connected epoch through
`perConnection`, because the socket carries no invalidation.

---

## 3. First run

A fresh install has no projects, so `/` shows "No projects yet" and the same
Add project dialog the sidebar opens
(`apps/web/src/components/sidebar/add-project-dialog.tsx`). Connectors are
checked in Settings → Connectors.

### The probe

`ConnectorManager` (`apps/server/src/settings/ConnectorManager.ts`) seeds one
enabled instance per registered definition on a fresh install, in the
registry's order, then probes each. Command Code is registered first, so a
thread that names no instance still routes to it. For Command Code,
`packages/connector-cmd/src/probe.ts` does the work:

1. resolve the binary (`packages/connector-cmd/src/binary.ts`): the configured
   `binaryPath`, then `cmd` on `PATH` plus the global bin directories a GUI
   process never inherits (`/usr/local/bin`, `/opt/homebrew/bin`, `~/.bun/bin`,
   `~/.local/share/pnpm`, `~/.npm-global/bin`), then `npx -y
command-code@latest`. Nothing resolvable at all reports `not-installed`.
2. run `status --json` (30 s timeout);
3. run `--list-models` (60 s timeout) and parse the two-column table into
   `ModelOption`s, with the section headers as `family`.

Both probe calls deliberately omit `--no-auto-update`: a probe is the one safe
moment to let the CLI upgrade itself. Turn spawns keep it, because swapping the
binary under a running conversation is not safe.

The probe's children get the same environment allowlist a turn's do, so an
operator's `COMMAND_CODE_API_KEY` set through `extraEnv` is not reported as
"not authenticated" while turns work fine.

Every probe that found a binary reports `installed: true`; a signed-out one
also carries `loginCommand`, which is what the renderer shows the user to run.
It is spelled against the binary the probe resolved — `/opt/homebrew/bin/cmd
login` for a found `cmd`, `npx -y command-code@latest login` for the npx
fallback — so a machine without a `cmd` on PATH is never told to run one. The
wire probe adds `authenticated`, derived from `auth`.

Exit codes decide the status (`packages/connector-cmd/src/exitCodes.ts`):

| exit   | probe status             | what the user is told                                        |
| ------ | ------------------------ | ------------------------------------------------------------ |
| 0      | `ready`                  | binary path, version, account, model count                   |
| 3      | `not-authenticated`      | not logged in — run the `loginCommand`                       |
| 10     | `error`, `auth: present` | insufficient credits, with `helpUrl` to the billing page     |
| 1, 4–9 | `error`                  | the sentence from `EXIT_MESSAGES`, plus the harness's detail |

The billing link (`CMD_ACCOUNT_HELP_URL`) and the docs link
(`metadata.docsUrl`, `https://commandcode.ai/docs`) live in
`packages/connector-cmd`, so no connector's domain name is written into the
renderer: it receives the first as `ConnectorProbe.helpUrl` and the second over
`connectors.describe`. `apps/web/src/components/Settings/probe-help.ts` decides
which failures get a link at all — the probe's own `helpUrl`, or else the
connector's docs link for an account-shaped failure.

The Claude Code probe (`packages/connector-claude/src/probe.ts`) resolves
`claude` the same way — the configured `binaryPath`, then `PATH`, then the
directories its installers use (`/opt/homebrew/bin`, `/usr/local/bin`,
`~/.local/bin`, `~/.claude/local`, and the npm, pnpm and bun global bins) —
with no runner to fall back on, and asks three questions under the
environment a session gets:

1. `claude --version`, which prints `2.1.280 (Claude Code)`. Below
   `OLDEST_TESTED_VERSION`, the release the recordings were made at, the probe
   warns; it never refuses a version.
2. `claude auth status --json`: `loggedIn` true is `auth: present`, false is
   `absent` and the status `not-authenticated`. The CLI exits 1 when signed out
   and still prints the document, so the output is read whatever the exit
   code. `loginCommand` is `claude auth login` spelled against the resolved
   binary, prefixed with `CLAUDE_CONFIG_DIR=…` when the instance has an account
   directory of its own.
3. The model list, which only the SDK handshake carries: a `query()` whose
   prompt never yields starts the CLI, reads the initialize response's
   `models` — the CLI's own rows, `default` first, each with its effort levels
   — and stops the CLI's process group again. No message is sent, so nothing
   reaches the API. An instance keeps its list, so the model picker does not
   start a CLI each time it opens.

`fixtures/claude/probe/` is that probe recorded, signed out.

`apps/web/src/lib/connector-health.ts` reads a `ConnectorSummary` into one of
five states — `ready`, `probing`, `not-installed`, `signed-out`, `error` — plus
the command that fixes it and a sentence built from the instance's display
name. Signed-out is decided before ready: a harness that answers `ready` with
`auth: "absent"` (or `authenticated: false`) is installed and reachable but
cannot run a turn. The command is the probe's `installCommand` for
not-installed and its `loginCommand` for signed-out, and null when the
connector named none; the renderer never spells a command of its own.

Two surfaces show it. Each Settings → Connectors card has a status badge beside
the instance's name and a line under it with the binary, version, account,
model count, the probe's message and the fixing command in a copyable code span
(`apps/web/src/components/Settings/connector-status.tsx`). Above the composer —
on an open thread and on the start screen — `harness-health-banner.tsx` shows an
alert when the thread's instance (`threadConnectorInstanceId`: the bound one,
else the chosen one, else the routing fallback) is neither ready nor still
probing: "Command Code is not signed in", then "Run `<loginCommand>` in a
terminal, then check again", with a Check again button that re-probes every
connector.
The banner is rendered by `thread-view.tsx` and `start-thread.tsx`, outside the
composer itself.

A version below `OLDEST_TESTED_VERSION` (1.54.0) produces a warning and nothing
else. Nothing is pinned: the connector runs whatever `cmd` the user has.

### Choosing a folder

The desktop has a native dialog (`window.poseidon.pickDirectory`). Everywhere
else — a browser tab, and later a client that is not on this machine — gets
`apps/web/src/components/folder-picker/`, which browses the **server's** disk
through `fs.browse`.

`apps/server/src/fs/Directories.ts` lists one directory's subfolders, sorted,
hidden entries left out unless they were asked for, each flagged when it holds a
`.git`. The rules: absolute paths only (a relative one would resolve against the
server's working directory), the answer names the symlink-resolved path it
actually read — so a breadcrumb is a path `fs.browse` accepts back — a symlinked
entry is listed but never badged as a git repository, because deciding that
means reading inside the link target, an unreadable entry is skipped rather than
failing the listing, and the list truncates at `FS_BROWSE_ENTRY_LIMIT` (500)
with a `truncated` flag. Failures come back as
`FsBrowseError` with one of `not-absolute | not-found | not-a-directory |
permission-denied | internal` — five named reasons, because the picker offers a
different next step for each.

The picker's logic is values in
`apps/web/src/components/folder-picker/picker-state.ts`: the browsed path and
the typed text are separate, and paths come back from the server rather than
being computed client-side.

### Creating the project

`project.create` carries `{ projectId, name, workspaceRoot }` — the id is
minted by the caller, which is what makes a retry idempotent. The decider
(`apps/server/src/orchestration/decider.ts`) rejects a duplicate id and a
workspace root another project already owns. The Add project dialog keeps a
rejected path in the field so it can be corrected.

---

## 4. A turn, end to end

### The composer

`apps/web/src/components/composer/` owns the draft. What Enter means is a pure
function in `composer-keys.ts`:

- an IME mid-composition → **insert**: the Enter commits the composition, even
  while a menu has rows;
- a `/`, `#`, `@` or `$` menu that has rows → **pick** the highlighted one;
- Mod, Ctrl or Alt held, on a chord the live keymap answers here
  (`useKeymapAnswers`) → **keymap**, leaving it to the keybinding listener;
- Shift held → **insert** a newline;
- otherwise → **send**, with `queued: true` when Mod or Ctrl is held.

What a send then does is `sendMode` in `send-mode.ts`:

| The thread                               | Enter or the send button                     | `Mod+Enter`                                                   |
| ---------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| idle                                     | `thread.turn.start` — a new turn             | `thread.turn.start { queued: true }`, which starts a turn too |
| a turn running, the harness cannot steer | `thread.turn.start { queued: true }` — queue | the same                                                      |
| a turn running, the harness steers       | `thread.turn.steer` — into the running turn  | `thread.turn.start { queued: true }` — queue                  |

`Mod+Enter` is the `composer.queue` binding, and it always queues, so a
follow-up meant for after the turn still waits for it on a harness that steers.
Whether the harness steers is the `steering` capability of the instance the
thread runs on (`instanceCapabilities`, the same read the attach button uses).

Plain Enter and Shift+Enter are fixed. An Enter chord the keymap answers
belongs to it, so `composer.queue` (`Mod+Enter` by default) is an ordinary
table row and rebinding it changes the key in the composer too. A chord it
does not answer keeps the composer's own meaning, so Ctrl+Enter on macOS and
Alt+Enter still send. With the focus in the composer's textarea
`composer.queue` sends with `queued: true`; anywhere else it puts the focus
back in the composer. Picked from the palette it sends whatever is typed
and then focuses the composer: the registry tells a handler whether its
command came from a `chord` or a `pick` (a palette row or a button), because
a pick fires while the palette still holds the focus. On the start screen it
sends, since a thread that does not exist yet has nothing to queue behind.

The composer and the start screen answer the same keys
(`use-composer-commands.ts`): `Mod+L` focuses the textarea, `Mod+U` opens the
file chooser the attach button opens (or, when the connector refuses
attachments, shows the button's sentence and opens nothing), and
`Mod+Shift+Backspace` in the composer clears the text, the mentions and the
attachments, as `/clear-draft` does. The settings row under the input
(`thread-settings-keys.tsx`) answers the rest through the same `onChange` a
click uses:

| key                           | does                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `Shift+Tab` (in the composer) | toggle plan mode (§6)                                                                   |
| `Mod+Shift+L`                 | next runtime mode the connector offers, in contract order, wrapping (`nextRuntimeMode`) |
| `Mod+Shift+M` / `Mod+Shift+E` | open the model / effort picker                                                          |
| `Mod+Shift+.` / `Mod+Shift+,` | one rung up / down the model's effort ladder, stopping at either end (`stepEffort`)     |

A picker the connector locks until restart does not open, and a locked effort
does not step. The plan button's tooltip and the attach button's show their
current keys.
`use-send-draft.ts` uploads any attachments first (a browser `File` has no
filesystem path, so the server must hold the bytes before the command can name
them) and latches so one Enter cannot start two real turns. While a turn is in
flight a Stop button appears and the send button becomes Queue — or, when the
harness steers, "Steer turn", whose tooltip names both keys, with "Steering the
running turn" in muted text beside the context gauge. All of it reads
`turnInFlight` (`apps/web/src/lib/turn.ts`) rather than `currentTurnId`, which
the projection only fills one event later.

The context gauge (`context-meter.tsx`) is a ring and a percentage; clicking it
opens the used, window and remaining tokens over a progress bar. When the
thread's bound session declared `capabilities.compaction` — Claude does,
Command Code does not; before a session binds, nothing has said so — the
popover also offers "Compact now" (`compact-now.ts`). It dispatches
`thread.turn.start` with the text `/compact` and no attachments or mentions,
exactly what a typed `/compact` sends, so the harness runs its own command and
the timeline shows the compaction row. `use-compact-now.ts` dispatches it
directly rather than through `use-send-draft.ts`, leaving the draft alone.
While a turn runs the button is disabled, with the reason beneath it. The `/`
menu's `/compact` is the same dispatch (below).

Four characters open a menu, each only at the start of the text or after
whitespace (`detectComposerTrigger` in
`packages/client-runtime/src/composerTrigger.ts`), and each closes at the next
whitespace:

| Trigger | Lists                                                | A pick writes                       | The turn carries it as |
| ------- | ---------------------------------------------------- | ----------------------------------- | ---------------------- |
| `/`     | commands, then the instance's skills                 | the command, or `/name ` as text    | text                   |
| `#`     | the project's files                                  | `#path ` and a chip                 | `mentions`             |
| `@`     | the instance's plugins, then its skills, never files | `@plugin ` or `$skill `, and a chip | `references`           |
| `$`     | the instance's skills alone                          | `$skill ` and a chip                | `references`           |

The start screen's composer (`start-thread.tsx`) opens the same `#`, `@` and
`$` menus through the same hook (`use-mention-menus.tsx`), asking the instance
the new thread will run on, and its first message carries their mentions and
references. `/` is plain text there: its commands change a thread's settings,
and that thread does not exist yet.

The `/` popover offers `/model`, `/effort`, `/mode`, `/plan`, `/default`,
`/compact`, `/clear-draft` and the skills the thread's connector instance loads
for the project. A skill picked here is plain text, with no chip and no
reference. `/compact` is listed only when the thread's bound session declared
`capabilities.compaction` — the same test as "Compact now", so never on
Command Code or on a thread no session has bound yet. Picking it removes the
`/compact` query from the textarea, keeps the rest of the draft and its
attachments, and starts a turn whose text is `/compact` through
`use-compact-now.ts`, exactly as a typed `/compact` would reach the harness.
While a turn runs it starts nothing and the notice under the input says why.
`/clear` is deliberately not offered:
in Command Code it drops the session's context, no command in the union does
that, and binding it to emptying the textarea would throw away the sentence the
user was writing while keeping every token they meant to drop.

`#` searches the thread's files — its worktree, or the project's folder; on
the start screen, before there is a thread, the project's folder — through
`files.search` (`use-file-mentions.ts`), and says "No files match" when nothing
does, "Searching…" while the first search runs and "Could not search files"
when it fails. Each keystroke is a new search; until it answers, the menu keeps
the rows the last one gave rather than emptying (`heldMenuSource` in
`menu-source.ts`). The turn carries the bare workspace-relative paths as
`mentions`, and the connector decides how to name them to its harness. Because
`#` is also markdown and issue numbers, it needs a query that starts with
neither another `#` nor a digit. So a lone `#` then Enter sends, `# Heading`
closes at the space, and `##` headings, `fixes #12`, `a#b` and
`https://x.dev/#frag` never open it. The digit rule matters because
`files.search` is a substring match: `#12` would list every path with a 12 in
it, and Enter would pick one instead of sending.

`@` lists the thread instance's enabled plugins under "Plugins", then its
enabled skills under "Skills" (`pluginsAtom` and `skillsAtom`, wired in
`use-reference-mentions.ts`; the rows come from `reference-menu.ts`). `$` lists
the skills alone, ungrouped. An instance without the plugins extension answers
no plugins, so `@` then shows its skills. A menu with no rows says why
(`referenceMenuEmptyLabel`): "No plugins or skills" (`$`: "No skills") only
when the harness answered with none, "No plugins or skills match" when the
query filtered them all out, "Loading plugins and skills…" while a list is
still being asked, and "Could not list plugins" (or skills) when one failed.
The atoms start from `[]`, so `menu-source.ts` reads their in-flight `waiting`
flag rather than trusting an empty success, and treats an `unavailable` answer
(no such extension) as none. Both open on an empty query, like
`/`, so `me@x.com` and `a$b` stay closed but a bare `@` lists everything. `$`
also stays closed when its query starts with a digit, so `$5` and `costs $20`
never open. `$HOME` does open, but both menus match the query against names
alone, never descriptions, so it lists nothing unless a skill's name holds
`home`, and Enter still sends.

Every chip stands for exactly one token in the text: `#path` for a file,
`@name` for a plugin and `$name` for a skill, even a skill picked from `@`, so
a plugin and a skill of the same name never share a token. Removing a chip
removes its token and one space beside it (`removeComposerToken`); editing a
token away, even by one character, drops its chip, because after every change
the draft keeps only the chips whose whole token is still in the text
(`retainComposerReferences`). A whole token starts the text or follows
whitespace, and ends the text, meets whitespace, or meets closing punctuation
(`.,;:!?)]}'"`) that is followed by one of those, so `Greet me with $greeting.`
keeps its chip while `#src/a.ts` does not hold a chip for `#src/a`. The draft (`ComposerDraft` in
`apps/web/src/state/ui.ts`) holds the text, the mention paths and the
references side by side, and a send or `/clear-draft` empties all three.

The turn carries the picks from `@` and `$` as typed `references`
(`TurnReference`: `{ kind: "skill" | "plugin", name }`), sent on
`thread.turn.start` only when there are some, and kept on the queued message,
the turn request and the `user_message` row. The sent message's bubble
(`UserMessageRow` in `timeline/user-message-row.tsx`) draws the same chips above
its text; a row without any renders as text alone.
Neither the renderer nor the server writes a reference into the prompt: the
connector does, in the words its harness understands ([The spawn](#the-spawn)).

The model picker, on the start screen and in the thread header, has one
section per enabled connector instance (`modelCatalogAtom`), headed by the
instance's name and its connector's generic icon, in the connectors page's
order. Picking a model picks its instance too: the start screen sends both on
`thread.create`, the header on `thread.settings.update`. Until the user picks,
a new thread shows the saved default model under the first instance that lists
it, else the first enabled instance's first model. Once the thread has run
anything (`threadLocksConnector`), the other instances' sections stay listed but
disabled, with a tooltip saying to start a new thread, and a pick in the
thread's own section sends the model alone. The instance a thread runs on, or
would, is `threadConnectorInstanceId` (`apps/web/src/lib/connector-routing.ts`):
the bound session's, else the thread's chosen one while it is enabled, else the
first enabled one.

`/effort` and `/mode` offer what the header pickers offer. Efforts are the
current model's `efforts`, or the whole ladder when it states none, always
lowest first in the contract's `EFFORT_ORDER` (`apps/web/src/lib/efforts.ts`).
Runtime modes are the connector's `capabilities.runtimeModes`, named from one
label table (`apps/web/src/lib/runtime-modes.ts`). Both read the capabilities of
the instance the thread runs on, or would run on before its first turn. When
that instance reports `images: false`, the attach button is disabled with the
reason as its tooltip and a paste or drop is refused with the same sentence.

### Command to events

```
composer
  │ orchestration.dispatch { thread.turn.start }
  ▼
OrchestrationEngine.dispatch            apps/server/src/orchestration/Engine.ts
  │ commandId already receipted? → return the stored receipt
  │ one write mutex, one SQLite transaction:
  │   load stream → foldThread → decide(command, state, ctx, env)
  ▼
decider                                 apps/server/src/orchestration/decider.ts
  │ accepted → [ thread.turn.requested, thread.item.upserted(user_message) ]
  ▼
append → project → watermark → commit → publish
  │
  ├─→ subscribers (threads.subscribe)
  └─→ ProviderCommandReactor
```

The decider is pure: command plus folded stream state in, events out, no clock
and no id minting of its own. A rejection is a result, not an exception — the
command receipts as `rejected` and nothing is appended. `CommandReceipt`
carries `lastSequence`, so a client can wait for its own write to appear on the
subscription.

The `user_message` row is minted here and nowhere else: connectors deliberately
emit nothing for the user's own text, so without this the timeline would show
answers and never questions.

### Binding a session

`ProviderCommandReactor` (`apps/server/src/orchestration/ProviderCommandReactor.ts`)
reacts to `thread.turn.requested` by calling `SessionManager.ensure(doc,
workspaceRoot)` and then `handle.send(turnId, turn)`. `workspaceRoot` is the
thread's own root: its worktree when it was created in one, the project's
folder otherwise (`orchestration/workspaceRoot.ts`).

`SessionManager` (`orchestration/SessionManager.ts`) keeps one driver per
thread. A thread with no `session` in its document is routed by
`ConnectorSelection.fromRegistry`: to the instance the thread chose
(`settings.connectorInstanceId`, picked on the start screen) when that instance
is open, and otherwise — no choice, or the chosen one was disabled or removed
since — to the first _open_ instance in the settings document's own order. A
thread that already has a session is looked up by the session's persisted
`connectorInstanceId`, never by kind — two instances of the same kind can differ
in binary, credentials and model. Once a thread has a session, a running turn or
a message of the user's, the decider refuses to change its connector: the answer
is a new thread. `startSession` or
`resumeSession` produces a raw `SessionHandle`; `makeTurnScopedHandle` wraps it
so runtime events carry our `turnId`, and `ingestSession` forks the fiber that
drains its events into the log.

### The spawn

`packages/connector-cmd/src/session.ts` is one session for one thread; print
mode is one **process per turn**. `turnArgs.ts` builds the prompt and the argv,
`spawn.ts` performs the spawn.

The argv, in the order `buildArgs` emits it:

```
cmd -p "<prompt>" --output-format json --verbose -t --skip-onboarding --no-auto-update
    [--session <sessionId>]
    [--model <id>] [--effort <low|medium|high|xhigh|max>]
    [--permission-mode plan] [--yolo]
    [--add-dir <dir>]… --tools-enable ask_user_question
```

Two flags are decided per turn:

- **`--yolo` on every ordinary turn.** Without it print mode refuses writes and
  shell calls whatever a hook answered. With it the PreToolUse hook still fires
  and a deny still stops the call — recorded under the connector's own argv in
  `packages/testkit/fixtures/cmd/shell-deny-yolo/`.
- **`--permission-mode plan`, and no `--yolo`, on a plan turn.** See §6.

`--tools-enable ask_user_question` is on every turn: a headless run withholds
that tool, and without the flag the model asks its question as prose no card
ever renders.

The prompt is the user's text, then `@mention` lines, then one
`Use the "<name>" skill.` line per skill reference, then one
`Attachment (<mime>): <absolute path>` line per staged file. A plugin reference
is left out, with a `session.warning` saying so, because Command Code has no
plugins. The skill line is the one `fixtures/cmd/skill/` was recorded with; see
[command-code-connector.md](command-code-connector.md#the-prompt).

The environment is built by `envAllowlist` in three passes: the inherited
variables an allowlist names, then the operator's `extraEnv` from the connectors
page, then the session's own `POSEIDON_*` control plane — the hook URL, the
ticket file, the thread id and the MCP token — applied last so nothing can
override it. The exact name lists, and why `POSEIDON_HOOK_*` is reserved against
`extraEnv`, are in
[command-code-connector.md](command-code-connector.md#environment).

The process is spawned `detached`, so it leads its own process group and a
signal can reach the harness's own children.

### Frames to rows

Three sources describe the same work, and
`packages/connector-cmd/src/translate.ts` makes the overlap idempotent:

| source                 | what it is                                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NDJSON on stdout       | the live stream: `run_start`, `turn_start`, `message_start`, `model_request_start/end`, `text_delta`, `thinking_*`, `tool_queued/running/update/completed`, `tool_hooks`, `tool_hook_blocked`, `subagent_*`, `message_update/end`, `turn_end`, `run_end` |
| the session transcript | `~/.commandcode/projects/<slug>/<sessionId>.jsonl`, appended once per completed message, the last flush landing _with_ `run_end`                                                                                                                         |
| PreToolUse hook posts  | one per gated tool call                                                                                                                                                                                                                                  |

Facts that shape the mapping, all from the recordings under
`packages/testkit/fixtures/cmd/`:

- **A turn is a process, not an agent step.** `turn_start`/`turn_end` count
  model round trips — three of them inside one `shell-allow` turn. One user
  turn is `run_start` to `run_end`.
- **The tool input lives on `tool_queued`.** `tool_running` carries no input
  and a null description.
- **The transcript is history, not a live source.** It does not exist at
  `run_start` and is one model round trip behind the frames. It is what carries
  `usage.costUsd`, what survives a restart, and what a resumed session reads.

Tool calls dedupe on `toolCallId`, messages on `meta.messageId`, so the frames,
the transcript and the `run_end` reconcile all land on the same timeline row.
Item ids are minted (`packages/connector-cmd/src/items.ts`) because the
harness's ids are not UUIDv7 and the wire schema insists on it. Tool names map
to `ItemKind` there too:

| tool                                          | row kind            |
| --------------------------------------------- | ------------------- |
| `shell_command`                               | `command_execution` |
| `edit_file`, `write_file`                     | `file_change`       |
| `read_file`, `read_directory`, `glob`, `grep` | `tool_call`         |
| `todo_write`                                  | `todo`              |
| `agent`                                       | `task`              |
| `activate_skill`                              | `skill`             |
| `web_search`, `web_fetch`                     | `web_search`        |
| `mcp__*`                                      | `mcp_tool_call`     |
| anything else                                 | `tool_call`         |

A frame the connector cannot translate becomes `event.unmapped`, carrying the
raw frame — a harness change shows up in the log instead of vanishing.

### Runtime events to orchestration events

`apps/server/src/orchestration/RuntimeIngestion.ts` translates the
connector-neutral events into the log:

| runtime event                                           | orchestration event                             |
| ------------------------------------------------------- | ----------------------------------------------- |
| `session.started`                                       | `thread.session.bound`                          |
| `session.warning`                                       | `thread.error` (`fatal: false`)                 |
| `turn.started` / `turn.completed`                       | `thread.turn.started` / `thread.turn.completed` |
| `turn.plan.proposed`                                    | `thread.plan.proposed`                          |
| `item.*`, `content.delta`, `task.*`                     | `thread.item.upserted`                          |
| `request.opened` / `request.resolved`                   | `thread.approval.opened` / `.resolved`          |
| `user-input.requested` / `.resolved`                    | `thread.userInput.requested` / `.resolved`      |
| `usage.updated`                                         | `thread.usage.updated`                          |
| `context.updated`                                       | `thread.context.updated`                        |
| `model.changed`                                         | `thread.settings.updated`                       |
| `runtime.error`                                         | `thread.error`, plus an `error` row when fatal  |
| `session.ended`, `mcp.status.updated`, `event.unmapped` | nothing logged                                  |

`content.delta` frames fold into the item they belong to, so the log holds
whole `item.upserted` snapshots rather than a delta stream, and streamed text
is coalesced on a 50 ms window on the way in. Without that, an answer of N
delta frames wrote O(N²) bytes and rewrote the thread's whole document N times.

### Rows on screen

The client fold (`packages/client-runtime/src/clientState.ts`) applies the
stream to a `ThreadDetailView`. `apps/web/src/components/timeline/fold.ts`
turns the flat item list into rows:

- the items are grouped into turns first (`timeline/turns.ts`): a
  `user_message` opens one, unless it carries the id of the turn already
  open — a message steered into a running turn stays inside that turn instead
  of splitting it in two. Rows without a turn id fall back to position: they
  belong to the turn the last user message opened. Rows before the first user
  message form a leading turn of their own;
- the live turn (the last one, while a turn runs) folds each maximal run of
  work kinds, reasoning included, into a `work-group` burst from its first
  step, keyed `work-group:<first item id>` so the row keeps its key as steps
  stream in (and matches the group the same run becomes in an opened settled
  fold). Narration, todos, plans, errors, compactions, steered messages and
  decision records stay inline and split the runs; the trailing burst, when
  nothing follows it but the answers to the approvals and questions it asked
  (a decision anchors to the step that asked, and an approved command runs
  on), is marked `live`. The live burst is one line reading its
  newest step (`timeline/live-step.ts`): "Running pnpm test" while the step
  runs and "Ran pnpm test" once it is done, "Editing app.tsx", "Searching
  useMemo", a browser call's sentence, a task's title — the target cut to a
  command's first line or a file's name. Reasoning joins the line as
  "Thinking…", then "Thought for 4s": a snapshot carries only an item's start
  (its id), so the row times the thought to the moment it saw the status
  leave `in_progress` (`timeline/use-step-ended-at.ts`), and reads plain
  "Thought" when it never saw it running. The
  newest step's spinner or failure mark sits beside it, with "4 steps" once
  the burst holds more than one; opening it shows its rows. Earlier bursts,
  which narration has closed, read as a settled work group does. When the
  turn settles its bursts become the `turn-fold` below, and the same run in
  an opened fold keeps the burst's id and so its disclosure state. The
  `working` row comes last;
- a settled turn shows its user message, then one `turn-fold` row standing
  for its work: "Worked for 2m 3s · Ran 3 commands, edited 2 files, read 4
  files", with "1 failed" beside it in the destructive colour when something
  failed. The fold hides the work kinds (`reasoning`, `command_execution`,
  `file_change`, `tool_call`, `mcp_tool_call`, `web_search`, `task`, `skill`)
  and the interim narration — every `assistant_message` but the last. What a
  reader needs without opening it stays in view under the fold row, in order:
  todos, plans, errors, compactions, steered messages and answered-decision
  records. Then comes the final answer (the turn's last `assistant_message`,
  as long as no work follows it) and, when the turn changed files, the
  `turn-summary` card. A turn that ended in work (interrupted, failed) has no
  answer: its narration folds with its work, so a mid-turn "Now let me run the
  tests" never stands in for an answer above the commands that came after it,
  and its errors stay in view. The time runs from the user message to when
  the turn ended: its checkpoint's capture time, which the server records as
  the turn completes (`turnEndTimes` in `timeline/turn-checkpoints.ts`). An
  item's id marks when it started, so without a checkpoint (a workspace
  without git) the time ends where the turn's last item began, task children
  included;
- opening the fold puts the hidden rows back into the list right under it, in
  their original order, as rows of their own: each maximal run of work kinds
  is one `work-group` disclosure, and the narration between runs is a message
  row again. The fold is not a body inside one row, because one tall row
  would defeat the virtualizer and mount every hidden diff at once. The open
  folds are part of the row disclosure map (`turn-fold:<user message id>`);
  the timeline reads only that slice of it (`state/turn-folds.ts`), so a fold
  opening rebuilds the projection and any other row toggling does not. A fold
  opening also hands the scroll to the reader (Free, below) in the same
  render that brings its rows: following the end, the list would otherwise
  scroll to its new end and carry the toggle and the start of the revealed
  work up out of view;
- labels say what the work did (`timeline/work-summary.ts`). Each item is
  sorted into one kind of action — commands, file edits, creations and
  deletions (one per distinct path, a file created then edited counting as
  created), reads, searches, folder listings, web searches and fetches, the
  in-app browser, other servers' tools, tasks, skills, anything else as
  "used N tools". A tool call is sorted by the words in its name (`read`,
  `grep`, `list`, …) and then by the keys of its input (`file_path`,
  `pattern`, `url`, `command`), never by which harness sent it. The clauses
  come in that fixed order, the first capitalised, joined with commas; past
  three the rest fold into "and N more". A work group reads the same way
  ("Ran 2 commands, edited 1 file"), or "Thought for 2s" when it holds only
  reasoning — a group's time runs up to the start of the row that closed it
  (the narration after a thought), or to the turn's end for an opened fold's
  last run;
- the `turn-summary` card, "Changed 3 files +20 −4", starts open and lists
  one line per distinct path with its diff counts summed across the turn,
  five at most, then "Show N more" (kept in the disclosure map under
  `turn-summary-files:<row id>`). It lists paths and counts only, never a
  diff; each path opens that file's diff for this turn in the Changes pane.
  Under the files are "Undo", which restores the workspace to how it was
  before the turn (§8, "Restoring from the timeline"), and "Open in Changes",
  which shows that turn there. A turn that changed no files has no card, and
  the live turn and the leading turn have none;
- the final answer of each settled turn carries a `turnEnd` with the turn's id
  and duration, for the footer under it. The live turn has none (the
  work-group, fold and summary builders live in `timeline/fold-rows.ts`);
- durations come out of the UUIDv7 ids, which carry their creation millisecond
  in the leading 48 bits, and a settled turn's runs on to its checkpoint; a
  zero duration is left out of a label rather than
  shown as "0ms";
- tool rows follow the tool's name with a short target — the first of
  `file_path`, `path`, `filePath`, `command`, `pattern`, `url` or `query` in
  the input, first line only, cut to 60 characters. A target from one of the
  first three keys is a file chip once the workspace confirms it;
- while a turn runs, a trailing `working` row shows a spinner, "Working…" and
  the time since the turn began ("12s", "1m 05s", "1h 02m", whole seconds). The
  start is read off the turn id, or off the last `user_message` id while the
  turn is in flight but its id is not filled in yet;
- rows whose `parentItemId` names a task leave the top level and render nested
  inside that task's row;
- each answered approval, question and plan in the snapshot's `decisions` (§5)
  becomes a one-line `decision` row — "Allowed once · npm test", "Allowed for
  session · Shell(npm run \*)", "Denied · …" in the destructive colour,
  "Answered · <question>", "Not answered · …" for a card the runtime released,
  "Plan accepted", "Plan accepted with auto-edits", "Revision requested" —
  placed right after the row holding its `afterItemId`
  (after the task, for a task child's item). A record is never folded: it
  stays in view when its anchor is inside a closed turn fold, and in an open
  one it ends the work run, so the work group splits around it. A record
  whose anchor is missing or unknown goes at the end, before the working row.

Assistant messages and plan bodies render as markdown
(`apps/web/src/components/timeline/markdown.tsx`). A fenced block is told
apart from inline code by its `pre` parent, so a fence with no language is
still a block. It renders as a `CodeBlock` (`code-block.tsx`). The block's
header shows the file the fence names or its language. The file can be named
by `title="…"`, by a path after the language, by `lang:path`, or by a path as
the fence's only word, and that path's extension then picks the language.
The header also holds a wrap toggle and a Copy button that copies the source
text. The code sits in a scroller capped at 24rem that owns both axes: without
wrapping, the code is laid out at its longest line's width inside it, so the
sideways scrollbar sits at the bottom of the visible box rather than under
the last line of a tall block. It is highlighted
by `File` from `@pierre/diffs` through the same worker pool and themes as the
inline diffs, so Shiki tokenizes off the main thread and follows light/dark.
A fence's word, or its file's extension, is looked up in a table of common
languages with the names the header shows, then in Shiki's list of the
languages it bundles and their aliases, so `r` or `solidity` highlight too.
A block renders untokenized (language `text`) when its language is unknown,
when it is over 20,000 characters or 1,000 lines (`code-fence.ts`), or while
the message streams and its closing fence has not arrived yet — the block
splitter below says where that fence opens, finding it at any indent (a fence
in a nested list item) and inside `>` markers, where the quote ending closes
it, so a growing block is never tokenized again on every delta. It closes a
fence only at the fence's own quote depth and at most three columns deeper
than the opener, as the parser does: a `> ```` line in a fence opened outside
a quote, which markdown about markdown often holds, is code. Each block's
highlight is cached under its item id and offset, so a recycled row does not
tokenize it again.

A body renders block by block (`timeline/markdown-blocks.ts`): the text is
cut at top-level blank lines — never inside a fence or an HTML comment (one
that starts a line; a `<!--` mid-sentence or in a code span is text), and
not where an indented line, the next list item or the next `>` line carries
a list or blockquote on — and each block is its own memoised parse. While a
message streams (the server coalesces its deltas every 50 ms) only the block
at the end parses again; the ones before it keep their source and do not
render again. The blocks' elements are the body's direct children, as one
parse would leave them. Link reference definitions are gathered from the
whole text and added to every block that could use one, so `[docs][1]`
resolves wherever `[1]:` sits; a footnote whose definition is in another
block stays as typed. A streaming message renders in the body colour like a
settled one, and each element it gains — a paragraph, a list, a code block —
fades in (opacity only, and not under reduced motion).

The user's bubble (`timeline/user-message-row.tsx`) renders its text through
the same component in the `user` variant. Lists, emphasis, links and code
format, and code blocks are the same `CodeBlock`. What differs is kept to what
a person typed rather than wrote as a document
(`timeline/remark-user-text.ts`): each line ending is a line break, raw HTML
is turned into text before rendering, so `<b>x</b>` shows as typed, headings
stay at the body's size, and inline code sits on a chip that reads on the
bubble.

A user message over 10 lines with text or 600 characters
(`timeline/user-message-collapse.ts`, a CRLF counting as one; blank lines
render as shorter paragraph gaps, or as nothing at either end, so they do not
count, and a message that fits is never clamped; fenced code scrolls sideways
rather than wrap, so its characters do not count and its lines count at the
smaller height a code line takes, plus two for the block's header) is clamped to
ten lines that fade out at the bottom, with a "Show more"/"Show less" button
under it. The clamp clips rather than hides its overflow, so nothing can
scroll the text inside it, and keyboard focus moving onto a link or button
past the clamp opens the message, so the focused control is on screen.
Whether it is open is kept in the row disclosure map under
`user-message:<itemId>`, so it holds when the row scrolls away and back; the
collapse-all and expand-all shortcuts leave it alone.

Attachment thumbnails (`timeline/attachments.tsx`) are buttons: each opens
the full image in a dialog titled with the file name, which Esc closes,
returning focus to the thumbnail.

Under the bubble, right-aligned, is the message's footer
(`timeline/message-footer.tsx`): the time it was sent, read from the item's
UUIDv7 id ("14:05", the full date in the tooltip), a Copy button that copies
the text exactly as typed, and "Restore to here" (§8). The footer appears
while the pointer is over the row or focus is inside it, and always on a
coarse pointer such as touch, where there is no hover. Only its opacity
changes; it always takes its height, so revealing it never reflows a row the
list has measured. The time, and an answer's duration below, are focus stops
of their own, so their tooltips open from the keyboard as well, and they
carry the tooltip's words as their accessible name.

The final answer of a settled turn has a footer too, left-aligned under it
and revealed the same way: Copy (the markdown source), the time the answer
began, and how long the turn took, from its message to its checkpoint, as
the turn's fold row counts it ("2m 3s"). Interim narration and the running turn's messages
have none. No model is named: the thread records which model runs now, not which
one ran a past turn.

The timeline hands its rows one context (`timeline/thread-context.tsx`,
filled by `use-timeline-thread.ts`): the thread and project a row reads the
workspace through, the thread's turns in the order they first appear, the
checkpoints still in the repository, and why no restore can start right now.
It changes only when a turn is added, starts or ends, a checkpoint lands, a
restore starts or settles, or the connection drops — never on a streamed
delta.

Files an agent names become file chips (`timeline/file-chip.tsx`): the file's
icon, its name and the line, with the whole relative path in the tooltip. In
an agent message (and a plan body) two things can name a file
(`timeline/path-links.ts`). One is a link whose target is a path, with an
optional `:12`, `:12:3`, `#L12` or `#L12-L20`, or a `file://` URL. The other
is inline code that has a `/` or a file extension and does not read as a
command, a flag, a glob, a variable or a URL. Each message scans its text for
both and asks `files.stat` about all of them in one batch. Only a path the
thread's workspace confirms, and that is a file, becomes a chip; until the
answer comes, and for good when the workspace does not have the path, the
text stays as written. A path link that is not confirmed renders as its text,
since following it would open the app's own origin at that path. Links that
are not paths stay links. When two chips in one message share a name, each
shows the parent folders that tell them apart (`lib/format.ts`,
`src/format.ts`). A file-change row shows its path the same way, relative to
the workspace even when the agent reported it absolute, as does a tool row's
file target. Those chips show the whole relative path, and a row whose label
holds one keeps its toggle under the rest
of the line (`DisclosureRow`'s `triggerLabel`), since a chip cannot sit
inside a button. A file-change row asks only once its change has finished,
since a Write reports its path before the file exists. Answers are cached,
so every question carries the workspace's revision, which the timeline bumps
each time a turn or a restore settles: the rows on screen then ask again,
holding their chips meanwhile, so a file created during the turn becomes a
chip and a removed one stops being one.

Clicking a chip opens the file in the dock's Files tab at that line: the
chip writes a per-thread request (`state/file-reveal.ts`) that the thread
view answers by opening the dock on Files. The preview opens on the page that
shows the line, a hundred lines above it when it is further down the file
(`offsetForLine` in `panes/files/preview.ts`), marks its row and scrolls it
into view. The file goes into the thread's Files view (`useRevealFile` in
`panes/files/files-view.ts`), the same per-thread state that keeps the tab's
search, open file and scroll, so the scroll to the line happens once and a
later trip back to the tab finds the file where the reader left it. The turn
summary's file list is the one place a changed path is not a chip: each path
there opens that file's diff for that turn in the Changes pane instead (see
below), which is what a list of a turn's changes is for. Its paths are still
labelled relative to the workspace once confirmed, as the file-change rows show
them. A chip's context menu opens the file too, and copies the path relative to
the workspace or in full.

`apps/web/src/components/timeline/timeline-item.tsx` dispatches one component
per `ItemKind`. The list opens at its end and follows new rows while it sits
there; scrolled more than half a screen away, it stops following and shows a
round "Jump to latest" button at the bottom that scrolls back down.

Who owns the scroll is a small state machine (`send-anchor.ts`, fed by
`use-send-anchor.ts`, whose scroll holds are in `list-hold.ts`) with three modes. **Follow** is the behaviour above.
**Anchored** starts on a send: a user message that appears after the list
mounted, while a turn is requested or running — so a queued message whose turn
starts later counts, and the history a thread opens with never does. The list
stops following, and LegendList's `anchoredEndSpace` reserves trailing space
under the message so it can reach the top. Once the list reports that reserve
measured, the message is eased to 16px below the viewport top (placed at once
under reduced motion), then held: rows above it settle from estimated to
measured heights for a few hundred milliseconds after a send, so the hold puts
it back without animation on every frame the geometry moves, until it has been
still for 450 ms. The reply streams in below it. When the turn settles and its
fold closes, the rows under the message shrink a frame before the reserve grows
to make up for them, so the browser would clamp the scroll down; the message is
put back from that render's layout effect, before paint and without easing,
and held the same way until the rows are still. **Free** starts
when the reader scrolls while anchored — a wheel, a touch drag, a scrolling key
in the list, a press on its scrollbar, or a text selection inside it — or
opens a turn fold while following or anchored, so its rows open in place — and
nothing moves the list until it is back at its end, which resumes following, or
the reader jumps to the latest row, or sends a message of their own. Only a
send this window made in the last ten seconds anchors from Free, or from
Follow once the list is more than half a screen from its end — a reader who
opened the thread and scrolled up is still following, just not at the end
(`state/local-sends.ts`, noted by the composer as it dispatches): a queued
message the server drains minutes later, or one sent from another window,
leaves a reader who scrolled away where they are, and the jump button's dot
says something new arrived. That scroll stops a running hold on the
spot, in the event itself rather than on the next render, so the hold never
reads the reader's first wheel tick as the list moving and puts it back. The last sent message keeps its reserve in
every mode; it shrinks by itself as the reply grows past a screen, so it never
has to be dropped under a reader.

The jump button carries a small dot when the thread changed while the list was
away from its end, and loses it at the end or on a jump. While a sent message
is on its way to the top the list is away from its end on purpose, so the
button stays hidden then. `timeline.jumpToLatest` and the button both resume
following; the scroll to the end is instant under reduced motion.

Each thread keeps the reader's place for the session
(`timeline/reading-position.ts`, `use-reading-position.ts`, stored in
`state/timeline-positions.ts`). The timeline mounts once per thread, keyed by
its id, so leaving a thread unmounts its list: if it sat away from its end, the
first row on screen and how far below the viewport top it sat are saved; a
list at its end, or holding a message just sent, saves nothing. Reopening the
thread passes that row to LegendList as the first scroll target, so the first
paint is already there, and holds it where it sat, from a layout effect before
that paint, while rows around it settle to their measured heights. The list
starts in Free rather than Follow, so it never chases its end, and the jump
button shows from the start. A thread left at its end opens at its end and
follows, as always. The reader's first wheel, touch drag, scrolling key,
scrollbar press or selection lets go of the hold, the same as a send hold;
reaching the end follows again, and a send of their own anchors as usual. A
saved row that is gone — the live burst of a turn that has settled since —
opens the thread at its end. The positions live in memory only, at most 100
threads, dropping the one saved longest ago, so a relaunch opens every thread
at its end.

A slim turn rail sits at the timeline's right edge (`turn-rail.ts`, drawn by
`turn-rail-view.tsx`): one tick per user message, steered messages included.
Hovering a tick previews the message's first line with its markdown marks
stripped, cut to 80 characters, and the tick's accessible name carries the
same preview ("Go to message 3: …"), since a tooltip is not announced; pressing it scrolls the message to 8px below
the viewport top. The tick of the turn in view is solid: the last message at or
above the row 24px below the top, or, with the list at its end, the last
message on screen, since a short last turn cannot reach the top. The rail reads
this from the scroll offset and the list's row positions once a frame while the
list scrolls or its rows settle. Its entries depend only on each message's row id and
place (`railKey`), and each message's preview is worked out once per
snapshot of it, so a streamed delta, which rebuilds the rows, rebuilds and
rerenders nothing of the rail. The rail overlays the list without sitting
inside its scroller, so it passes a wheel over its ticks on to the list, as
the reader's own scroll, rather than leaving a strip that does not scroll. It
is hidden with fewer than two messages, and
when the timeline is narrower than 800px, measured by its own container query.
Each tick is a 24px target until they no longer fit, then they shrink together
to share the rail's height. `timeline.previousMessage` and
`timeline.nextMessage` (Alt+Shift+Up/Down, outside text fields) step between
messages whether or not the rail is shown; "previous" first returns to the top
of the message the reader is in when it has scrolled out above. The rail and
the keys hand the scroll to the reader before they move it, the same event a
wheel sends, so a held send anchor lets go rather than pulling the list back.
The scroll is instant under reduced motion.

`timeline.find` (Mod+F, with the thread open, no dialog or menu open, and the
focus outside the terminal, the browser and the Files pane, which keep their
own find) opens a
find bar over the timeline's top-right corner (`timeline/thread-find-bar.tsx`,
state in `use-thread-find.ts`). The list is virtualized and a settled turn's
work is not in it until its fold opens, so the bar searches the thread
snapshot, not the page: it walks the projection built with every fold open,
in display order, and matches the query, ignoring case, against each row's
own text as the row shows it — a message, a reasoning or plan body, a command
line, a tool's name and the target after it, a browser call's sentence, a
changed file's path, a search query, a skill, a task's title, an error
(`timeline/thread-find.ts`). Command output and tool payloads are
left out. Typing is debounced and a new query goes to its first match; the
bar shows "3/12", and Enter, Shift+Enter or its arrows step through the
matches, wrapping at either end. A step opens whatever hides the match — its
turn fold, its work group (a running turn's live burst included), the tasks
above it, its own reasoning or plan body,
the clamp on a long user message — hands the scroll to the reader as the rail
does, and scrolls the row to 30% down the viewport once the list holds it. The match the reader is on
keeps its place while a reply streams in more matches. Escape closes the bar
and puts the focus back in the composer. Pressing Mod+F again with the bar
open selects its query. The command palette (`Mod+K`) searches message text
too: past two characters, once typing pauses, it lists threads from every
project, archived ones marked, whose user or agent messages hold the query, as
a Messages group after the title hits, each with a one-line snippet with the
match marked. A message hit in the command palette opens its thread
with the bar prefilled with the palette's query, searched at once, at the
first match inside the hit's message (`lib/thread-find-request.ts`). While the bar is closed nothing is searched, and
while it is open the search reads a deferred copy of the items, so a streamed
delta is never held up by it.

While the bar searches, the rows on screen mark the query in a `<mark>` on the
theme's primary tint, and the row holding the current match carries a ring
(`timeline/thread-find-context.tsx`). Plain-text rows — a reasoning body, a
command line, a tool's name and target, a browser call, a file chip's path, a
search query, a skill, a task's title, an error — mark it as they render; a markdown body marks it with a rehype plugin that
runs only on the blocks holding the query (`timeline/rehype-find-marks.ts`).
Fenced code is counted but not marked, since it renders through the code
block's highlighter, and a match the source splits with markup (`**de**ploy`)
is not marked either; nor is the part of a path the file chip leaves off when
it shows the path relative to the workspace. The marks come from a context that is `null` while the
bar is closed, so a closed bar adds no parse to any row. Every row keeps the
same wrapper element whether it holds the current match or not, so moving the
ring changes a class and never remounts a row.

### Closing the turn

`run_end` produces `turn.completed` with a `stopReason` of `end_turn`,
`interrupted`, `error` or `max_turns`. Before the completion event leaves the
session, `session.ts` does the bookkeeping that has to happen while the turn is
still open — once it settles, the engine stops tagging events with its
`turnId`:

1. warn if the gate was silent (tools queued, no hook post — see §5);
2. wait (at most a second) for the process to exit, then re-read the
   transcript, which is where `usage.costUsd` arrives — its last flush lands
   after `run_end`, before the exit;
3. refresh the stored transcript path;
4. emit a plan proposal, if this was a plan turn.

`thread.usage.updated` carries the token counts and cost;
`thread.context.updated` carries used/limit, where the limit is the
`context_window` the last `status --json` reported. `CheckpointReactor` takes
`thread.turn.completed` as its cue to capture a checkpoint (§8).

---

## 5. Approvals

### The path a tool call takes

```
model calls a tool
   │
   ▼
cmd runs the PreToolUse hook                    (.commandcode/settings.local.json)
   │  ~/.poseidon/bin/cmd-hook.mjs, payload on stdin
   ▼
POST /hooks/pretooluse   Authorization: Bearer <per-thread ticket>
   │                                              apps/server/src/hooks/HookBridge.ts
   ▼
HookBridge.answer(token, body) → the session's registered handler
   │                                    packages/connector-cmd/src/hookAnswers.ts
   ▼
approval gate → PermissionService.decide(...)
   │     packages/connector-sdk/src/approvalGate.ts
   │     apps/server/src/permissions/PermissionService.ts
   │
   ├─ allow  → { permissionDecision: "allow" }
   ├─ deny   → { permissionDecision: "deny", reason: "denied by Poseidon permission rules" }
   └─ prompt → emit request.opened, park on a Deferred
                 │
                 │  thread.approval.opened → card docked above the composer
                 │  user answers → thread.approval.respond
                 │  → thread.approval.resolved → handle.respondToRequest
                 ▼
               { permissionDecision: "allow" | "deny", reason: "decided <d> via Poseidon" }
```

The top half is Command Code's: its hook is how a tool call reaches us. A
harness that asks its host directly instead — over an SDK or JSON-RPC — skips
the script and the bridge and hands its request straight to the same approval
gate; from the gate down the path is identical.

### The direct path, on Claude Code

```
model calls a tool
   │
   ▼
the CLI calls the SDK's PreToolUse hook, in-process   (every call, every mode)
   │     packages/connector-claude/src/toolGate.ts
   ▼
PermissionService.decide(...)  — no waiting here
   │
   ├─ allow  → { permissionDecision: "allow" }  the call runs
   ├─ deny   → { permissionDecision: "deny" }   the model is told it was refused
   └─ prompt → { permissionDecision: "ask" }
                 │  the CLI hands the call to canUseTool, decision made
                 ▼
               approval gate → the same card, the same answers
                 → { behavior: "allow" | "deny" }
```

The hook runs for every call in every CLI permission mode, and its "ask"
reaches `canUseTool` in all of them, `bypassPermissions` — full access —
included. So a sensitive path asks even under full access, and a rule in the
user's own `~/.claude` settings can never skip the ladder. AskUserQuestion and
ExitPlanMode pass the hook with no verdict: they speak to the user rather
than act on the machine. The connector names each call in Poseidon's
vocabulary before the ladder reads it (`approvals.ts`): Bash is a `command`
proposing `Shell(<first word> *)`, the edit tools are `file_write` with
`Edit(<path>)`, the read tools `file_read` with `Read(<path>)`, WebFetch and
WebSearch `web` with `Fetch(…)`, and an MCP tool `mcp_tool` with
`Mcp(<server>.<tool>)`. "Allow for the session" also hands the CLI its own
suggested rules for the call, kept to the session; "allow always" writes
only Poseidon's rule, never the CLI's settings files. A call the CLI
withdraws — the turn was stopped — answers its card `deny`. The full tables,
and which of this rests on a recording, are in
[claude-code-connector.md](claude-code-connector.md#approvals).

### The script and the ticket

`packages/connector-cmd/src/hookScript.ts` generates
`~/.poseidon/bin/cmd-hook.mjs` — dependency-free node, mode `0700`, rewritten
only when its content hash changes, written temp-and-rename so a running `cmd`
never reads half a script.

**The bearer arrives in a file, not in the environment.**
`POSEIDON_HOOK_TICKET_FILE` carries a **path**, and the bearer lives in a `0600`
file at `~/.poseidon/bin/tickets/<threadId>.ticket` that the session writes when
it opens and deletes when it closes; `POSEIDON_HOOK_TOKEN` is still read first
when it survives. It is a path because Command Code strips secret-shaped
variable names out of a hook's environment, which once left every tool call
running unapproved — the observation and the failure are in
[command-code-connector.md](command-code-connector.md#the-ticket-file).

Every failure path in the script prints a `deny`: bridge down, non-2xx, garbage
body, timeout. The one exception is a run that carries no URL and no bearer at
all — an interactive `cmd` in a project whose settings still hold our hook
block. That run belongs to the user, so the script exits cleanly with no output
and the harness uses its own prompt flow.

The timeouts nest: the script's fetch aborts at 570 s, the bridge answers
`deny` at 590 s, the harness's own hook cap is 600 s. Bodies are capped at 1 MiB
and a request carrying an `Origin` header that is not loopback gets `403` — the
hook script is our own child and sends none.

### The ladder

`decidePermission` in `apps/server/src/permissions/PermissionService.ts` is pure
and ordered — deny rules, plan mode, sensitive paths, allow rules, reads, then
the thread's runtime mode. The six steps, the pattern syntax and the
sensitive-path list are in [architecture.md](architecture.md#permissions).

Two things about it matter to this flow: a sensitive path prompts however the
user has widened the rules, and a failure inside the decision logs a warning and
returns `prompt`. It never reads as allow.

### The card and the rules it writes

`apps/web/src/components/approvals/approval-card.tsx` renders the request and
offers four answers. It is docked directly above the composer input by
`apps/web/src/components/composer/pending-card.tsx`, which shows one card at a
time — an approval, then a question, then a plan — across the composer's width,
never in the timeline. Keys while it is up, by default: `1` allow once, `2`
allow for session, `3` always allow, `D` or `Escape` deny; a muted line under
the card names them, read from the live table, as do the buttons' own keycaps.
They are ordinary rows of the keybinding table (§11) — `approval.allowOnce`,
`approval.allowSession`, `approval.allowAlways`, `approval.deny` — so they can
be rebound, and the card only registers handlers for them; it adds no key
listener of its own. The claim rule is their `when` clause,
`approvalPending && !inputFocus && !dialogOpen`: the card must be the one on
screen, focus must be outside a text field, and no dialog, popover or menu may
be in front. `Escape` does not compete with `thread.interrupt` either: that
binding's clause (§7) excludes an approval pending with focus outside a text
field, so the two are disjoint by context. With focus on the page, Escape
denies the call; in the composer, it stops the turn. Modifiers match exactly,
so `Shift+D` does not deny.

`allow-session` and `allow-always` carry a `pattern` — the `patternSuggestion`
the connector proposed, editable in the card before it is accepted
(`pattern-editor.tsx` previews it against the live request using the same
matcher the server enforces, `packages/shared/src/permissionPattern.ts`). The
decider turns it into a rule:

| decision        | rule scope | where it is stored                       |
| --------------- | ---------- | ---------------------------------------- |
| `allow-once`    | —          | nothing persisted                        |
| `allow-session` | `session`  | `permission_rules`, keyed to the thread  |
| `allow-always`  | `project`  | `permission_rules`, keyed to the project |
| `deny`          | —          | nothing persisted                        |

The rule is inserted inside the dispatch transaction, and the engine then
invalidates the `permission_rules` reactivity key so an open settings page
re-reads its list.

Every answer is also kept once the card is gone. The fold appends a
`ResolvedDecision` to the thread's `decisions`: `approval`, the request id, the
decision, the pattern it kept, a one-line subject — the input's `command`,
`path`, `file_path`, `filePath`, `url` or `query`, first line only, else the
tool's name — the time, and `afterItemId`, the last timeline item as the answer
landed. The connector echoes each answer back as `request.resolved`; only the
first, which still finds the request open, is recorded. When the harness
process exits with a card still up — Stop, a crash, an archive — the connector
releases each parked request itself (`deny` for an approval, no answers for a
question), and that event is the first to reach it. The fold tells it apart by
its `connector` actor and records the outcome `unanswered` instead of the
refusal, so the timeline never claims the user chose. The subject comes from
`packages/shared/src/decisionSubject.ts`, so the client's fold, which appends
the same record between snapshots, writes the same words.

While any card is up, the thread's `ThreadSummary` says so: `awaitingInput` is
true and `awaiting` names the most urgent open card — `approval`, then
`question`, then `plan` (§6) — so the sidebar row can show what the thread
waits on without subscribing to it: a bell reading "Needs you" for an approval
or a question, a quieter "Plan ready" mark for a plan.
While a turn runs, `runningSince` carries when that turn was requested (it
is kept on the in-flight turn in the `ThreadDoc`), so the row can say how long
the thread has been working; `updatedAt` cannot, since every event moves it.
The field is absent for any other status.

The patterns are Poseidon's own vocabulary — `Shell(npm run *)`,
`Edit(/src/**)`, `Fetch(…)`, `Mcp(server.tool)` and the rest — whichever
harness proposed them, matched by `packages/shared/src/permissionPattern.ts`
on both sides, so the preview in the card means what the engine will do. The
grammar and the aliases older rules use are in
[architecture.md](architecture.md#permissions); how Command Code's tool calls
map onto it is in
[command-code-connector.md](command-code-connector.md#the-tool-vocabulary).

### Subagents

PreToolUse fires **once** for an `agent` delegation, with the subagent's brief
as the input, and never again for what the subagent then does. Approving the
delegation approves everything it goes on to do; the prompt in that one payload
is all the user gets to judge. The only visibility into the work is the
`subagent_start` / `subagent_progress` / `subagent_stop` frames, which the
connector maps onto the `task` row the `agent` call opened
(`packages/connector-cmd/src/subagents.ts`).

On Claude Code the gate does not stop at the delegation. The CLI runs its
PreToolUse hook inside a subagent too — the hook input names the subagent
(`agent_id`) — so each of the subagent's calls reaches the ladder like the
main loop's, and a card it opens is answered in the same thread. The rows it
produces nest under the Task call's `task` row
(`packages/connector-claude/src/translate/subagents.ts`).

### When the gate stays silent

The gate's failure mode is to open: a hook that does not run produces no
decision and the harness falls back to its own flow. So the session counts
`tool_queued` frames and hook posts, and a turn that queued tools and received
no post emits a `session.warning` saying so — which the timeline shows as an
error row. Plan mode is exempt, because no hook fires there by design.

---

## 6. Plan mode and questions

### Plan mode

Plan mode is the button in the settings row under the composer, `/plan` and
`/default` in the `/` menu, or `Shift+Tab` while the composer has the focus
(`composer.planMode.toggle`, the habit terminal coding agents teach). The key
is only answered while the connector can plan or the thread is already
planning; otherwise, and anywhere outside the composer, Shift+Tab moves the
focus as usual. An open `/` or `@` menu takes Shift+Tab first, to move up its
rows.

Setting a thread's `interactionMode` to `plan` changes the next turn's argv:
`--permission-mode plan`, and **no `--yolo`**
(`packages/connector-cmd/src/turnArgs.ts`).

That combination is deliberate, and it is the whole of plan mode's enforcement.
Plan mode skips PreToolUse entirely, so none of the ladder above runs there:
not the user's deny rules, not "plan mode is read-only", not the sensitive-path
prompt. Adding `--yolo` on top would remove the last thing standing, which is
print mode's own refusal of writes and shell calls; without it the CLI refuses
them itself, which is what the mode claims to be. The recordings this rests on
are in [command-code-connector.md](command-code-connector.md#plan-mode).

The plan survives that refusal. The model writes its plan with an ordinary
`write_file`, and the whole body is in the `tool_queued` frame that announced
the call, so the connector saves the file itself (`plans.ts`,
`materializePlan`) and the refused write is shown as a saved plan rather than a
red failed row.

Finding the file the plan landed in takes three sources in order — the plans
index, this run's own frames, then an mtime scan fenced against the other
sessions writing into the same global directory
(`packages/connector-cmd/src/plans.ts`, and
[command-code-connector.md](command-code-connector.md#finding-the-plan)).

The proposal becomes `thread.plan.proposed` while the turn is still open, and
the card (`apps/web/src/components/approvals/plan-card.tsx`), docked above the
composer like the approval card (§5), offers three answers: `1` accept, `2`
accept and run, `3` opens the revision field, named in the same muted line
under the card. They are the table rows `plan.accept`, `plan.acceptAndRun` and
`plan.revise`, live while `planPending && !inputFocus && !dialogOpen`. No plan
row binds `Escape` — a plan does not block the turn on an answer, so the card
has nothing to deny. `ProviderCommandReactor` acts on
`thread.plan.responded`:

| action        | settings change                                                  | follow-up turn                            |
| ------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| `accept`      | `interactionMode: "default"`                                     | "Implement the approved plan at `<path>`" |
| `accept-auto` | `interactionMode: "default"`, `runtimeMode: "auto-accept-edits"` | the same                                  |
| `revise`      | `interactionMode: "plan"`                                        | the feedback text, or "Revise the plan"   |

The plan's path travels on the `thread.plan.responded` event rather than in a
reactor's memory: the fold clears `pendingPlan` on that very event, so carrying
it is what lets the accept turn survive a restart between proposing and
accepting.

The answer is recorded in the thread's `decisions` as §5 describes: kind
`plan`, the turn id, the action, and the plan file's name as its subject.

### Plan mode, on Claude Code

A plan turn runs the Claude Code CLI in its own `plan` permission mode, set
with `setPermissionMode` before the turn's message is written; the next turn
out of plan mode sets it back (`packages/connector-claude/src/session.ts`).
The ladder above does run here — the PreToolUse hook fires in every mode — and
its plan rung refuses every non-read, which is what keeps the turn read-only.

```
model writes its plan file      <config dir>/plans/<name>.md
   │  the hook lets this one write through with no verdict;
   │  the CLI's plan mode allows its own plan file and nothing else
   ▼
model calls ExitPlanMode
   │  the CLI fills in the input: plan (the file's markdown), planFilePath
   ▼
canUseTool   packages/connector-claude/src/interactions.ts
   ├─ item.completed  a `plan` row with the markdown
   ├─ turn.plan.proposed { planMarkdown, planPath }
   └─ { behavior: "deny", message: "…stop here…" }
        │
        ▼
the model stops; the CLI's result ends the turn
```

The card and the answers are the ones above: the reactor's settings change
reaches the session as `setPermissionMode`, and "Implement the approved plan
at `<path>`" names the CLI's own plan file, which the implementation turn can
read. Task and its subagents are refused in a plan turn by the same rung that
refuses writes.

### Questions

`ask_user_question` is withheld from a headless run, which is why every turn
passes `--tools-enable ask_user_question`. Print mode has no interactive
channel, so the tool call takes the hook road for a different purpose
(`packages/connector-cmd/src/hookAnswers.ts`):

1. the payload's `questions[]` are normalised
   (`packages/connector-cmd/src/questions.ts`) and emitted as
   `user-input.requested`;
2. the post parks; a question card
   (`apps/web/src/components/approvals/question-card.tsx`) opens above the
   composer with radio buttons, checkboxes for `multiSelect`, and a freeform
   field where allowed. Number keys `1`–`9` (`question.option.1`…`9`, live
   while `questionPending && !inputFocus && !dialogOpen`) pick option N — or
   toggle it, in a multi-select — of the question whose block holds focus,
   else of the first question;
3. `thread.userInput.respond` releases it;
4. the tool is **denied**, with the user's answers — in the question's own
   words, not our ids — as `permissionDecisionReason`. The model reads them as
   context instead of waiting for a prompt that will never come.

The answer is recorded in the thread's `decisions` (§5) as `question`,
`answered`, with the first question's header — else its text — as the subject.
Once the card closes, that record is what the timeline keeps of it: one line,
"Answered · <question>", where the exchange happened. A question the process
exit released reads "Not answered · <question>" instead (§5).

On Claude Code, AskUserQuestion is offered to SDK sessions as it is, and it
takes the direct path (`packages/connector-claude/src/interactions.ts`):
`canUseTool` emits `user-input.requested` — ids minted by position, every
question `freeform` because the CLI always lets the user type their own
answer — and holds the call until `thread.userInput.respond`. The tool is
then **allowed**, with the answers in its `updatedInput`: `answers` keyed by
each question's text, the chosen labels joined by ", " and the user's own text
after them. The CLI runs the tool with them and the model reads the result as
the user's answer. A stopped turn or a closed session answers the card with
nothing and denies the call.

---

## 7. Stop, and the queue

### Stop

The Stop button and the `thread.interrupt` binding both dispatch
`thread.turn.interrupt`. The binding is `Escape` with
`when: turnRunning && !dialogOpen && (composerFocus || (!inputFocus && !approvalPending))`:
it fires only while a turn runs and no dialog or menu is open, with focus in
the composer or outside every text field. In any other field — the browser
pane's address bar, the terminal — Escape cancels that field's edit and leaves
the turn alone. With an approval card up and focus outside a text field,
Escape denies the call instead (§5). The composer publishes `turnRunning` and answers the
command. The decider rejects it when no turn is
running or one is already stopping, and otherwise emits
`thread.turn.interrupted`, which sets `interrupting` on the thread document
without clearing `currentTurn` — the turn stays in flight until something
settles it.

`ProviderCommandReactor` calls `handle.interrupt(turnId)`. The session marks
itself interrupted and runs the kill ladder in
`packages/connector-cmd/src/spawn.ts`: `SIGINT` to the **process group**, then
`SIGKILL` after 5 s, then a `pgrep -g` sweep that SIGKILLs anything still in the
group. A bare SIGINT leaves a child that ignores it — or a `shell_command`
grandchild holding the pipe — running forever, and with it a turn that never
settles.

A run killed this way exits 130 and writes no `run_end` and no transcript. The
session normalises the exit code to 130 whatever signal finished it off, so the
turn settles `interrupted` rather than `error`. If there is no live session at
all, or the interrupt itself fails, the reactor appends the synthetic
`thread.turn.completed` itself rather than leaving the thread stuck in
`running`.

The consequence for the next turn is §13: a SIGINT'd run leaves no transcript,
so its session id is not resumable.

### The queue

A harness that cannot steer — a print-mode one takes no mid-turn message — has
a send made while a turn is running go on a queue instead of racing the
session. `thread.turn.start` with
`queued: true` emits `thread.message.queued`, carrying the whole composer input
— text, attachments, mentions and references. An interrupt that has not settled
yet always queues, whatever the caller asked for.

The strip (`apps/web/src/components/composer/queue-strip.tsx`) is a projection
of `doc.queue`; nothing is removed locally. Each row ends with what the message
carries besides its text (`queue-summary.ts`), counted under the draft tokens:
`#×2 $×1 @×1 +1 file(s)` is two file mentions, a skill, a plugin and an
attachment. `thread.queue.remove` and `thread.queue.reorder` are commands, and
the reorder event carries the whole new order rather than the move, so a
projector never replays arithmetic.

Each row also has a "…" menu (`queue-row-menu.tsx`, commands in
`use-queue-actions.ts`). **Remove** is `thread.queue.remove`. **Steer now**,
offered only while a turn runs on a session that steers and no Stop is
settling (the server would queue a steer then, at the back), is two commands: the
remove first, so the drain on `thread.turn.completed` cannot send the message
a second time, then `thread.turn.steer` with the same text, attachments,
mentions and references. A refused remove means the drain already took it and
nothing is steered; a refused steer puts the message back with
`thread.turn.start { queued: true }`, at the end of the queue rather than where
it was, since no single command steers a queued message. A steer that got no
answer is not re-sent, since the server may have taken it, and neither it nor
a message the queue refuses to take back is dropped: both are added to the
composer after whatever the draft holds. **Edit** removes the
message and, once the removal is accepted, puts its text, mentions and
references in the composer, asking first when the draft already holds
something. A message with attachments cannot be edited — they are
server-staged paths and the composer holds browser files — so its Edit item is
disabled rather than dropping the images.

Draining happens on `thread.turn.completed`. The dequeue is chosen **inside**
the append transaction, on the document as it is at append time, so a
`thread.queue.remove` decided in between cannot let a message leave the strip
and be sent anyway. The follow-up turn is dispatched with `queued: true` and
its receipt is read: if anything makes the decider refuse it — a sibling thread
starting a checkpoint restore, the user archiving the thread — the message is
re-queued rather than destroyed. Nothing drains while a turn is still in
flight: that completion was not the one that freed the connector.

A completion only ends the turn it names. Archiving a thread mid-turn closes its
session, and the close settles that turn when it gets there; by then the thread
may be unarchived with a newer turn running — and since the reactor handles the
archive's close before the newer turn's request, the settlement lands after
`thread.turn.requested` and before `thread.turn.started`. Both folds (server and
client) count a turn as in flight from `thread.turn.requested` and ignore a
`thread.turn.completed` whose `turnId` is not the turn in flight, so the late
settlement cannot end the newer turn.

### Steering

A harness that can take a message mid-turn says so with
`capabilities.steering`. Its `session.started` carries the capabilities, and
`RuntimeIngestion` copies them onto `thread.session.bound`, so the thread's
session in the read model knows what its harness can do. Command Code
declares `steering: false`, and its threads keep the queue exactly as above;
Claude Code declares `steering: true`.

`thread.turn.steer` carries the same input as a send — text, attachments,
mentions — and the decider answers it from the thread as it is:

| The thread                               | What the steer becomes                                           |
| ---------------------------------------- | ---------------------------------------------------------------- |
| no turn running                          | a new turn, as an unqueued `thread.turn.start` would start       |
| a turn stopping (`interrupting`)         | `thread.message.queued`, drained on that turn's completion       |
| a turn running, not known to steer       | `thread.message.queued`, as a send would queue it                |
| a turn running, the session cannot steer | rejected: "this thread's harness cannot take a message mid-turn" |
| a turn running, the session steers       | `thread.turn.steered` plus the user's row, both on that turn     |

The first row absorbs a race: the turn ended while the user was still typing,
and the message simply starts the next one. "Not known to steer" is a thread
whose session has not bound yet — the first turn of a new thread while its
harness starts, or any Command Code turn before its first run has ended, since
that connector learns its session id only then — or a session bound before
capabilities were recorded. Nothing has said the harness steers, and nothing
has said it cannot, so the message waits on the queue rather than failing. The
same checks as a send bar a steer outright — a missing or archived thread, a
checkpoint restore in this thread or a sibling.

`thread.turn.steered` changes nothing in either fold: the turn it names keeps
running, and the user's row arrives as its own `thread.item.upserted` stamped
with that turn, so the timeline shows the message inside the turn it joined.
`ProviderCommandReactor` calls `handle.steer(turnId, input)`, which the
turn-scoped handle delivers only while that turn is still the active one. When
there is no live handle, or the steer fails — the turn settled between the
decision and the call, say — the message is dispatched again as
`thread.turn.start { queued: true }`: a new turn when none is running, the
queue when one is. Should even that be refused, it goes onto the queue
directly, as a refused drain does. The row the decider already wrote stays in
the turn it was meant for, so a message that fell back shows twice: once where
it was sent, once where it was answered.

The connector writes the message into its harness while the turn runs, with no
new `turn.started`, and keeps the running turn open until its harness has
answered the steered message too, so the turn still ends with exactly one
`thread.turn.completed`. A harness may take the message into the work it is
doing, or finish what it was doing and then answer the message on its own; a
connector tells the two apart from what its harness reports about each
message, not by counting the harness's own completions, and holds the turn
open across any completion that leaves a steered message unanswered. Usage
reported along the way adds up into the one turn's. A connector checks there is
still a turn to join in the same step that would end it, so a steer that races
the turn's end either joins it or is refused and falls back to the queue as
above. Stop ends the whole turn, and a steered message the harness had not
taken up yet is withdrawn with it rather than answered afterwards. The Claude
Code connector's reading of its harness is in
[architecture.md](architecture.md#the-claude-code-connector).

In the composer (§4), Enter on a running thread whose harness steers sends
`thread.turn.steer`; `Cmd+Enter` still queues, and on a harness that cannot
steer both keys queue as they always have. The client decides from the same
fact the decider does — `capabilities.steering` on the thread's bound session
— so until the session binds, a running thread queues.

---

## 8. Checkpoints, diffs and restore

### Capture

`CheckpointReactor` (`apps/server/src/orchestration/CheckpointReactor.ts`) takes
`thread.turn.completed` as its cue and calls `CheckpointHook.capture`. The
implementation (`apps/server/src/git/CheckpointStore.ts`) writes a hidden ref:

```
refs/poseidon/checkpoints/<threadId>/<turnId>
```

The commit is built from a **temporary index**, so capture never disturbs the
user's real index or staging area. A workspace that is not a git repository has
nothing to snapshot and reports `null` rather than an error. The checkpoint's
id is a pure function of the commit SHA — the first 32 nibbles with the version
and variant fields forced to UUIDv7 — so `checkpoints.list` and
`thread.checkpoint.created` always agree.

Capture and restore run in the **thread's own root**: its worktree when it was
created in one, the project's folder otherwise. HEAD and the index belong to
one worktree, so a worktree thread's snapshot has to be taken there. The
hidden refs, on the other hand, are shared by every worktree of a repository,
which is why prune — on `thread.deleted` and `project.removed` — keeps running
from the project's root: it reaches a worktree thread's refs just the same,
even after that worktree has been removed.

### Restore

Restore is a durable work order, in three events:

```
thread.checkpoint.restore  (command)
   ▼
thread.checkpoint.restore.requested   ← recorded before any git runs
   ▼  CheckpointReactor: git restore from the commit + git clean -fd
   ├─ thread.checkpoint.restored
   └─ thread.checkpoint.restore.failed  (locked directory, pruned ref, dirty submodule)
```

A request with no recorded outcome is replayed at boot, so a crash between the
receipt and the git work cannot drop it. The decider refuses a restore while a
turn is running, while this thread is already restoring, and while **any
sibling thread that shares its workspace root** is — the git work rewrites
that whole directory, so the exclusion is per root: every local thread of a
project shares the project's folder, and every thread of one worktree shares
that worktree, while a worktree thread's restore holds up nobody working
elsewhere. For the same reason a restore in flight bars a new turn in the
same directory.

`ThreadDetailSnapshot.restoring` carries the in-flight checkpoint, so a window
reloaded mid-restore still says "Restoring the worktree…" instead of offering a
button that can only be rejected.

A restore records no checkpoint of its own, so a turn sent after one starts
from the restored checkpoint rather than from the previous turn's. The fold
keeps that history: each `thread.checkpoint.restored` adds a
`CheckpointRestore` to `ThreadDetailSnapshot.restores`, stamped with the
thread's latest turn at the time (`latestTurnId`, the last turn id to first
appear in the items; restores never run during a turn). The server's fold and
the client's stamp it the same way, and a document stored before the field
existed reads as having none. The timeline reads it to know what "before this
turn" means after a restore (below).

### The right dock

The thread view and the New task page share a right dock
(`apps/web/src/components/dock/`). It is closed by default: nothing opens it
at start, on opening a project or on opening a thread. Opening it without
naming a tab (`dock.toggle`, Mod+Alt+B, or the header's dock button) goes
back to the tab this thread last used this session, else to a centred
launcher — one row per kind with its icon, name and key. The launcher reads
nothing, so an open dock loads nothing until a tab is picked.

The strip across the top holds only the tabs opened in this thread this
session, in the order they were opened, never every kind the dock offers.
Each tab is an icon and a short name with its name and chord in a tooltip,
and has a close button beside it, shown on hover or focus and always on the
active tab. A middle-click on a tab, or a bare Delete or Backspace while it
has the focus, closes it too; with a modifier held the key is left to the
app's chords, so `Mod+Alt+Backspace` still deletes the thread. The close
buttons are for the pointer: a tablist holds only tabs, so they stay out of
the accessibility tree and the Tab order, and each tab announces Delete and
Backspace (`aria-keyshortcuts`) as its keyboard close. Closing the active tab opens its right neighbour, else
its left; closing the last one shows the launcher again with the dock still
open. After the tabs, a "+" button ("Open a tab") lists the kinds this dock
offers that are not open yet, each with its icon, name and chord; it shows
only while at least one tab is open and some kind is not.

Every opener adds its tab if it is absent, activates it and opens the dock:
the chords, a turn summary's file chips, "Open in Files tab", the agent
browser's Show button, `openInThreadBrowser` and the browser's own auto-open.
The chords keep their toggle meaning: `dock.changes` (Mod+Shift+D),
`browserPane.toggle` (Mod+Shift+B) and `dock.files` (Mod+P) close the dock
when it already shows their tab, rather than closing the tab.

What a thread's dock remembers — its open tabs, their order, the last tab and
whether it was left open — is `DockMemory` (`dock-toggle.ts`), kept per thread
(or per project on the New task page) in an in-memory atom through
`useDockMemory` (`apps/web/src/state/ui.ts`). It lasts the session and is
never written to storage, so closing the dock and reopening it brings back
that thread's tabs and active tab, and a relaunch starts every dock closed
with no tabs. Arriving at a thread reopens its dock only on a pane the user
chose there; closing a tab that is not on show is no such choice, so it never
turns an auto-opened or linked pane into the one that comes back.

Only the active tab's pane is mounted. Closing a tab hides its pane exactly
as switching to another tab does: closing the active Browser tab is the same
user move as switching away from it. The browser's tabs and webviews live in
the browser host above the routes, so they, the agent's control of the
browser and a person's takeover are untouched by closing the dock tab; the
terminal drawer is not part of the dock at all.

**Adding a tab kind.** The kinds are a small registry, so a new one needs no
change to the strip, the launcher or the "+" menu:

1. add its id to `DOCK_TABS` in `dock-toggle.ts` — the order there is the
   launcher's and the "+" menu's;
2. add a `DOCK_TAB_META` entry in `dock-tab-meta.ts`: its Honeyicons `icon`,
   `label`, the catalog `command` that opens it, and `available(scope)` — which
   docks offer it (`"thread"`, `"project"`; Browser is a thread's only);
3. add its renderer to `DOCK_TAB_PANES` in `dock-tab-panes.tsx`, a function of
   the dock's context (scope, snapshot, project, connection);
4. if `available("project")` is true, add its id to `projectDockTabs` in
   `dock-toggle.ts` as well: the New task route validates `?pane=` against
   that list (`isProjectDockPane`), and a registry test holds it equal to the
   project's kinds;
5. if it has a chord, add the command to the command catalog (it must pass the
   default-collision test, and then shows in the palette and cheatsheet) and
   answer it where the other dock keys are answered.

Both maps are typed `Record<DockTab, …>`, so the compiler refuses a kind
missing from either; `projectDockTabs` is a plain list, which the registry
test keeps in step instead.

### The Changes pane

`apps/web/src/components/panes/changes/changes-pane.tsx` is the dock's first
tab. A scope select at the top picks what to compare
(`selection.ts` turns each choice into one `git.diff` payload):

- **This turn** — the turn selector and the restore controls, which show in
  this scope only. The selector picks the working tree, one turn's checkpoint,
  or checkpoint to checkpoint.
- **Branch vs base** — `git.diff` with `mergeBase`: everything the branch has
  done since it forked, commits and uncommitted work together. The base is
  the worktree's own `baseBranch` for a thread started in one, else the
  repository's default branch from `git.branches`; with neither the pane says
  "No base branch to compare with". On the base branch itself the fork point
  is `HEAD`, so a line under the select says only uncommitted work shows.
- **Uncommitted** — the working tree against `HEAD`, both ends omitted.

The New task page's dock has a Changes tab of its own
(`project-changes-pane.tsx`), for the picked project's folder before any
thread exists: Uncommitted and Branch vs base (against the default branch),
with `git.status` and `git.diff` given the `projectId` alone. There are no
turns, so no turn scope and no restore; the file list and its review are the
thread pane's (`ComparisonBody` in `changes-list.tsx`), and "Add to chat"
writes into the page's draft.

`git.diff` answers with the file list, because `GitDiff.files` already
carries the path, the `+`/`-` counts and the per-file patch. `git.status` is
read alongside for the branch line and to tell "not a git repository"
(`isRepository: false`) from "nothing changed". Every call names the thread,
so a worktree thread's pane shows its worktree. The paths are relative to the
repository's top level, which is not the workspace root for a project in a
subfolder of its repository, so the diff also carries `prefix` (`git rev-parse
--show-prefix`) for the file menus to find each path under the root.

The list reads as an overview first (`changes-list.tsx`, `review-list.tsx`,
rules in `review.ts`): one compact row per file — its kind, directory and
name, `+`/`−` counts — and every patch closed until it is opened. The one
exception is a comparison of a single file of at most 400 changed lines, which
opens on its own; anything more would hand the two-worker highlight pool every
patch at once. A summary line under the toolbar reads "N files · +x −y · k
viewed" beside an Expand all / Collapse all toggle. What is open, and what is
marked viewed, is the thread's own and kept per path in memory
(`useChangesReview` in `state/ui.ts`), not per comparison, so a new turn does
not open everything again. The checkbox on a row marks the file viewed and
closes it; the mark is stored against a cheap hash of the patch it was made
on, so a file the agent edits again reads as unviewed with nothing to reset.
Each row's "…" menu, and a right-click anywhere on the row, holds the file
menu (see "Opening the workspace in an editor" below): open the file in the
Files tab or an editor, reveal it, copy its path, or append a reference to it
to the thread's composer draft; nothing in the pane reverts a file. While the pane is
shown it publishes `changesOpen`, and `Alt+ArrowDown` / `Alt+ArrowUp`
(`changes.nextFile` / `previousFile`) open the next or previous file and
scroll its header to the top.

A turn summary in the timeline links into the pane (`deep-link.ts`): the fold
names the checkpoint each turn left, "Open in Changes" navigates to
`?pane=changes&turn=<checkpoint ref>` and each listed path adds
`&file=<path>`. The pane picks that turn — the latest when the turn left no
checkpoint or the ref is gone — opens the file and scrolls it into view once,
then clears both params so a reload does not scroll again.

A Split toggle beside the select lays each patch out side by side
(`InlineDiff`'s `diffStyle`, passed to `@pierre/diffs`); it defaults to
unified, and the timeline's own file-change rows are always unified. The
scope and the diff style are remembered for every thread in localStorage
(`useChangesScope`, `useDiffStyle` in `state/ui.ts`); a stored value the pane
does not know reads as the default.

Nothing refetches on a command receipt, because both writes that move the
worktree finish _after_ the command that started them. The pane watches the
thread snapshot instead (`use-changes-refresh.ts`): a restore records the
sequence it was accepted at and refetches once the snapshot passes it; a turn
refetches when `currentTurnId` falls back to null. A refresh — those two and
the refresh button — rereads every git read of the project, the same
per-project revision a branch switch bumps, so the header follows along.

The pane's turn selector lists the checkpoints the thread's fold of
`thread.checkpoint.created` holds. That fold still names a ref removed outside
the app — a prune, a re-clone — so `checkpoints.list` answers the refs that
are actually in the thread's root, and the timeline intersects the two before
it offers a restore (below).

### Restoring from the timeline

Each user message offers "Restore to here" in its footer: the workspace as it
was before that message was sent. A settled turn's summary card offers the
same restore as "Undo": the workspace as it was before that turn ran, which
also undoes every turn after it. Both are `timeline/restore-before-turn.tsx`,
so they appear, hide and disable by the same rules.

A checkpoint is the workspace _after_ its turn, so that is the checkpoint of
the turn before the message's turn (`restorePointBefore` in
`timeline/turn-checkpoints.ts`) — unless a restore went through between the
two, when it is the checkpoint that restore went back to (the last one, when
there were several). Otherwise the two buttons would bring back the turns the
reader had rolled back: turn 1 edits A, turn 2 edits B, a restore goes back to
turn 1, and turn 3 then started from A alone, not from turn 2's A and B. Turns are ordered by where their items first
appear, and a message steered into a running turn carries that turn's id, so
it restores to the same point as the message that opened the turn: before the
turn began, which also undoes what the turn changed before the steer arrived.
The fold marks such a row `steered`, and its button's tooltip and dialog say
"Restore to before this turn" and what else it undoes rather than promise the
workspace as it was when the message was sent. There is nothing before the thread's first turn, and a
workspace that is not a git repository records no checkpoints, so neither
shows the button. When the turn right before has no checkpoint of its own
(pruned, or its capture failed) and no restore followed it, the button falls
back to the state before that turn, and the dialog says that it undoes that
turn too. When the checkpoint a restore went back to is gone, the button is
left out rather than fall back past the restore.

The checkpoints come from the fold, intersected with `checkpoints.list`
(`availableCheckpoints`). The timeline reads the list through
`checkpointsAtom`, keyed by the number of checkpoints the fold holds, so a
turn's new checkpoint asks again rather than being hidden by a list read
before it; while the list loads, or when it fails offline, the fold stands
alone. A restore settling — restored or failed — rereads every git read of the
project, the list among them, and the Changes pane with it.

The buttons are disabled, with the reason in the tooltip, while the server is
out of reach, while a restore is running, and while a turn is in flight
(`turnInFlight`, since the server holds its turn from `turn.requested`).
Disabled, they keep their focus stop (`aria-disabled`, a click does nothing)
and carry the reason as their accessible description, so the keyboard reaches
the tooltip and a screen reader says why. Each
opens the Changes pane's restore dialog (`panes/changes/restore-dialog.tsx`,
the app's one restore confirmation) with its own title and wording; it
confirms, dispatches `thread.checkpoint.restore` and reports a rejected
receipt or an unreachable server inside the dialog. A turn that starts while
it is open disables its Restore and says why. The conversation is left as it
is; only the files move.

### Branches

`git.branches`, `git.branch.create` and `git.checkout`
(`apps/server/src/git/Branches.ts`, behind `Git.ts`) run in the same root the
diff does. The list reads `git for-each-ref` over `refs/heads` and
`refs/remotes` (a remote's own `HEAD` pointer is skipped) and `git worktree
list`, which marks a branch checked out in another worktree. The default
branch is the remote's `HEAD` (`origin`, or the first remote), else a local
`main` or `master`, else `init.defaultBranch` when that branch exists, else
the current branch. The remote's `HEAD` is named by its local branch when one
exists (`main`) and by the remote-tracking one otherwise (`origin/main`, in a
clone made with `-b develop`), so a worktree can always be cut from it and the
Changes pane can always find its merge base.

A branch is always cut with `--no-track`: one cut from `origin/main` would
otherwise track it, and its first push would land on main. Names are refused
before git sees them when they start with `-` or carry anything but letters,
digits, `.`, `_`, `/` and `-`, and then `git check-ref-format --branch` has the
last word. A switch — `git.checkout`, or a create with `checkout` — is refused
with `conflict` while a tracked file has uncommitted changes, and while a turn
runs (or a restore rewrites files) in any thread whose root is the same
directory; every local thread of a project shares its root, so one busy local
thread holds them all. Untracked files do not count as dirty: git carries them
across a switch, and a harness session writes its own untracked config into
the workspace. A remote branch is checked out as a local branch tracking it.

`git.diff` with `mergeBase` compares the working tree, uncommitted and
untracked work included, with `git merge-base HEAD <mergeBase>`: the branch's
own work, without the base's later commits showing up as reverted.

The thread header's branch picker (`apps/web/src/components/git/branch-picker.tsx`)
is the client of these. Its trigger shows the branch the thread's root is on
(`detached` on a detached HEAD). When the header is narrow the branch keeps
its room: the title shrinks twice as fast, and below 32rem the header's Commit
button drops its label for its icon and tooltip. For a local thread it opens a search over the
branches in two groups, Local and Remote; a remote branch whose local twin
exists is left out, since picking it would switch to that local branch anyway,
and a branch checked out in another worktree is listed but disabled. Picking a
branch runs `git.checkout`; a query that looks like a branch name and names no
existing branch — local, remote, or a remote's short name — offers
`Create branch "<query>"`, which cuts it from the current branch with
`checkout`; a query git would refuse as a name offers no create, and the list
says which rule it breaks (no spaces, `..`, a leading `-`, and so on). A refusal (a dirty tracked tree, a running turn in a sibling local
thread) is a toast with the server's message, and nothing is stashed. The
trigger is disabled while the thread's own turn runs, and the popover says that
a switch moves every local thread of the project. For a worktree thread the
popover only shows the branch, the base it was cut from and the path, because
the thread owns that branch.

After a successful switch or create, every git read of the project refetches —
branches, status and each diff range, for every thread — through a per-project
revision atom that each read in `gitAtoms.ts` depends on; a switch in the
project's folder moves all of its local threads, so refreshing only the scope
that asked would leave its siblings stale. The agent can switch branches as
well, so the picker also refetches its list when a turn finishes. While the
list cannot be read — offline, or a client that serves no git — the trigger is
disabled with the reason in its tooltip.

### Commit, push and pull requests

`git.commit` and `git.push` (`apps/server/src/git/Commits.ts`) run in the
same root, as the user: no author environment (that is the checkpoint store's,
for its hidden refs only) and never `--no-verify`, so the user's identity,
signing config and hooks apply. Without `paths` a commit stages everything
(`git add -A`). With `paths` the index is reset first and only those paths are
staged (`--literal-pathspecs`), so a file staged earlier in a terminal but left
unchecked does not ride along; it stays in the working tree, unstaged. A staged
rename is one row named by its new path, and picking it stages its old path
too, so the commit records the rename rather than a copy. Nothing
staged is `conflict` "Nothing to commit.", a hook's refusal is `conflict` with
the hook's own output, and a commit is refused like a switch while a turn runs
in that root. The index is saved (`git write-tree`) before anything is staged
and put back (`git read-tree`) whenever no commit comes of the call — a path git
cannot stage, nothing staged, a hook's refusal — so a failed commit never costs
the user what they had staged. The reset names the whole repository (`:/`)
rather than being pathless, because a pathless `git reset` also ends a merge
or cherry-pick in progress. Two states are refused before anything is touched,
both `conflict`: unresolved conflicts ("Resolve the conflicts in … before
committing.", since staging them would record the markers as the resolution),
and, as `git commit -- <paths>` refuses, a commit of chosen paths while a
merge, cherry-pick or revert waits for its commit — that commit takes every
change. Committing everything mid-merge makes the merge commit.

A push goes to the branch's `branch.<name>.remote`, else `origin`, else the
only remote; no remote is `unavailable`. A branch with an upstream is pushed
with a plain `git push`; one without gets `git push -u <remote> <branch>`, so a
branch cut `--no-track` from `origin/main` lands on its own name. Pushes run
with `GIT_TERMINAL_PROMPT=0` and a five-minute ceiling: a credential prompt
fails fast instead of hanging the call.

`git.pullRequest.create` (`apps/server/src/git/GitHubCli.ts`) goes through the
GitHub CLI behind the `GhRunner` service, which finds `gh` on PATH and in the
Homebrew directories a Finder launch leaves out. `gh --version` failing is
`unavailable` "gh not available", `gh auth status` failing is `unavailable`
(not authenticated), and then `gh pr create --head --base --title --body`, all
argv, opens the pull request from the current branch. The base is the
payload's, else the branch the thread's worktree was cut from, else the
default branch, with a remote prefix (`origin/main`) dropped. When a pull
request already exists its URL comes from gh's refusal, or from `gh pr view`,
with `created: false`. `git.pullRequest.readiness` runs only the first two
checks (`pullRequestBlocker`) and answers their reason, or `reason: null` when
gh is installed and signed in, so the header can say why before a click. Tests
swap in a fake runner that answers with gh's own wording; nothing talks to
GitHub.

The thread header's git actions control
(`apps/web/src/components/git/git-actions-control.tsx`) is the client of these
— and the New task page's header carries it too, before any thread exists,
acting on the picked project's own folder with the `projectId` alone. Its
primary button (`apps/web/src/components/git/git-primary-button.tsx`) follows
the branch's state, offering the first step with something to do
(`nextGitStep` in `apps/web/src/lib/git-next-step.ts`): Commit while anything
changed, with the changed-file count as a badge; Push while the branch has no
upstream yet or is ahead of it, with `↑N` commits ahead as the badge; View PR
once a pull request for the branch is remembered (below), which opens it; and
Create PR for a pushed branch that is not the default one and has a remote.
With none of these it is Commit, disabled as "no changes". Create PR is
disabled with gh's reason when `git.pullRequest.readiness` says gh is missing
or signed out; that read is refetched with the others, so signing in from a
terminal enables it on return to the window. Until it answers (or from a
server without it) Create PR is offered, and a `gh` that cannot open one fails
with the server's message in its toast. Beside it a chevron
opens a menu with Commit, Commit & push, and Commit & create PR, and View pull
request when a link is known. An action is a stack of steps, planned from the
root's status and branch list (`planGitAction` in
`apps/web/src/lib/git-actions.ts`): a commit only when something changed; a
push after a commit, and otherwise only when the branch has no upstream yet
(the push then sets it, `-u`) or is ahead of it; the pull request last.
Pushing and the pull request need a remote. Each action that cannot run says
why — in the button's tooltip, or as a second line under its menu item: no
changes and nothing to push, a turn running (every action is disabled while
this thread's turn runs, or while a git run is going; View PR, which runs
nothing, stays), not a repository, a detached HEAD, no remote, the branch
behind its upstream, a pull request from the default branch, or one `gh`
cannot open. An enabled
button's tooltip says what it does instead: `Push 2 commits to origin/<branch>`,
`Create a pull request for <branch>`. Files also change outside a turn, in an
editor or a terminal, so the control rereads every git read of the project
when the user comes back to the window — focus, or the page turning visible,
counted once when both fire (`useWindowReturn` in
`apps/web/src/lib/window-return.ts`) — and the status when its menu opens. A
Commit disabled as "no changes" would otherwise stay so with no click of its
own to refresh it.

Any action that commits opens the commit dialog first
(`apps/web/src/components/git/commit-dialog.tsx`, its pure half in
`commit-picker.ts`). It has a message box, the changed files with a checkbox
each, and one button per action. The message starts as the thread's title —
`Update N files` while the title is still `New thread` — then a blank line and
`Changed files:` with one `- path` line each; nothing writes the message for
the user. Opening the dialog refetches the status, and until the user types
the message follows it and the checkboxes: it counts and lists the files still
ticked, not the ones read before the dialog opened or left out since. From the
first keystroke the message is the user's. Every path `git.status` reports is
listed (`commit-file-list.tsx`), untracked files included and all ticked, each
row with its status letter and its path cut in the middle so the file name
stays, the whole path (`old → new` for a rename) in its tooltip; a select-all
box above says `N of M files` and shows a mixed state when some are unticked.
Poseidon's own hook file never appears there: while a session holds it,
`info/exclude` keeps it out of the status (see "The CLI's own config files").
The same pick drives all three buttons, labelled with the count — `Commit 3
files`, `Commit 3 files & push`, `Commit 3 files & create PR`. `paths` is sent
only when something is unticked, so with every file ticked the server stages
everything, which a commit in the middle of a merge needs. With nothing ticked
or an empty message every button is disabled, its tooltip saying why, as it
does for an action's own reason. The action the dialog was opened for is the
filled button and has the focus, so Enter runs it, and Mod+Enter runs it from
anywhere in the dialog, the message box included — a key of the dialog's own,
not a keymap default. A pull request in the same run takes its title (the
first line) and body (the rest) from the commit message; with nothing to
commit, a push runs straight away and a pull request asks only for its title
and body.

The steps run in order (`runGitSteps`) and the first refusal stops the run, so
a failed commit never pushes and a failed push opens no pull request. Each step
has one toast that starts as `Committing…`, `Pushing to origin/<branch>…` or
`Creating pull request…` and turns in place into its outcome: `Committed
<sha>`, `Pushed to …`, `Pull request created` or `Pull request already open`
with an Open action — or `<Step> failed: <the server's message>`, which is how
a hook's refusal, a rejected push or `gh not available` reach the user. After a
commit or a push every git read of the project refetches, the way a branch
switch does. The last pull request URL is also remembered per branch of each
thread (or, from the New task page, of the project folder) in localStorage
(`usePullRequestLink` and `pullRequestLinkKey` in `apps/web/src/state/ui.ts`,
web links only, nothing on a detached HEAD), under the branch the push
reported. The header's View PR button reads it back and opens it through
`openExternal`, as the toast's Open action does.

### Opening the workspace in an editor

The thread header's "Open in" control
(`apps/web/src/components/open-in/open-in-control.tsx`), just before the git
actions, is a split button over `editors.list` and `editors.open`. Its main
half opens the thread's workspace — its worktree, when it has one — in the
favourite editor; below 32rem it drops the editor's name for its icon and
tooltip, like Commit. The chevron lists every editor the server detected,
then the file manager and the terminal. Picking an editor opens the workspace
in it and makes it the favourite, stored as `preferredEditor` in the settings
document, so the main half and `Mod+O` (`editor.openFavorite`) follow the last
choice across reloads and windows. The file manager and the terminal only
open; they never become the favourite. Until an editor is picked, or when the
stored one is not installed on this machine, the first editor the server
listed leads (`pickFavourite` in `open-in/favourite.ts`). A refusal — the
workspace gone, the app uninstalled since the listing — is a toast with the
server's message. With no editor detected (only the file manager, or nothing
while offline) the control is not shown, and `Mod+O` and its palette entry go
with it.

The same apps open single files from the file menus: the Changes "…" menu, a
right-click on a Changes file header, and a right-click on a row of the dock's
Files tab all list one set of entries (`fileMenuEntries` in
`open-in/file-menu.ts`, rendered as dropdown or context-menu items by
`open-in/file-menu-items.tsx`). In order: "Open in Files tab" (in the Files tab
itself, "Open"), "Open in <favourite>", "Open with" and a submenu of every
detected editor, "Reveal in Finder" (the file manager's own label; on Linux it
opens the folder holding the file), "Copy path" (absolute) and "Copy relative
path", then "Add to chat". What cannot work there is left out rather than
disabled: no editor detected drops the two "Open" entries, a directory in the
Files tab has no preview entry, the New task page has no thread to answer
"Open in Files tab", and "Copy path" waits for the project list, which names
the root. A Changes file deleted in the comparison keeps only the copy entries
and "Add to chat". Changes paths are git's, relative to the repository's top
level; the rows map them under the workspace root with `GitDiff.prefix`
(`workspacePath`), and a file outside the workspace — a project in a subfolder
of its repository — keeps only "Copy relative path" and "Add to chat". The pane that lists the files provides the workspace
(`FileMenuScopeProvider` in `open-in/file-menu-scope.tsx`): the thread and its
worktree, or on the New task page the project alone — its Changes list is keyed
by the page's draft, which is not a thread, so opens go to the project's folder.
Picking an editor from a file menu opens the file without changing the
favourite.

### Worktrees

`git.worktree.create` (`apps/server/src/git/Worktrees.ts`) gives a new thread a
directory of its own. The branch is the settings document's `git.branchPrefix`
(default `poseidon/`) followed by `branchSlug` of the free-text name
(`packages/shared/src/branchSlug.ts`: lowercase ASCII, digits and single
dashes, at most 40 characters cut at a word boundary, `thread` when nothing is
left). A prefix that makes an invalid name is refused as `invalid`, naming the
setting. The base is the payload's, else the default branch, and it has to
resolve to a commit. The worktree goes in
`<Poseidon home>/worktrees/<project slug>/<slug>`, and `-2`, `-3`… is appended
until neither a branch nor a directory of that name exists — two projects with
the same name share the parent directory. `git worktree add --no-track -b`
runs from the project's root, and the answer (real path, branch, base) is what
`thread.create` records as the thread's `worktree`.

`git.worktree.list` reads `git worktree list --porcelain`, the project's own
checkout first. `git.worktree.remove` takes a path only when it is a
registered worktree of the project's repository, neither the project's own
folder nor the repository's main checkout (they differ when the project was
added from a linked worktree), compared by real path; refuses with `conflict`
while a thread that is not deleted (archived ones included) still works there
or while another project was added from that folder; and runs `git worktree
remove`. git refuses a tree with modified or untracked files, and that
refusal is answered as `conflict`, saying the removal would lose that work;
`force` removes it anyway. The branch
is never deleted, so committed work survives, and `git worktree prune`
follows.

`git.worktree.setup` streams the project's setup script
(`apps/server/src/git/SetupScript.ts`). The script is read from the settings
document's `projectSettings[projectId].setupScript`, never from the payload,
and a missing or blank one answers a single `skipped` frame. It runs as
`/bin/sh -c <script>` in the worktree, with `POSEIDON_WORKTREE_PATH` and
`POSEIDON_PROJECT_ROOT` set, detached so it leads its own process group.
stdout and stderr arrive as `output` frames, capped at 1 MiB with a notice,
and an `exit` frame carries the exit code (or the signal) last. A stream that
ends first — the client went away — kills the whole group, SIGTERM and then
SIGKILL, so nothing the script started outlives it. `git.worktree.remove`
waits for any such stop in that worktree to finish before it removes anything.

### Starting a thread in a worktree

The start screen's composer has a second picker beside the project's
(`apps/web/src/components/thread/workspace-mode-picker.tsx`): **Local**, the
project's own folder that its other local threads share, or **New worktree**.
The choice is remembered per project in localStorage (`useWorkspaceMode`). New
worktree is disabled, with a tooltip saying why, when `git.branches` answers
that the folder is not a repository. With it picked, a second select offers
the base branch — local branches, then remote ones — opening on the list's
`defaultBranch`.

Sending in that mode runs `start-in-worktree.ts`, a sequence of injected steps:

1. `git.worktree.create` with the first non-blank line of the message as the
   name. The branch is the prefix and its slug (`poseidon/fix-login-redirect`),
   the directory `~/.poseidon/worktrees/<project slug>/<slug>`. A refusal —
   not a repository, a bad prefix, an unknown base — is a toast with the
   server's message, and nothing exists yet.
2. `git.worktree.setup`, the project's setup script in the new directory.
   `worktreeSetupAtom` (`packages/client-runtime/src/gitCommands.ts`) folds
   the stream's frames into the run so far, so the panel above the composer
   (`worktree-setup-panel.tsx`) shows the output as it arrives. Its Stop
   button interrupts the atom, which ends the stream and kills the script.
3. When the script exited 0, or the project has none, `thread.create` with the
   `worktree`, then the draft is sent as the first turn and the screen moves
   to the thread.
4. Otherwise the sequence stops before the thread exists. The panel names how
   the script ended (`Setup script exited 3`, killed, stopped) and keeps its
   output. **Start anyway** runs step 3 in the worktree as it is; **Discard
   worktree** asks first, then removes the directory with `force` — whatever
   the script wrote there goes, and the branch stays.

The pickers and the composer wait from step 1 until the thread starts or the
worktree is discarded, and the draft stays put throughout, so a discarded
attempt can be sent again. Leaving the start screen before then leaves nobody
to choose (`use-start-in-worktree.ts`): a running setup is stopped and the
worktree removed with `force` — the server holds a removal until any setup run
in that worktree has finished stopping, so a script still unwinding from
SIGTERM is not writing into a tree git is deleting — as is one waiting on Start
anyway or Discard,
each with a toast saying so and that the branch is kept. A thread that was
already being created when the user left is kept, but its first message is
not sent and the screen does not pull the user to it — the draft waits in that
thread's own composer. Once the thread exists, its header's branch picker
shows the branch with a fork mark and the path in a tooltip, and its sidebar
row carries a fork mark.

A second thread can start in a worktree that already exists: **New thread in
this project** in a worktree thread's sidebar menu sends `thread.create` with
that thread's `worktree` and a fresh id, with no new worktree and no setup
run, and the new thread shares the directory and branch. From a local thread
the same item starts a local thread, or opens the project's blank newest one
as the per-project button does.

### Starting in the background

New task can start a thread and stay put, so the next task can be typed
straight away: `composer.startInBackground` (`Mod+Alt+Enter`, bound only while
New task is open) or **Start in background** in the menu behind the chevron
beside Send (`start-send-menu.tsx`), which shows the same keys. Both need what
Send needs, and neither runs while a foreground start is under way.

The press takes a snapshot of the draft — text, mentions, references, images —
empties it, and moves the page to a fresh draft id (`StartThread` owns it), so
the composer is blank with the focus back in it and the picked model kept. The
thread takes the old id. Nothing moves to it: no navigation, and no terminal
hand-over, since the user is still on New task with the project's terminals.

`use-background-start.ts` then runs the start as one lane of
`background-start.ts`. Every write is a one-shot call —
`git.worktree.create`, `git.worktree.setup` as `worktreeSetupRun`,
`thread.create`, the image uploads and `thread.turn.start` through
`@/lib/one-shot-commands` — so the user's next send, or leaving New task,
interrupts none of it. With **New worktree** picked the lane cuts the worktree
from the picked base branch and runs setup with no panel to watch. A setup that
fails still creates the thread in the worktree, as Start anyway would, but
leaves the message unsent in that thread's composer; so does a first send that
fails. A thread refused after its worktree was cut has the worktree removed
(`force`, the branch kept). A reload of the window ends a setup run still
streaming, and the server kills its script. So does **Stop setup** on the
loading toast, shown while the start has a worktree: it ends that start's
setups still running or yet to run, as the start panel's Stop does, so each
such lane creates its thread and parks the message with "Setup script
stopped".

One toast follows the start: "Starting in <project>…", then in place
"Started in <project>", "Created a thread in <project>" with the reason and a
note that the message waits in the composer, or "Could not start in
<project>" with the reason. The first two carry **Open**, which goes to the
thread. When no thread came to exist, the message goes back into New task's
draft, unless the user has begun another one there.

#### Comparing models

The button with the columns icon beside the workspace picker turns on
**Compare models** (`use-compare-models.ts`, drawn by
`compare-models-picker.tsx`). It is React state on the start composer, not
remembered. While it is on, a checkbox menu takes the model picker's place,
grouped by connector instance like the picker, starting with the model the
composer showed ticked; Choose model (`Mod+Shift+M`) opens it as it would the
picker. It holds up to 4 models (`COMPARE_MAX`); once four are
ticked the rest are disabled. The workspace picker is disabled, since every
model gets a new worktree of its own whatever it says; the base branch it
holds still applies. On a project that is not a git repository the toggle is
disabled and its tooltip says why, and with fewer than two models ticked Send
and **Start in background** are disabled, with the reason beside the toggle.
Leaving New task turns the mode off.

Every way of sending then starts in the background: Enter, Send, the queue
chord, `Mod+Alt+Enter` and the menu item. `fan-out-plan.ts` turns the draft
into one lane per model, in tick order:

- A new thread titled `<first line of the task> · <model>`, the task cut at 60
  characters.
- A new worktree whose branch is the branch prefix followed by
  `<task slug>-<model slug>`. The model part is capped at 16 characters and the
  task part is shortened so the whole name stays within `branchSlug`'s 40, so
  the model survives the server's slugging. The same model under two
  instances collides, and the server appends `-2`.
- The shown effort and runtime mode, each kept only where that model or
  instance accepts it, so the server's default applies instead of a refusal.

`background-start.ts` runs the lanes. Worktree creates go one at a time in lane
order, because concurrent `git worktree add` on one repository races on git's
locks, and each `thread.create` waits for the lane before it. The threads are
therefore created in tick order and land next to each other in the sidebar,
which lists threads by their latest update. That wait lasts at most 10 seconds
(`TURN_WAIT_MS`) once a lane is ready, so a setup that runs on does not keep
the later lanes from their threads; they land ahead of it. Setups, sends and
turns overlap, while image uploads go one at a time. A lane fails, parks or
starts on its own terms, as described above. The one toast
reads "Starting N threads in <project>…", then "Started N threads in
<project>" naming the models, "Started k of N threads" naming each lane that
did not start and why, or "Could not start N threads". **Open** goes to the
first thread that started. The others are beside it in the sidebar.

### Deleting a worktree thread

The sidebar row menu and Settings → Archived threads confirm a delete with the
same dialog (`apps/web/src/components/sidebar/delete-thread-dialog.tsx`). For a
local thread it is only the delete: the project's folder is left alone. A
thread with a worktree adds a checkbox, checked by default, **Also remove the
worktree at `<path>`**, saying the branch is kept with its commits. Two
threads can share a worktree ("New thread in this project" on a worktree
thread), and the server refuses to remove one that a thread not deleted,
archived included, still works in. So when another thread still uses it the
dialog offers no checkbox and says the worktree is kept; the selection bar's
bulk delete leaves such worktrees out too, and a worktree shared only among
the threads it deletes is removed once, by the last of them
(`worktreeRemovers`). `delete-thread.ts` runs the steps:

1. `thread.delete`. A refusal is the usual toast, and nothing else happens.
2. Only after an accepted delete, and only with the box checked,
   `git.worktree.remove` without `force`. Success is a toast, "Worktree
   removed — branch `<branch>` kept".
3. git refuses a tree with modified or untracked files, answered as
   `conflict`. That is a toast with the server's message and **Remove
   anyway**, which stays until it is answered. Taking it opens a second
   confirmation saying the uncommitted work will be lost, and only confirming
   that removes with `force`. Letting the toast go keeps the worktree.

The second confirmation is mounted above the routes
(`WorktreeForceRemovalHost` in `__root.tsx`), because the sidebar row that
started the delete is gone once its thread is. **Remove anyway** taken on
several toasts queues their confirmations, shown one after another in the order
they were asked, so none is dropped unanswered. The conflict is also the
expected answer to a race: the session closes asynchronously after
`thread.delete`, and a harness can still hold an untracked config file in the
worktree for a moment, so **Remove anyway** is the way through that too.

Removing a project deletes its threads but removes none of their worktrees;
its confirmation says so when any of them has one (`removal-copy.ts`).

---

## 9. Attachments

Only images are staged: the server refuses any other bytes, so the composer
gates attaching on `capabilities.images` alone. A connector's
`capabilities.attachments: "files"` says it could carry any file, and is read
once staging accepts more than images.

Print mode has no image flag. The path around it:

1. the composer reads the pasted or dropped file and calls
   `attachments.stage({ threadId, name, base64 })`;
2. `apps/server/src/attachments/AttachmentStore.ts` sniffs the media type from
   the file's own magic bytes — PNG's signature, JPEG's `FF D8 FF`,
   `GIF87a`/`GIF89a`, `RIFF….WEBP` (`packages/shared/src/imageBytes.ts`), never
   the name or the declared type, so a `.png` that is really a shell script is
   refused — checks `MAX_ATTACHMENT_BYTES` (8 MiB) on the base64 length before
   decoding and again on the decoded bytes, and writes the file as
   `<sha256 prefix>-<sanitised name>.<ext>` under
   `~/.poseidon/attachments/<threadId>/`, with the extension the sniff chose,
   mode `0600` in a `0700` directory;
3. the reply is a `StagedAttachment` — path, name, mime, size, sha256;
4. `thread.turn.start` carries that **reference**. The bytes never enter the
   event log, which is replayed on every boot and streamed to every client;
5. `turnArgs.ts` puts the attachments directory on the argv as `--add-dir` and
   names each file in the prompt as
   `Attachment (<mime>): <absolute path>`;
6. a timeline thumbnail fetches the bytes back with `attachments.read`, which
   re-sniffs, re-checks the size, and resolves symlinks before refusing any path
   that lands outside the thread's own directory.

Claude Code takes images in the message itself, so step 5 differs there: the
connector reads the staged file, sniffs it again, and sends its bytes as a
base64 image content block ahead of the text
(`packages/connector-claude/src/attachments.ts`). The model sees the picture
without a tool call. The attachments directory is still among the CLI's
readable directories, for any file that is not an image, which is named by
path as on Command Code.

`~/.poseidon/attachments` is the very directory `ConnectorServices.attachmentsDir`
names, so a staged file is already where the connector expects it and no second
copy is made.

`AttachmentReactor` purges a thread's directory on `thread.deleted` — not on
`thread.archived`, since an archived thread can be reopened and its timeline
still asks for thumbnails. It also sweeps, at boot, files no thread document
references: a paste that never became a message. Files younger than one hour
are left alone, because the previous process may have staged one just before it
went away.

---

## 10. The browser pane

The dock's Browser tab gives the agent a real browser and lets a person take it
over mid-call.

### Three modes

The server runs in one mode for its whole life, chosen at startup from what
the desktop shell handed over (`apps/server/src/browser/agentBrowser.ts`):

- **`in-app`** — the desktop. agent-browser drives the thread's own pane
  webviews through the shell's browser bridge (`inAppDriver.ts`). There is no
  frame to ship: the webview is already showing the page, and human input
  lands in the guest directly. The first call attaches: `tab list`, which on a
  thread with no webview makes agent-browser ask the bridge for one, then
  `--pin-tab tab <first tab>` and `stream disable`. If that fails, the call
  fails with the reason and the pane shows it; there is no headless fallback.
- **`disabled`** — the desktop under `POSEIDON_REMOTE_DEBUG=0`: every call
  answers "the in-app browser is disabled (POSEIDON_REMOTE_DEBUG=0)".
- **`owned-chromium`** — the web renderer, with no desktop behind it:
  agent-browser runs its own headless Chrome (`ownedDriver.ts`), the driver
  connects its `stream` WebSocket, and the pane renders the JPEG frames that
  come back and forwards gestures and toolbar actions into it.

The desktop side of the in-app browser is the bridge
(`apps/desktop/src/main/browser/`, see
[architecture.md](architecture.md#the-browser-bridge)). Chromium's
remote-debugging port is never opened; the bridge is a loopback WebSocket
that speaks CDP for one thread's pane webviews, at
`ws://127.0.0.1:<port>/cdp/<threadId>/<capability>`, and 404s everything
else. Each pane webview is set up once, when Electron creates it: the bridge
registry recognises its thread by its `persist:thread-<id>` session and
attaches its debugger, its `window.open` handler turns popups into requests
for a pane tab, and its input relay tags every gesture with the thread and the
guest's `webContents` id.

A page is always laid out at the pane's size: the webview's box is the page's
viewport, and resizing the dock resizes the page. As hardening, the bridge
refuses the CDP calls that would give the page a size or scale of its own
(`Emulation.setDeviceMetricsOverride`, `setVisibleSize`, `setPageScaleFactor`),
since the guest would keep such an override for as long as the client stayed
attached; the caller reads that the page takes the pane's size, which the
person sets. Of the rest of `Emulation` only media, geolocation, locale,
timezone, user agent and the two clears are granted; everything else is
refused. None of the agent's browser tools sends any `Emulation` call — the
catalogue has no `set` command, and agent-browser sends none to connect, open,
snapshot, click, scroll or take a screenshot, full-page ones included — so
this changes nothing the agent does today. A page that looks wider than the
pane is a site with a minimum width of its own, which scrolls sideways in a
narrow pane as it would in a narrow browser window — DuckDuckGo's results page
sets `min-width: 1000px` — and widening the dock is the answer there.

The webviews themselves belong to the renderer's browser host
(`apps/web/src/components/browser-host/`), mounted above the routes rather
than in the dock, so a tab outlives closing the dock, switching dock tab or
thread, and /settings. Nothing creates one at start: a thread's first tab
appears when the agent's first call asks the bridge for it
(`Target.createTarget`), when a page opens a popup (placed right after its
opener), or when a person types an address into an empty pane. The selected
tab of the thread on screen is laid over the pane; every other tab stays laid
out at the pane's last size inside the window, transparent and beneath the
app, because a guest that is offscreen, 0×0 or `display: none` takes no
clicks and never answers a screenshot. The host refuses a tab for a thread
that is archived or not in the list, forwards the guests' gestures as
`browser.humanInput` whether or not the pane is open, and takes a thread's
tabs down when it is archived — and when it is deleted, also clears its
`persist:thread-<id>` partition through the shell.

The pane itself is closed by default too. Opening the app, a project or a
thread opens no dock tab the user did not leave open, and an empty pane shows
"No page open" with the address bar. When the agent's first call creates the
thread's tab, the dock stays as it was: the thread header shows "Agent is
using the browser — Show" for as long as a `browser_*` call runs or a tab the
agent opened is open, and the pane is not on screen. Settings → Browser →
"Open the browser pane when the agent starts using it"
(`browser.openPaneOnAgentUse`, off by default) opens the pane instead, once per
agent activity; closing it while the agent is active keeps it closed for that
thread until you open it yourself, and an auto-open is not remembered as the
thread's dock tab. Other surfaces — the terminal's links — call
`openInThreadBrowser(threadId, url, { reveal })`, which accepts only http(s),
opens or selects the thread's tab on it and shows the pane.

A failed attach shows in the pane as an alert with the message and Retry; the
agent's own call failed with the same message. Under `POSEIDON_REMOTE_DEBUG=0`
the pane reads "In-app browser is disabled (POSEIDON_REMOTE_DEBUG=0)" and a
person can still browse its tabs. The web renderer's frame stream is labelled
"Headless browser (web mode)".

`apps/server/src/browser/agentBrowser.ts` finds the CLI (`POSEIDON_AGENT_BROWSER`,
then `agent-browser` on `PATH`) and runs every call as argv-form `execFile`,
never a shell. A missing binary is not fatal: the service reports `binary:
null`, every call fails with `AgentBrowserUnavailable`, and the pane renders an
install prompt keyed off the message's opening clause
(`AGENT_BROWSER_MISSING_MESSAGE`). The sentence and the prompt name only what
the mode needs: in-app, `npm install -g agent-browser`; owned Chromium also
`agent-browser install`, which downloads the Chrome it drives. The daemon session is
named `ade-<12 hex of the thread id>` — hashed so the daemon's socket path fits
the 103-byte Unix socket limit — and carries a 300 s idle timeout as a net
behind `close`, which in-app mode can call freely: it sends no CDP, so the
pane's tabs survive it. Every daemon runs in the agent-browser namespace
`poseidon-<8 hex of POSEIDON_HOME>`, so the app's sessions never mix with your
own agent-browser use and two homes never share one. The child's environment is an allowlist that keeps the
operator's own `AGENT_BROWSER_*` and `CHROME_*` out; the thread's bridge URL
reaches it as `AGENT_BROWSER_CDP`, never in argv.

A pinned session whose tab the pane closed fails `tab_gone`; the agent reads
"the browser tab you were driving was closed in the pane; the next call uses
the pane's current tab", and its next call attaches to the pane's current tab.

A session is lazy: `browser.subscribe` creates the state ref but not the
browser. The driver opens on the first agent call (in owned mode, also on the
first toolbar navigation), so opening the pane never starts one.

### Tabs and the toolbar

In-app the pane has a tab strip above the address bar: one entry per tab of
the thread with its favicon (http(s) only) or a spinner while it loads, a close
button each, and New tab, which opens `about:blank` and focuses the address.
A page's popup — a `target=_blank` link or `window.open` — becomes a tab
placed right after the tab that opened it, and the tab the agent opens with
`browser_tabs new` is selected, as a browser would show it (unless the CDP
request asked for the background); `browser_tabs switch` brings its tab to
the front. Selecting a tab here moves the pane, not the agent, which stays
pinned to the tab it drives.

Back and forward are disabled at the ends of the history, and reload turns
into stop while the page loads. What is typed in the address field loads only
as http(s) or `about:blank`: `localhost:3000` becomes `http://localhost:3000`,
`example.com` becomes `https://example.com`, and anything else — `file:`,
`javascript:`, `data:`, a phrase — is searched for
(`apps/web/src/components/panes/browser/address.ts`). The "more" menu zooms
the page in, out and back to 100% (the toolbar shows the percentage while it
is not 100%), opens DevTools for the tab in its own window, opens the page in
the system browser, and copies its address.

Four keys work while focus is in the pane: `browser.focusUrl`,
`browser.reload`, `browser.back` and `browser.forward` (see the keybinding
table). With focus in the page itself the key never reaches the window, so the
shell matches it in the guest, swallows it and relays the command, and the
tab it came from moves. That also means `Cmd+R` in a page reloads the page:
the default menu's window reload never fires from inside a pane tab.

### The agent's cursor, the picker and screenshots

While the agent clicks or moves the pointer in a tab, the pane draws its
cursor over the page, with a pulse where it presses, and the cursor fades a
couple of seconds after the agent's last move. The shell sees each mouse
command on its way through the bridge and tells the window where it lands;
the window scales it by the tab's zoom.

Two buttons beside the address bar bring the page into the conversation.
Pick an element outlines what is under the pointer; clicking picks it without
the page seeing the click, and its CSS path, text and the start of its HTML
are added to the thread's message draft (Escape or a second press cancels).
Screenshot to chat attaches a PNG of the tab to the draft, under the same
rules as a pasted image. Nothing is sent until you send the message.

In the timeline the agent's browser calls read as what they did — "Opened
http://localhost:5173/", "Clicked @e3", "Pressed Enter", "Took a screenshot" —
with the full input and output behind the row's disclosure; text the agent
typed or filled is never shown in the label.

### Settings → Browser

The Browser page holds the auto-open setting above (off by default), explains
how the agent reaches the in-app browser — through a private local endpoint
that reaches only that thread's tabs, never the app window, other threads or
Chrome's remote-debugging port, which stays closed — shows whether
agent-browser is installed and which version the server found at startup
(`browser.status`) with the install command when it is not, and clears
browsing data: the address bar's history for every project and, on the
desktop, every thread's cookies, storage and cache, after a confirmation.

### Dev servers and suggestions

Focusing the address field lists the project's running dev servers, then the
pages the project's tabs have visited; typing narrows both, the arrow keys
highlight one and Enter loads it (or what was typed, with none highlighted).
The empty pane offers the same servers as one-click buttons. History is kept
per project in the window's localStorage — http(s) pages only, a revisit
moved to the front, at most 50 — and on the desktop every tab is recorded,
the agent's hidden ones included.

The servers come from `browser.discoverServers`
(`apps/server/src/browser/discovery.ts`), because only the server sees the
machine. It answers "which of this project's processes serve a page here?"
in three steps:

1. `lsof -nP -iTCP -sTCP:LISTEN -F pcn` lists every listening TCP socket with
   its pid and command (argv-form, never a shell, 3 s at most). Only loopback
   and wildcard sockets count; one bound to a LAN address is not what
   `localhost` reaches.
2. `lsof -a -d cwd -p <pids> -Fn` gives each one's working directory, and a
   listener counts only when that is the project's folder or inside it. This
   is the step that keeps another project's dev server, a chat app's local
   port and macOS's AirPlay receiver on `*:5000` out of the list — a bare port
   probe cannot tell whose a port is.
3. One `GET /` per candidate on its own loopback address (`[::1]` for a
   server bound there, which is where Vite lands when `localhost` resolves to
   IPv6), 500 ms each, eight at a time. Only an HTML answer or a redirect is
   kept, so a database, a language server or a debugger port is never
   offered as a page.

Every server is offered as `http://localhost:<port>` with its process name,
sorted by port, sixteen at most; the server's own port is never among them.
Without `lsof` (Windows, a Linux without it) nothing can say whose a port is,
so the fallback probes a fixed list of at most sixteen common dev ports on
`localhost` — never a range — and offers what answers with no process name.
Nothing scans in the background: the pane asks while the address bar is on
screen and each time its list opens, and the server reuses a project's
answer for 10 s.

### Tools

The agent reaches the browser through MCP. `apps/server/src/mcp/McpGateway.ts`
serves one loopback `POST /mcp` endpoint with a per-thread bearer, minted when
the connector asks for the endpoint and revoked when the session ends.
`packages/connector-cmd/src/config.ts` registers it in the CLI's own local MCP
scope, with the bearer left as a `${POSEIDON_MCP_TOKEN}` placeholder the harness
resolves at launch, so the per-session token never touches disk.

The catalogue is `apps/server/src/browser/tools.ts`: `browser_open`,
`browser_snapshot`, `browser_click`, `browser_fill`, `browser_type`,
`browser_press`, `browser_scroll`, `browser_wait`, `browser_get`,
`browser_screenshot`, `browser_eval`, `browser_tabs`. Calls are serialized per
thread. Results cap at 64 KiB of text, counted in bytes, and the
`structuredContent` beside it at the same 64 KiB serialized — over it, a
snapshot's text and refs go and only `origin`, `url`, `title` and `targetId`
stay, with `truncated: true`. `browser_screenshot` adds an image block, and
gets 15 s instead of the CLI's usual 30: a guest that is not painted never
answers a capture, so the agent reads "the page did not paint — is the
browser pane laid out?" rather than waiting.

Timeline rows for `mcp__poseidon__browser_*` come from the harness transcript
like any other tool call — the gateway emits none, or every row would appear
twice.

### Human control

Each session carries an **epoch** that every human gesture bumps — a click,
a key, a scroll, a toolbar action — and a call that settles under a different
epoch than it started returns `interrupted_by_human`, which the harness sees in
the tool result. There is no allowance for the agent's own input: the shell's
relay reports a guest's `before-input-event`, which input synthesized over CDP
never fires, so a person clicking while `browser_click` runs interrupts it.

In-app, the toolbar moves the pane's webview itself (`loadURL`, back, forward,
reload, stop; http(s) and `about:blank` only) and the server only hears about
it; the server never runs
agent-browser for the human, since a CDP reload of a webview reloads the whole
window. In owned mode the toolbar goes through the server, which has the only
handle on that browser.

A failed attach leaves the thread's state at `error`; the agent got the same
message as its tool result. The pane's Retry is a `reload` gesture: in-app it
only clears the error — the agent's next call attaches afresh, and nothing
starts agent-browser for the human — while in owned mode, with no browser
open, it starts one.

Observed navigation is reported as a passive `location` input, which never
marks human control — otherwise the agent's own navigations would look like a
takeover.

Teardown runs off `thread.deleted` / `thread.archived`, because the engine is
the only writer of durable thread state. It takes its turn in the thread's
queue, so a call in flight finishes first, then closes the driver and
publishes `stopped`; a call that queued behind it finds the thread closed and
opens nothing.

### Daemons

No agent-browser daemon outlives what started it
(`apps/server/src/browser/agentBrowser.ts`, `BrowserService.ts`):

- **Boot.** Building the service runs `close --all` in our namespace beside the
  rest of the build — the daemons a crashed or SIGKILLed run left behind. It
  waits (up to 3 s) for them to leave `session list`, since `close --all`
  answers before they exit, kills what is still listed, and removes the
  namespace's leftover `.config` / `.target` files. The first driver waits for
  it, so a restarted thread never races its old daemon for the same socket.
- **Shutdown.** Closing the service's scope — SIGINT from the desktop's
  supervisor on quit — closes every open driver at once, bounded to 4 s, inside
  the 5 s the supervisor gives before its SIGKILL. What that SIGKILL cuts short,
  the next boot reaps.
- **A hung command.** A command that runs past its timeout closes its driver
  and the thread's state goes to `error` with the message; the next call opens
  a fresh one. A driver's close is `close` with 3 s to answer; a daemon that
  does not is SIGKILLed through the pid it wrote to its socket directory
  (`~/.agent-browser/namespaces/<ns>/run/<session>.pid`, the directory
  `session info` reports) — only if that pid is still an agent-browser process,
  and its children first, which in owned mode is the Chrome it launched.

---

## 11. The terminal

Each thread has a terminal drawer at the bottom of its column: real shells,
running on the server in the thread's workspace, shown in xterm. The New task
page has one too, before any thread exists: its shells belong to the picked
project and run in the project's folder.

### Opening one

`Cmd+J`, the palette's "Toggle terminal" and the "Terminal" button on the strip
the closed drawer collapses to, at the bottom of the thread column
(`terminal-bar.tsx`), all fire the same command, `terminal.toggle`; the open
drawer's own "Hide terminal" button closes it. The command is answered by
`ThreadTerminal` (`apps/web/src/components/terminal/owned-terminal.tsx`),
which is always mounted with the thread view — or, on the New task page, by
`ProjectTerminal` — so the button and the chord take one path — the one that
also moves focus into the terminal it opens. Whether a thread's (or a
project's) drawer is open, and how tall the drawer is, is presentation state in
localStorage (`apps/web/src/state/terminal-ui.ts`). The drawer is at least
120px tall and at most 70% of the column, and never so tall that the
conversation above it gets less than 120px: the header and composer keep their
height, so the drawer measures them (`use-drawer-bound.ts`) and is shown at the
stored height or that bound, whichever is lower — the way the dock always
leaves the thread column its minimum width, even after the window shrinks. On
a window too short for both floors the drawer keeps its 120px, and the xterm
fits the rows it can show.

A drawer that opens with no terminals starts one, once `terminal.list` has
said there are none and the xterm has measured the grid to start it at. The
client mints the `TerminalId`, so `terminal.open` is idempotent: a repeated
open answers the shell already running under that id instead of starting a
second one. The New tab button is disabled at `TERMINALS_PER_OWNER` (8), its
tooltip saying so, and the server refuses a ninth with `conflict`; an exited
terminal still counts until it is closed. A long tab title shrinks, truncating,
before the strip overflows, though never so far that "Terminal 3" loses its
number; past that the strip scrolls sideways, fades at an edge with more tabs
beyond it, and turns a vertical mouse wheel into a sideways scroll.

Every terminal has an owner (`TerminalOwner` in
`packages/contracts/src/terminal.ts`): a thread, whose payloads carry
`threadId`, or a project with no thread yet, whose payloads carry `projectId`
in its place. The New task page's draft id is never used as an owner — the
thread it becomes may run in a new worktree, and the server has no thread by
that id until it is sent. On the server, `TerminalService`
(`apps/server/src/terminal/TerminalService.ts`) keys its registry by
`terminalOwnerKey`, so a project's terminals and its threads' are separate
sets, and asks `workspaceOf` for the directory: for a thread, its workspace
root from `threadWorkspaceRoot` — its worktree when it has one, its project's
folder otherwise — refused as `not-found` for a deleted thread, and as
`invalid` for an archived one or a folder that no longer exists on disk; for a
project, its folder, refused as `not-found` once the project is removed and as
`invalid` when the folder is gone.

A project's terminals follow the first message. When the New task page starts
a local thread — no worktree, so it works in the folder those shells run in —
the client calls `terminal.adopt` right after `thread.create` and before it
opens the thread, and the service hands every terminal the project owns,
running or exited, to the thread: same ids, same scrollback, the summary now
naming the thread. `adoptionCheckOf` refuses a missing or removed project, a
thread in its own worktree, one of another project, an archived or missing
one, and one that has already started — a turn running or queued, or
anything in its timeline — and the move is refused
whole if it would take the thread past `TERMINALS_PER_OWNER`. It takes both
owners' locks, in one fixed order, then moves every session in one
synchronous step, so no reader finds a terminal under both owners or under
neither. A session keeps its shell and hub, so a live subscriber streams on;
calls under the project answer `not-found` from then on. A worktree thread
takes nothing: the shells stay the project's, still running in its folder.

On the client the hand-over is `useTerminalHandOver`
(`apps/web/src/components/terminal/use-terminal-hand-over.ts`), which the New
task composer awaits between creating a local thread and sending its first
message; the order is `runHandOver` in `terminal-hand-over.ts`. An open drawer
whose listing says it has no terminals starts one, and once the shells have
moved the project's listing is empty — a refetch answered before adopt's
reply, or a reconnect after the socket dropped with the reply in flight, can
bring that listing at any moment. So the project's drawer is closed before
adopt is called, noting whether it was open and which terminals the project
had, and the client state follows only once the move is known: the drawer's
tabs and the one in front (`handOverDrawerState` in `drawer-state.ts`), then
an open drawer on the thread. When adopt fails or its reply is lost, the
thread's own listing (`listTerminals`) decides: terminals the project had
there mean the move went through, and the state follows as if adopt had
answered; none mean the shells stayed, and a drawer that was open on them
opens again; no listing either leaves the project's drawer closed and the
thread's drawer to find whatever the server gave it. The thread's drawer then
finds the terminals on its first listing, with the same one in front.

Shells a project still owns — left behind by a worktree thread, or started on
the New task page again later — are counted where they can be found:
`ProjectTerminalsBadge` (`project-terminals-badge.tsx`), a stock `Badge` with
the running count and a tooltip such as "2 terminals running in this
project's folder", sits beside the New task header's terminal toggle and on
the project's sidebar row, and shows nothing while none is running. It
counts the project's `terminal.list`, reread on connecting, after every open,
close, exit the drawer sees and hand-over, and on a return to the window —
once per project, since both badges share its list atom and its return
refetch (`useSharedWindowReturn` in `apps/web/src/lib/window-return.ts`).
A thread's own running shells show on its sidebar row instead:
`ThreadTerminalsMark` (`thread-terminals-mark.tsx`) puts a small terminal
icon beside the title, with the count when more than one runs, and a tooltip
naming them by title ("Running: Terminal 1, Terminal 2") — a terminal summary
carries no foreground command. The rows do not list their threads one by one:
they all read `terminal.listRunning`, every thread's running terminals in one
call, through `useThreadRunningTerminals` (`use-running-terminals.ts`), which
picks each row's out of it. That one listing is reread on the same triggers as
the project's — an open, close or hand-over of any owner's terminal, an exit
the drawer sees, a reconnect, a return to the window — so a long sidebar costs
one call per refetch, not one per row.

The shell comes from `resolveShell` in
`apps/server/src/terminal/shell.ts`: `$SHELL` when it is an absolute path,
else `/bin/zsh` on macOS and bash (or `sh`) on Linux, with `-l` so it reads the
user's profile — an app launched from the Finder has only launchd's bare
`PATH`, and a login shell is what gives it the one the user sees in their own
terminal. On Windows it is `COMSPEC`, else `powershell.exe`. `terminalEnv`
starts from the server's environment and takes out what belongs to Poseidon:
`ELECTRON_RUN_AS_NODE`, which the desktop app sets to run the server under its
Electron binary and which would turn every Electron-based CLI started from the
shell into plain Node, and every `POSEIDON_*` key. Under an AppImage it also
removes the AppImage runtime's variables and its mount point's entries from the
search paths. It sets `TERM=xterm-256color`, `COLORTERM=truecolor` and
`TERM_PROGRAM=Poseidon`, and on macOS an unset `LANG` becomes `en_US.UTF-8`.

`apps/server/src/terminal/pty.ts` starts the shell in a pseudo-terminal through
`@lydell/node-pty`, loaded on the first spawn rather than at boot. A module that
fails to load makes that open fail `unavailable` ("terminal support failed to
load: …") and is tried again on the next one; the rest of the server never
notices. A shell that cannot be started fails `internal`, naming the file.

`terminal.write` runs whatever it is sent in the user's shell. It rides the
same loopback, token-authenticated WebSocket that already accepts
`orchestration.dispatch`, so it exposes nothing that socket did not already
reach.

### Output

Everything the shell prints takes one path, synchronous inside the pty's data
callback (`apps/server/src/terminal/session.ts`). The batcher
(`batcher.ts`) holds output for `TERMINAL_BATCH_MS` (16ms) after the first
chunk, or sends at once when a batch reaches `TERMINAL_BATCH_CHARS` (64K
chars), so a shell writing a byte at a time is not a frame per byte; a batch
never ends between the halves of a surrogate pair. Each batch is appended to
the scrollback first and then published on the terminal's hub with the
scrollback's new `offset` — the total number of chars the terminal has ever
produced.

The scrollback (`scrollback.ts`) keeps the last `TERMINAL_SCROLLBACK_CHARS` (1M
chars). Past that the oldest output goes, and what remains starts after its
first newline, so a replay begins at the start of a line rather than in the
middle of an escape sequence. It lives in memory only.

`terminal.subscribe` sends a `snapshot` first — the terminal's summary, its
scrollback and that scrollback's offset — then live `output`, then `exited`
when the shell ends, and then the stream ends. The server subscribes to the hub
_before_ it reads the scrollback, so output written in between is in both, and
drops any `output` at or below the snapshot's offset; read the other way round,
it would be in neither. A subscriber that falls behind its budget
(`TERMINAL_STREAM_BUDGET_ITEMS` 4096, `TERMINAL_STREAM_BUDGET_BYTES` 4 MiB) is
sent `resnapshot-required` instead of a growing backlog. Terminal output is
never merged the way timeline items are: every item is a boundary.

On the client, `terminalAttachAtom` (`packages/client-runtime/src/terminalAtoms.ts`)
hands every item to a callback in order. It is a callback-running
`runtime.fn`, not an atom over the stream, because an atom built from a stream
keeps only the last item of each chunk, and a terminal that loses a chunk of
output paints garbage. It subscribes again after `resnapshot-required` or a
dropped socket, treats the end after `exited` as final, and turns a server
`not-found` into a client-only `gone`. The xterm
(`apps/web/src/components/terminal/terminal-view.tsx`, fed by
`terminal-feed.ts`) resets to each `snapshot` and drops output the snapshot
already holds. xterm parses writes from a queue that `reset()` leaves alone, so
the reset waits until everything written before the snapshot has been parsed;
otherwise output the old subscription had queued would land on the fresh
screen above the snapshot. Items arriving meanwhile are held and written after
it. Until the queue has drained and the snapshot has been parsed, the xterm's
own answers are not sent: the old output and the replay contain the shell's old
terminal queries (colours, cursor position), and xterm would otherwise answer
each of them to the shell as fresh input. The user's keys and pastes come out of
the same `onData` and are still sent; the feed tells them apart by shape, since
each answer is one whole report sequence of the few kinds xterm sends
(`isTerminalReport`).

Input goes through one lane per terminal, so keys typed while a write is in
flight follow it in order as the next write, split at `TERMINAL_WRITE_MAX_CHARS`
if a paste is larger. A write that fails takes with it the input queued behind
it when it left, the rest of a split paste above all, so that never reaches the
shell later with the next key; a terminal answered `not-found` drops its whole
lane. The xterm fits itself to the drawer and sends a resize, debounced by
100ms and only when the grid changed; only the latest pending size is sent.

The theme is read from our own tokens at runtime
(`apps/web/src/components/terminal/terminal-theme.ts`): background,
foreground, cursor and selection are resolved to RGBA through a 1×1 canvas,
because the tokens are `oklch(…)` and xterm cannot parse that, and are read
again when the theme changes. The block cursor is the foreground with the
character under it in the background, so the character stays readable. The 16
ANSI colours stay xterm's own palette, which is tuned for a dark background;
xterm's `minimumContrastRatio` (4.5, WCAG AA) lifts any of them too faint
against the background as it draws, so white and bright yellow stay readable
on the light theme.

### Reattaching

A terminal outlives its subscribers. Switching threads unmounts the drawer:
the xterm is disposed and the subscription ends, but the shell keeps running.
The tabs are kept in memory per thread (`drawer-state.ts`, in a `keepAlive`
map), and the drawer's open state is in localStorage, so coming back shows the
same tab in front, and the new subscription starts with a snapshot of
everything the shell printed meanwhile, up to the scrollback bound. A reload
works the same way, from `terminal.list`. A server restart ends every shell:
the listing comes back empty, the attach reports `gone`, and the tab drops.

The drawer shows the tab in front in an xterm of its own; switching tabs
disposes it and starts a fresh one from the other terminal's snapshot, so
output still queued for the old xterm, and xterm's answers to queries in it,
never reach the other terminal. An exited
terminal stays listed, marked "exited", with its final output, until it is
closed, so the last thing a command printed is still readable.

### Teardown

A shell ends on `terminal.close` — closing a tab, and closing the last tab
hides the drawer — on `thread.deleted` and `thread.archived` for a thread's,
and `project.removed` for a project's own, which the service watches on the
engine's event stream the way the browser pane's teardown does, and when the
server shuts down. Killing is bounded: SIGHUP, what a closing
terminal sends, then after one second SIGKILL to the shell, to every process
under it and to every process group they are in, and at most two seconds more
waiting for the exit (the `ps` read below is bounded at two seconds too). The
shell has job control on, so each job runs in a group of its own and SIGKILL to
the shell's group alone would miss it; the processes under the shell come from
one `ps -A -o pid=,ppid=,pgid=` read while the shell is still alive (`apps/server/src/terminal/reap.ts`), since once it dies its jobs
are re-parented to init and nothing ties them to it. The kill cannot be
interrupted: `terminal.close` takes the terminal out of the registry before
killing it, so a client that cancels the call or disconnects during the grace
second would otherwise leave a shell that ignores SIGHUP with nothing left to
reach it. A shell that obeys SIGHUP
passes it on to its jobs itself; a job started with `nohup` keeps running, as
it would after closing any terminal.

### Keys, links, find and quoting

While a terminal has focus, the one keybinding listener considers only
`terminal.toggle` and leaves every other chord to the shell (§12), so `Escape`
reaches vim rather than interrupting the turn. The xterm refuses the toggle's
own chord through `attachCustomKeyEventHandler`, so it bubbles to that listener
instead of reaching the shell — off macOS `Ctrl+J` would otherwise be a line
feed.

A printed http(s) link opens on a mod-click (`Cmd` on macOS, `Ctrl`
elsewhere) and nowhere else: a plain click in a terminal places the selection.
It opens in the thread's own browser pane — the dock switches to its Browser
tab and the pane is sent a human `navigate`, as its address bar would send
(`use-open-link.ts`, `terminal-links.ts`). On the New task page there is no
thread, so no browser pane: a link opens in the system browser.

Find is a row under the drawer's toolbar (`terminal-find.tsx`) that searches
the xterm in front as the user types: Enter for the next match, Shift+Enter for
the previous one, Escape to close it and return focus to the terminal. Match
highlights are our foreground mixed into our background, since xterm's search
addon takes only opaque `#rrggbb`.

"Add selection to chat" quotes the terminal's selection into the composer
draft on screen — the thread's, or the New task page's (`appendQuotedBlock` in `apps/web/src/lib/quote-selection.ts`):
the padding xterm adds to each selected line and any blank lines around the
text are trimmed, each line gets `> `, and a blank line separates the block
from text already in the draft and from what the user types next. It writes
the per-thread draft the composer renders from, then moves focus to the
composer's input with the caret after the quote, so the user can type the
question straight away.

---

## 12. Settings

### The document

Settings are server-owned. The renderer reads them with `settings.get`, watches
`settings.subscribe`, and patches with `settings.update`, so a change made in
one window shows up in the other. The schema is
`packages/contracts/src/settings.ts`; the store is `SettingsStore` in
`apps/server/src/rpc/services.ts`, which persists the whole document as one
JSON row in the `settings` table.

```
Settings
  connectors         ConnectorInstanceConfig[]  id, kind, displayName, enabled, config
  defaults           { model, effort, runtimeMode }
  theme              system | light | dark
  chatWidth          comfortable | wide | full  the thread column's max width
  keybindings        Keybinding[]               the user's overrides on DEFAULT_KEYBINDINGS
  keybindingsFormat  "overrides"                absent on a document from before overrides
  permissions        PermissionRule[]           a projection of the permission_rules table
  git                { branchPrefix }           what a new worktree's branch starts with
  projectSettings    { [projectId]: { setupScript? } }
  browser            { openPaneOnAgentUse }     off by default
  notifications      { finished, failed, needsYou, sound, dockBadge, keepAwake }
  preferredEditor    string?                    the "Open in" button's editor; unset until picked
```

`git` and `projectSettings`, like the two font sizes, are defaulted on decode
(`poseidon/` and `{}`), so a row written before they existed still reads. So is
`browser`, whose `openPaneOnAgentUse` comes back as `false`, and `chatWidth`,
which comes back as `comfortable`.
`notifications` is defaulted the same way: every alert, the Dock badge and
keep-awake on, the sound off. `preferredEditor`
is a plain string, not the editor id enum, so an id a later build drops still
decodes; the client treats an id it does not know, or one not detected on this
machine, as unset.

`chatWidth` sets how far the thread column runs. One helper,
`chatWidthClasses` in `apps/web/src/lib/chat-width.ts`, maps it to literal
Tailwind max-width classes for the timeline (`max-w-[700px]` when comfortable)
and for the composer, the start screen and the harness banner
(`max-w-[684px]`), so all of them stay aligned; `wide` is 960px / 944px and
`full` lifts the cap. It is picked with the Chat width toggle on Settings →
General, beside the font sizes, and stepped by the palette's "Cycle chat width"
(`chatWidth.cycle`, unbound by default); Reset appearance puts it back on
`comfortable`.

Settings → Notifications (`apps/web/src/components/Settings/notifications-panel.tsx`,
linked from the settings sidebar and the command palette) edits it: a checkbox
each for a thread finishing, failing and needing you (an approval, a question
or a plan ready), the sound, the Dock badge (marked desktop-only in a browser)
and "Keep the Mac awake while agents run", under which a muted line says
whether the desktop app is holding the machine awake now
(`keepAwakeHoldingAtom`), or that it is not because the switch is off. The server merges a patch one key deep, so each click
sends the whole `notifications` object. In a plain browser whose page has not
been asked yet, an "Allow browser notifications" button requests permission;
the app never asks on its own.

`git` and `projectSettings` are edited on the Git & worktrees page. The branch prefix saves on blur,
Enter or Save, trimmed, and only when it changed; a prefix git would refuse
(a leading `-` or `/`, spaces, `..`, `@{`, `~^:?*[\`) is named under the input
and not saved, though `git.worktree.create` still has the last word. A setup
script is saved per project, but a patch replaces the whole key, so the page
writes the whole `projectSettings` record, rebuilt from the latest document at
the moment of the click (`apps/web/src/components/Settings/git-settings.ts`):
editing one project keeps every other project's script, and a blank script
removes the project's entry.

Every field carries a `settingsForm` annotation — label, description, control —
so the settings pages render from the schema and cannot drift from it. A
connector's `config` is its own document: the connector's definition owns the
schema, annotates its fields the same way, and the server describes the
resulting form (with the connector's name, icon key and docs link) over
`connectors.describe`. A new connector needs no connector-specific markup and
no change to the contracts package.

`permissions` is a projection, not a second store: the `permission_rules` table
is the single source of truth, and a settings update that carries a
`permissions` array replaces the table wholesale, because editing the list in
the UI is a whole-document operation.

The whole document is written at once, so `update` holds a mutex — a
read-modify-write that yielded in the middle would lose the other writer's
fields entirely.

### Keybinding defaults

`DEFAULT_KEYBINDINGS` in `packages/contracts/src/keybindings.ts`. An empty
"when" means the binding holds everywhere.

| area     | command                                               | shortcut                      | when                                                                                   |
| -------- | ----------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| General  | `commandPalette.toggle`                               | `Mod+K`                       |                                                                                        |
| General  | `shortcuts.open`                                      | `Mod+/`                       |                                                                                        |
| General  | `settings.open`                                       | `Mod+,`                       |                                                                                        |
| General  | `skills.open`                                         | `Mod+Shift+S`                 |                                                                                        |
| General  | `mcp.open`                                            | unbound                       |                                                                                        |
| General  | `project.add`                                         | `Mod+Shift+O`                 |                                                                                        |
| General  | `sidebar.undo`                                        | `Mod+Z`                       | `!inputFocus && !terminalFocus && !browserFocus && !dialogOpen`                        |
| Threads  | `thread.new`                                          | `Mod+N`                       |                                                                                        |
| Threads  | `thread.newInProject`                                 | `Mod+Shift+N`                 |                                                                                        |
| Threads  | `thread.jump.1` … `thread.jump.9`                     | `Mod+1` … `Mod+9`             |                                                                                        |
| Threads  | `thread.previous` / `thread.next`                     | `Mod+Shift+[` / `Mod+Shift+]` |                                                                                        |
| Threads  | `thread.nextAttention`                                | `Mod+Alt+J`                   |                                                                                        |
| Threads  | `thread.rename`                                       | `Mod+Alt+R`                   | `threadOpen`                                                                           |
| Threads  | `thread.archive`                                      | `Mod+Shift+A`                 | `threadOpen`                                                                           |
| Threads  | `thread.delete`                                       | `Mod+Alt+Backspace`           | `threadOpen`                                                                           |
| Threads  | `thread.pin`                                          | `Mod+Shift+P`                 | `threadOpen`                                                                           |
| Threads  | `nav.back` / `nav.forward`                            | `Mod+[` / `Mod+]`             | `!browserFocus`                                                                        |
| Composer | `composer.planMode.toggle`                            | `Shift+Tab`                   | `composerFocus`                                                                        |
| Composer | `composer.runtimeMode.cycle`                          | `Mod+Shift+L`                 |                                                                                        |
| Composer | `composer.modelPicker.open`                           | `Mod+Shift+M`                 |                                                                                        |
| Composer | `composer.effortPicker.open`                          | `Mod+Shift+E`                 |                                                                                        |
| Composer | `composer.effort.increase` / `decrease`               | `Mod+Shift+.` / `Mod+Shift+,` |                                                                                        |
| Composer | `composer.focus`                                      | `Mod+L`                       | `!browserFocus`                                                                        |
| Composer | `composer.queue`                                      | `Mod+Enter`                   |                                                                                        |
| Composer | `thread.interrupt`                                    | `Escape`                      | `turnRunning && !dialogOpen && (composerFocus \|\| (!inputFocus && !approvalPending))` |
| Composer | `composer.attach`                                     | `Mod+U`                       |                                                                                        |
| Composer | `composer.clearDraft`                                 | `Mod+Shift+Backspace`         | `composerFocus`                                                                        |
| Composer | `composer.startInBackground`                          | `Mod+Alt+Enter`               | `newTaskOpen`                                                                          |
| View     | `sidebar.toggle`                                      | `Mod+B`                       |                                                                                        |
| View     | `dock.toggle`                                         | `Mod+Alt+B`                   | `threadOpen \|\| newTaskOpen`                                                          |
| View     | `dock.changes` / `dock.files`                         | `Mod+Shift+D` / `Mod+P`       | `threadOpen \|\| newTaskOpen`                                                          |
| View     | `browserPane.toggle`                                  | `Mod+Shift+B`                 |                                                                                        |
| View     | `terminal.toggle`                                     | `Mod+J`                       |                                                                                        |
| View     | `font.increase` / `decrease` / `reset`                | `Mod+Alt+=` / `-` / `0`       |                                                                                        |
| View     | `chatWidth.cycle`                                     | unbound                       |                                                                                        |
| View     | `editor.openFavorite`                                 | `Mod+O`                       | `threadOpen`                                                                           |
| Timeline | `timeline.jumpToLatest`                               | `Mod+Shift+J`                 | `threadOpen`                                                                           |
| Timeline | `timeline.collapseAll` / `expandAll`                  | `Mod+Alt+[` / `Mod+Alt+]`     | `threadOpen`                                                                           |
| Timeline | `timeline.previousMessage` / `nextMessage`            | `Alt+Shift+ArrowUp` / `Down`  | `threadOpen && !inputFocus`                                                            |
| Timeline | `timeline.find`                                       | `Mod+F`                       | `threadOpen && !terminalFocus && !browserFocus && !filesFocus && !dialogOpen`          |
| Git      | `git.commit`                                          | `Mod+Alt+C`                   |                                                                                        |
| Git      | `git.push`                                            | `Mod+Alt+P`                   |                                                                                        |
| Git      | `git.branchPicker`                                    | `Mod+Shift+G`                 |                                                                                        |
| View     | `browser.focusUrl`                                    | `Mod+L`                       | `browserFocus`                                                                         |
| View     | `browser.reload`                                      | `Mod+R`                       | `browserFocus`                                                                         |
| View     | `browser.back` / `browser.forward`                    | `Mod+[` / `Mod+]`             | `browserFocus`                                                                         |
| Cards    | `approval.allowOnce` / `allowSession` / `allowAlways` | `1` / `2` / `3`               | `approvalPending && !inputFocus && !dialogOpen`                                        |
| Cards    | `approval.deny`                                       | `D`, `Escape`                 | the same                                                                               |
| Cards    | `plan.accept` / `acceptAndRun` / `revise`             | `1` / `2` / `3`               | `planPending && !inputFocus && !dialogOpen`                                            |
| Cards    | `question.option.1` … `question.option.9`             | `1` … `9`                     | `questionPending && !inputFocus && !dialogOpen`                                        |

Enter sends and Shift+Enter inserts a newline. In the `/` and `@` menus,
Up/Down or Tab/Shift+Tab move, Enter picks and Escape closes. With no menu
open, a bare Up in an empty composer recalls the thread's last sent message
(its text and its `@`/`$` references, not `#` chips or images), further Ups
walk to older ones while the caret is on the first line, and Down on the last
line walks back and finally empties the composer. Editing a recalled message
makes it an ordinary draft, and the arrows move the caret again
(`prompt-history.ts`, `use-prompt-recall.ts`). These keys are not in the table, because they depend on the menus and on IME composition, so
the composer's own key handler keeps them (`composer-keys.ts`). The command
catalog lists them as `FIXED_KEYS`, for display only.

The chords stay clear of the macOS system shortcuts, the Electron default menu
and the standard text-editing chords. The app sets no application menu, so the
Electron default one is live: Mod+R reloads, Mod+=/-/0 zoom, Mod+W closes. Font
size therefore uses `Mod+Alt+=`/`-`/`0`. When macOS Accessibility zoom is
turned on (it is off by default), it takes those same chords first.

The font keys step the main and sidebar text sizes together by half a pixel,
each clamped to 11–20px, and reset puts both back on 14px. They write the
settings document through the same `useFontSizes` hook as the Appearance
steppers, so the steppers follow. `chatWidth.cycle` steps the chat width
Comfortable → Wide → Full and round again, through the same `useChatWidth` hook
as the General page toggle, once the settings document has loaded.
`timeline.collapseAll` and `expandAll` set
every disclosure in the open thread: tool, reasoning, file-change, task and
plan rows, turn folds, work groups and the rows folded in them, task
children, turn summary cards and answered-decision records (`disclosureIds`
in `components/timeline/disclosure.ts`). The ids come from the timeline built
with every turn fold open, so expanding all opens each settled turn's fold
and the work groups inside it in one go, and collapsing all closes them.
Most of those folds sit above the viewport, and the list's own scroll
anchoring does not cover rows added or removed, so neither key hands the
scroll to the reader as opening one fold does (`send-anchor.ts`): a list
following at its end stays at its end, and otherwise the row the reader was
on is held where it sat on screen — or, when collapsing folded away every
row on screen, the nearest row above them, usually the fold that hid them,
goes to the top — until the rows stop moving or the reader scrolls.

The git keys belong to the thread header, or the New task page's when that is
on screen. `git.commit` is the Commit button
and `git.push` is Commit & push, which pushes straight away when there is
nothing to commit (`git-actions-control.tsx`); `git.branchPicker` opens the
branch popover (`branch-picker.tsx`). Each does nothing from its key while its
control is disabled, and none is answered outside a repository. `git.commit`
and `git.push` also do nothing while the commit or pull request dialog is up
(`gitStartOf` in `apps/web/src/lib/git-actions.ts`): they fire from inside the
dialog's message box, and reopening it would drop the typed message and the
unticked files. `editor.openFavorite` is the thread header's "Open in" button,
answered only while that button is shown, that is while the server has
detected an editor.

`Mod+Z` is reserved for undo and redo, and the sidebar takes it over only
under the `sidebar.undo` clause, where no text is focused. In the composer,
any other text field, the terminal and the browser pane, `Mod+Z` still undoes
typing. Outside them it undoes the latest sidebar action: archive, pin or
unpin, mark unread, or rename. The listener's `preventDefault` keeps the
Electron default Edit menu from taking the key first. The undo stack holds
the newest 20 entries, in memory only (`components/sidebar/sidebar-undo.ts`).
An archive toast's Undo takes its own entry off the same stack, so the toast
and the key never undo one action twice. `sidebar.undo` and `thread.pin`
(which pins or unpins the open thread) are answered by
`components/sidebar/triage-shortcuts.tsx`, and each is claimed only while it
can act.

`RESERVED_KEYBINDINGS`, in the same module, holds chords for features that are
still being built, so that nothing ships on them first. Nothing dispatches
these rows. They exist so the collision test can treat each one as a binding.

| command          | shortcut          | when | for                                   |
| ---------------- | ----------------- | ---- | ------------------------------------- |
| `composer.steer` | `Mod+Shift+Enter` |      | Steer the running turn with the draft |

Two further rules reserve keys without a row:

- Chords scoped to `terminalFocus` are the terminal's to choose. They still
  have to pass the collision test.
- `@`, `#`, `$` and `/` are characters that the composer's triggers read, so
  they are never bindings.

The four `browser.*` bindings answer only while focus is in the browser pane
(`browserFocus`). A focused `<webview>` never delivers key presses to the host
window, so inside a pane page the desktop shell matches the same chords
(`guestChordsFor`) and relays the command, and a relayed `browser.reload` keeps
the default menu's reload from also firing (see
[the browser pane](#10-the-browser-pane)).

`packages/client-runtime/src/default-keymap.test.ts` locks the table. It fails
the build, on either platform, in these cases:

- two defaults share a physical chord in contexts that can overlap;
- a default collides with a reserved row;
- a default takes a system-reserved chord;
- Tab, Enter, Space or a plain arrow is bound without a clause that needs a
  text field;
- a plain or Shift-only printable key has a clause that neither needs a text
  field nor rules one out with `!inputFocus`;
- anything plain or Shift-only is bound on a trigger character;
- a shortcut or a clause fails to parse.

Every command has an entry in `COMMAND_CATALOG`
(`apps/web/src/lib/command-catalog.ts`). The entry holds the command's title,
its area (General, Threads, Composer, View, Timeline, Git or Cards), an optional
description and icon, and a `palette` flag. Commands with no default chord,
such as `mcp.open`, have entries too. A test fails when a default command has
no entry. Labels show a command's chord with `CommandKbd command="…"`, which
reads the effective table, so a hint always shows the key the user actually
bound.

`shortcuts.open` shows the keyboard shortcuts sheet
(`apps/web/src/components/keybindings/shortcuts-dialog.tsx`), mounted once at
the app root beside `AppShortcuts`. It lists every catalog command, grouped by
area in catalog order, with each chord the effective table binds to it (so a
user override shows as the user bound it, and a command with no chord says
"unbound") and the `when` clauses those chords carry. The `FIXED_KEYS` rows
follow the Composer commands. Each word of a search must match a row: it
occurs in the title, the id, the description or a `when` clause; or it is a
whole chord, either as drawn (`⌘K`) or in keymap notation with any alias the
matcher accepts (`mod+k`, `cmd+k`, `ctrl+k`), compared as the keys held on this
platform; or it is one keycap or one modifier of a chord. So `cmd shift b` finds
`Mod+Shift+B`, and `cmd+shift+b` does not find `Mod+Shift+Backspace`
(`cheatsheetSections` in `apps/web/src/lib/cheatsheet.ts`).
The palette offers it as "Keyboard shortcuts", and Settings → Keybindings has a
button that fires the same command.

The matcher is `packages/client-runtime/src/keybindings.ts`:

- **Notation.** `Mod` is the platform modifier: Meta on macOS and iOS, Ctrl
  elsewhere, so one stored binding works on every keyboard. `Cmd` and `Meta`
  are aliases of it, so a table stored as `Cmd+…` keeps working, and the
  recorder writes `Mod+…`. `Ctrl` always means the physical Control key.
  Off macOS the notation has no token for Super/Win, so the recorder ignores
  a press with it held rather than store a chord that fires on another key.
- **Exact modifiers.** `Escape` does not fire on `Shift+Escape`, and `Mod+K`
  does not fire on `Mod+Alt+K`.
- **Layout-safe keys.** With Alt or Shift held, `event.key` is often not the
  key's own character: macOS Option+R reports `®`, Shift+[ reports `{`. So a
  chord with Alt or Shift also matches on the key `event.code` names (`KeyR` →
  `r`, `BracketLeft` → `[`), and the recorder writes that key, storing
  `Mod+Alt+R` rather than `Mod+Alt+®`. A reported letter or digit is trusted as
  it is, so on AZERTY a chord on A does not fire on the key at `KeyQ`. A digit
  chord also matches its number-row key (`Digit1` → `1`) whatever that key
  types: on AZERTY the unshifted key types `&`, so `Mod+1` and the cards' `1`
  fire there too, and the recorder writes `Mod+1` for that press.
- **AltGr.** A press where AltGr is typing a character resolves to nothing
  (`isAltGraphTyping`): the event reports the AltGraph modifier, or, off macOS,
  Ctrl and Alt are held and the key typed a printable character that is not its
  own. AltGr+C typing `ć` on a Polish layout never fires `Mod+Alt+C`.
- **`when` clauses** read context flags with `!`, `&&`, `||`, parentheses and
  `==`/`!=`. An unknown flag is false, and an unparseable clause disables its
  binding rather than misfiring.
- **The text-field rule.** While `inputFocus` is true, a binding fires only if
  its chord has Mod or Ctrl, its key is Escape or F1–F24, or its `when` clause
  cannot hold outside a text field: it is false whenever `inputFocus`,
  `composerFocus` and `terminalFocus` are all false (`whenNeedsTextFocus`). A
  plain key, Shift+key, Alt+key, Tab, Enter or an arrow never fires while the
  user is typing unless its clause names the field it acts in, as `Shift+Tab`
  with `when: composerFocus` does (`firesInTextField`). Naming a focus key only
  to rule it out is not enough: a plain key under `!browserFocus` or
  `threadOpen && !terminalFocus` still stays out of text fields.

The context keys a clause may name are listed, with what each means and who
sets it, in `KEYBINDING_CONTEXT_KEYS` (`packages/client-runtime/src/keymap.ts`).
The listener computes `inputFocus`, `composerFocus`, `terminalFocus`,
`browserFocus`, `filesFocus`, `dialogOpen` and `isMac` from the keypress; components publish
`threadOpen`, `newTaskOpen`, `dockOpen`, `changesOpen`, `turnRunning` (`threadRunning` is an alias),
`approvalPending`, `questionPending` and `planPending`. `CONTEXT_AXIOMS`
records what always holds between them: `composerFocus` and `terminalFocus`
each imply `inputFocus`; focus is in at most one of the composer, the terminal,
the browser and the Files pane; at most one of an approval, a question and a plan is pending;
a thread and the New task page are never on screen together; `isMac` is fixed
per platform.

Conflicts are found by the same module, per platform
(`findKeybindingConflicts`). Two rows for different commands conflict when they
are the same physical chord on that platform — off macOS `Mod+K` and `Ctrl+K`
are the same keys, on macOS they are not; and with Shift held a shifted
character is its own key, so `Mod+Shift+{` is `Mod+Shift+[` and `Shift+?` is
`Shift+/`, as the matcher fires both on one press (`unshiftedKey`) — and their
contexts can hold at once. `reservedChordReason` reads chords the same way. Each row's context is its clause plus the implicit `!inputFocus` the
text-field rule adds to a plain chord; `whenOverlaps` decides by brute force
over the flags both clauses name, skipping assignments the axioms rule out, so
`1` for an approval and `1` for a plan never conflict, and neither conflicts
with a `1` bound only in the composer. A `x == "v"` comparison counts as an
independent flag, which can only report more conflicts, never fewer.
`SYSTEM_RESERVED_CHORDS` lists, per platform and with a reason, the chords the
operating system, the text system or the Electron default menu already owns —
quit, close, hide, reload, devtools, zoom, the editing and text-navigation
chords, and on macOS the Cocoa `Ctrl+letter` editing keys — and
`reservedChordReason` looks one up. Given a row's clause, it lets through the
chords the app takes over on purpose: `Mod+R` under `browserFocus` reloads
the pane's page, not the window, and `Alt+ArrowUp`/`Down` — caret moves that
mean nothing outside a text field — step through the Changes pane's files
under `changesOpen && !inputFocus && !dialogOpen` (`CHANGES_PANE_KEYS`).

The context for each press is built by `apps/web/src/lib/keybinding-context.ts`:
`focusSnapshot` reads whether the focused element is a text field, its closest
`data-context` (`FOCUS_SURFACE`: `composer`, `terminal`, `browser`, `files`) and
whether a dialog, alert, menu, menubar or listbox is on screen. Both composers
set `composer` on their textarea, and the browser pane sets `browser` on its
root, so its address bar and toolbar read as `browserFocus` and keep `Mod+L`,
`Mod+[` and `Mod+]` from the app. The terminal drawer sets `terminal` on its
root, and the dock's Files tab sets `files` on its root, so `Mod+F` in its
search field is left to the field rather than to the thread's find. `keybindingContext` answers the
built-in keys from that snapshot and the platform, and every other key from the
registry under its canonical name, so an older stored clause naming
`threadRunning` still reads `turnRunning`. A component cannot publish a
built-in key. Who publishes the rest:

| key                                                 | published by                                                   |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `threadOpen`, `dockOpen`                            | `ThreadView`, while mounted / while the dock is                |
| `newTaskOpen`, `dockOpen`                           | the New task page, with a project / its dock                   |
| `changesOpen`                                       | `ChangesPane` or `ProjectChangesPane`, while the dock shows it |
| `turnRunning`                                       | `Composer`                                                     |
| `approvalPending`, `questionPending`, `planPending` | `PendingCard`, for exactly the card it shows                   |

There is exactly one listener, mounted at the app root
(`apps/web/src/lib/shortcuts.tsx`). It runs in bubble phase so focused controls
get first refusal and it skips `defaultPrevented`, repeated, IME-composing and
AltGr-typing events — the composer's trigger menu eats `Escape` before it
arrives, so the global table only ever sees what nothing closer to the focus
wanted. The interaction cards' keys are table rows like any other (§5, §6),
kept apart from each other and from `thread.interrupt` by their `when` clauses,
not by listening first. A focused terminal goes further: inside
`[data-context="terminal"]` the listener only considers `terminal.toggle` and
leaves every other chord to the shell without calling `preventDefault`, so
`Escape` reaches vim instead of interrupting the turn, and `Mod+K` and `Mod+B`
reach the program running there (`yieldsToTerminal` in
`apps/web/src/lib/keybindings.ts`). A surface that owns a command registers a handler
while it is mounted, and a surface that is not mounted does not answer its
command: `thread.interrupt` belongs to the composer, so it is inert on the
settings page rather than reaching into a thread nobody is looking at.
Registration is a stack per command id, so two surfaces claiming the same id
hand it back in order instead of blanking it
(`apps/web/src/lib/command-registry.ts`).

The settings document stores only the user's overrides, never a copy of the
defaults — a copy would pin an install to the keymap of the build that wrote
it, and a shortcut added later would never reach it. The rule is per command
(`resolveKeymap` in `packages/contracts/src/keybindings.ts`):

- When the overrides mention a command at all, its default rows are dropped and
  its override rows are its bindings.
- A `-X` row (VS Code's convention) mentions `X` without binding it, so on its
  own it unbinds `X`. Its shortcut is the chord it removed, kept for display.
- The effective table is the override rows first, then the defaults of every
  command the overrides do not mention. Resolution is first-match, so an
  override shadows another command's default on the same chord.
- An override for a command no default names is kept, and is inert until
  something registers that command.

So an empty list means "every default", and it is what a fresh install writes.

Settings → Keybindings is the editor
(`apps/web/src/components/keybindings/keybindings-editor.tsx`, one command per
`keybinding-row.tsx`). It has one section per area and one row per catalog
command, plus an "Other" section for rows that name a command this build does
not know; those stay visible and removable, and do nothing. A row shows the
command's title and id, a "Modified" badge when its bindings differ from the
defaults, and one line per binding: the chord (click, then press the new
keys), its `when` clause as an editable field whose info tooltip lists
`KEYBINDING_CONTEXT_KEYS`, and a remove button. "Add" records another chord for
the command, and a command with none says "Unbound". A warning icon on a line
names what is wrong, on this platform:

- a conflict: another command's binding on the same physical chord whose
  context can hold at the same time (`findKeybindingConflicts`), and which of
  the two fires first there;
- a system chord (`reservedChordReason`), which the OS or the Electron shell
  may take before the app sees it;
- a clause that does not parse, which disables the binding.

A chord that does not parse is marked "invalid chord".

The draft is the effective table, and every edit is normalised
(`apps/web/src/lib/keybinding-draft.ts`): it is diffed against the defaults and
resolved again, so the rows are in the order they will have after a reload —
an override comes before the default it may shadow — and a command edited back
to its defaults stops being an override. Reset on a row drops that command's
overrides; "Reset all", behind a confirmation, drops them all. Nothing is
stored until Save, which posts `diffKeymap(DEFAULT_KEYBINDINGS, draft)`: a
command left at its default stores nothing and keeps following the defaults,
and a command whose last row was removed is stored as `-X` and stays unbound.
Revert goes back to what is stored. The page also has a button that opens the
shortcuts sheet, and says which key `Mod` is on this computer.

`keybindingsFormat: "overrides"` marks a document written this way. A document
without it is from before overrides and holds the whole keymap of its build.
Such a table was brought up to that build's keymap once by the
`0006_terminal_keybinding` migration, which appends `terminal.toggle` →
`Cmd+J` where neither the command nor the chord was taken, so the frozen copy
ends with that row. `SettingsStore`'s load migrates it (`migrateLegacyKeybindingTable`, comparing
against a frozen copy of that old keymap): a command still bound exactly to its
old default gets no override and follows the defaults from now on, one missing
from the table gets a `-X` row, one with different rows keeps them, and rows for
any other command are kept. The old keymap had no clauses, so a kept row with
none, on a chord a default of its command now binds with a clause, takes that
clause: a user who added a second chord to `thread.interrupt` keeps `Escape`
scoped as shipped, and an approval card still answers Escape with deny. The first write persists the migrated
form with the marker; until then the same row migrates to the same answer on
every start. The `keybindings.get`/`update` RPCs kept their shape, so there was
no protocol bump — an older server's full table still resolves to the same
keys, because each of its rows replaces only its own command's defaults.

The dock keys once defaulted to `when: threadOpen`, and the editor keeps a
row's clause when its chord is rebound, so a stored override of `dock.toggle`,
`dock.changes` or `dock.files` could still carry that clause and stay dead on
the New task page. The `0007_dock_keys_new_task` migration rewrites exactly
those rows — one of the three commands, with a clause that is exactly
`threadOpen` — to `threadOpen || newTaskOpen`, once; any other clause is the
user's own and is left alone.

### Connector instances

`ConnectorManager` treats the settings document as desired state and the
registry's open instances as actual state. A new or edited entry is probed —
always, because the connectors page wants binary state even for a disabled
instance — and opened when enabled; a toggled one is closed or reopened; a
removed one's scope is closed, which deregisters it. `connectors.list` answers
from the last reconcile's probes, and `refresh: true` reconciles and re-probes,
which is what the page's probe button and every save do. A probe gets 15 s
before it is reported as an error.

Routing follows the settings document's order, not the order instances happened
to be opened in — the same reading a new thread's default model is seeded from,
so the two can never name different instances. That order is the fallback: a
thread that chose its instance runs on it, and is seeded from its default or
first model, while it is open.

### The CLI's own config files

Two files in the user's own space are written by Poseidon, both marked and both
put back.

**`<workspaceRoot>/.commandcode/settings.local.json`** gets the PreToolUse hook
block while a session is open (`packages/connector-cmd/src/config.ts`):

```json
{ "matcher": ".*", "hooks": [{ "type": "command", "command": "<hookPath>", "timeout": 590 }] }
```

The merge preserves every other key and every other hook entry. Ownership is
decided per _hook command_, so a user hook sharing an entry with ours survives
removal. Teardown is guarded twice: the install records the hash of the bytes it
wrote and reverts only while the file still hashes to that, and a per-path
retain count keeps the first session to close from pulling the hook out from
under a second session in the same project. While the block is in place, a
line in the repository's `info/exclude` keeps the file out of `git status` and
of every commit — the hook it names is this machine's — and the teardown takes
that line out again. A file that exists but is not strict JSON is never
rewritten — the session runs without the gate and says so.

**The local MCP scope** gets an `poseidon` entry. That file lives at
`~/.commandcode/projects/<slug>/mcp.json`, and the slug is a private rule the
CLI owns, so **the CLI writes it**: `cmd mcp add-json --scope local`, and `cmd
mcp remove` to take it back. Writing it ourselves put the entry beside the
directory the harness reads whenever the workspace path has a camel hump or an
underscore in it, which silently offered the model no browser tools at all in
those projects. The entry is removed by name, so a server the user added under
any other name is untouched.

The Customize page edits a different pair of files through the connector's
MCP servers extension (`packages/connector-cmd/src/mcpServers.ts`):
`~/.commandcode/mcp.json` for user scope and `<workspaceRoot>/.mcp.json` for
project scope. The page asks by instance id — `connectors.mcp.list`, `.add`,
`.remove` — and `apps/server/src/settings/ConnectorExtensions.ts` finds the open
instance, turns the `projectId` into its workspace root and calls the
extension; an instance without it answers `unavailable`, and the page shows a
section only for the enabled instances whose `ConnectorSummary.extensions` says
they have one. Ownership there is per entry — every server Poseidon writes
carries an `_poseidon` marker — and add/remove refuse to touch an entry without
it. Disabling is a move, not a
flag: Command Code launches everything under `mcpServers` and ignores keys it
does not know, so a disabled server's definition is parked verbatim under
`_poseidonDisabled`. A file that cannot be parsed is never rewritten; listing
reports no servers for it and writes fail with a `conflict` naming the file,
because a rewrite would be built from an empty base and would delete every
server the user hand-authored.

**Skills** are discovered, not written: the skills extension
(`packages/connector-cmd/src/skills.ts`), asked through `connectors.skills.list`,
walks `~/.commandcode/skills` and `<workspaceRoot>/.commandcode/skills`, reads
the `name` and `description` out of each `SKILL.md` frontmatter, and lets a
project skill win a name collision, matching the harness's own precedence. The
composer's `/` popover asks the thread's own instance for that list. The one
write is a link: `connectors.skills.available` lists the skills in
`~/.agents/skills` the instance does not load yet, and `connectors.skills.link`
symlinks one into `~/.commandcode/skills`. Those homes follow the instance's
`extraEnv.HOME` when it sets one, since that is the home the CLI resolves.

**Plugins** have an extension of their own, read-only, for a harness that has
them: `connectors.plugins.list` answers each installed plugin's name,
description, source, scope and whether it is enabled. Command Code has no
plugins, so its instance answers `unavailable`, and the client runtime's
`pluginsAtom` reads that as an empty list rather than an error.

### Attention

`AttentionCoordinator` (`apps/web/src/components/attention/attention-coordinator.tsx`,
mounted once at the root) turns thread-list updates into alerts, with the
decisions kept pure in `apps/web/src/lib/attention.ts`. Each update is diffed
against the last list seen, and each thread reports at most one event per
diff, the loudest: **failed** (any status became `error`), **needs you** (an
approval, a question or a ready plan opened, or a different one replaced it)
or **finished** (a `running` or `waiting` thread went `idle` with nothing
open). The first loaded list only seeds the baseline, and the baseline outlives
a reconnect — the list reads `null` while loading and that is skipped — so a
reload or a replayed snapshot never alerts, and an approval that stays open
alerts once. A new, archived or deleted thread says nothing.

An event whose switch is on goes out one of three ways: nothing for the thread
on screen in a focused window; a sonner toast for another thread while the
window is focused, carrying the sidebar's status mark (a check for finished),
the title and an **Open** action; a system notification when the window is
unfocused or hidden, whose click focuses the window and opens the thread. In a
plain browser the notification only fires if the page already has permission.
Notifications are posted silent, and with the sound on the coordinator beeps
once per batch — the system beep in the desktop app, a short WebAudio blip in
a browser.

The same list drives the shell: the Dock badge counts the threads that need
you (0 clears it, as does turning it off); keep-awake holds a
`prevent-app-suspension` blocker while any thread is `running` and writes the
answer to `keepAwakeHoldingAtom`; and the count of threads running or waiting
on you goes to the quit guard (section 14). A closed window or a crashed
renderer never clears these itself, so the desktop main process drops the
blocker, the badge and the busy count when the window's page goes away; the
next window's coordinator sets them again.

**Next needing attention** (`thread.nextAttention`, `Mod+Alt+J`, also in the
palette) opens the most recently updated thread that needs you, else the most
recently updated unread one, never the open thread nor an archived one
(`nextAttentionThread`). It is claimed only while such a thread exists, so the
palette never offers it with nowhere to go.

---

## 13. Crash and recovery

### A session that dies

A child that dies on a signal nobody asked for ends the session with reason
`crashed` (`packages/connector-cmd/src/session.ts`), and a session whose event
stream simply ends is treated the same way — the process is gone either way
(`SessionManager`). `makeSessionSupervisor`
(`apps/server/src/orchestration/SessionSupervisor.ts`) watches the lifecycle
channel and, on `crashed`:

1. appends a visible `thread.error` — "the agent process exited unexpectedly;
   reconnecting" — because without it the answer just stops mid-sentence;
2. runs the resume loop: `SessionManager.ensure` with the persisted
   `sessionRef`, up to 4 attempts with a 250 ms base delay doubling per
   attempt;
3. writes `thread.session.lost` when the attempts run out.

A `stopped` end is deliberate and restarts nothing.

`thread.session.bound` landing while a turn is still in flight means a resume:
the reactor re-sends the turn, and the turn-scoped handle dedupes a turn it
already has, so the fresh-session path costs nothing.

### Resuming the harness

Continuing a conversation means handing the next process `--session <id>`. The
persisted `CmdSessionRef` is `{ sessionId, transcriptPath, cwd, lastMessageId }`.

A run killed by SIGINT never writes its transcript, so the id its `run_start`
announced names a session that no longer exists:

```
Error: --session "<id>" is neither an existing .jsonl transcript nor a known session-id prefix.
```

and the next spawn exits 1 before emitting a frame. Pressing Stop therefore used
to break a thread permanently. `packages/connector-cmd/src/sessionRef.ts` asks
the filesystem the same question the harness asks before it builds an argv, and
continues in a **new** session with a `session.warning` when there is no
transcript to resume.

A resumed session also catches its translator up before its first turn: it folds
the transcript up to `lastMessageId` without emitting anything. Everything after
that marker is work nobody has been shown and the tailer delivers it; everything
before is history. Without the marker the `run_end` reconcile would re-emit the
whole conversation with fresh item ids.

### A server that restarts

At layer build, the supervisor scans the thread read model **inline** — at real
boot the database is the only state that exists, so "running with no session"
genuinely means lost, and forking the scan would let live dispatches interleave.
A thread that is running or waiting with no `sessionRef` gets
`thread.session.lost` immediately; one with a `sessionRef` gets a resume loop on
its own fiber, so a slow connector does not hold the build.

The renderer's half is §2: a changed `serverInstanceId` discards every cached
snapshot, because the new instance never issued the sequence numbers the old
ones are positioned at.

Terminals do not come back. Their shells died with the old process and their
scrollback was only ever in its memory, so the drawer's tabs drop out on the
next `terminal.list` and a terminal still attached reports `gone` (§11).

### Projections

`threads.doc_json` holds a `ThreadDoc` with no schema of its own, so the engine
stamps the `PROJECTOR_VERSION` that wrote each set of rows. At boot, a mismatch
throws the projections away and re-folds every stream from the event log inside
one transaction. The log is the source of truth, so a rebuild is always safe —
and a stale document is never served.

Migrations are numbered, contiguous from 1, and never edited once merged; a
lineage test enforces both. `0005_events_type_index` exists because the
checkpoint reactor's boot replay used to schema-decode every thread event ever
written _before_ the handshake, and the supervisor kills a child that has not
handshaken in 15 s — a large enough log made the app permanently unstartable
over data that was perfectly intact.

### An unreadable settings row

A settings row that no longer decodes does not take the app down. `load` in
`apps/server/src/rpc/services.ts` serves `defaultSettings()` and keeps the raw
text. The first write that replaces the row copies the old text into a
`settings.unreadable` row **in the same transaction** — the write that destroys
the undecodable document is exactly when the copy has to become durable.

---

## 14. Shutdown

Quitting is held open on purpose (`apps/desktop/src/main/quit.ts`):

```
before-quit
  │ preventDefault(); hide the windows
  ▼
ServerSupervisor.stop()      SIGINT to the child, SIGKILL after 5s
  │                          resolves when the child is really gone
  ▼                          (or after the injected deadline, whichever first)
app.exit()
```

`quit.ts` is Electron-free and takes the deadline as a dependency; the value it
is given is `QUIT_DEADLINE_MS` = 15s, declared and passed in
`apps/desktop/src/main/index.ts`.

Signalling and walking away used to leave the server reparented and still
running — it closes sessions one at a time, each spawning `cmd mcp remove` — and
holding `~/.poseidon/state.sqlite` against the next launch. A second quit while
the app waits falls straight through to Electron, so a wedged server cannot make
the app unquittable.

Before any of that, the quit guard (`apps/desktop/src/main/quitGuard.ts`)
asks the window first when the renderer has reported threads running or
waiting on you: `QuitGuardDialog`
(`apps/web/src/components/attention/quit-guard-dialog.tsx`) lists them with
their status marks, **Quit anyway** carries on into the shutdown above and
Cancel or dismissing keeps the app open. A second quit while that question is
open passes straight through. With nothing busy, or no window to ask, quitting
works as before. On Windows and Linux, where closing the last window quits,
that close is held while threads are busy and turned into a quit, so the same
dialog asks first and closing the window again while it is open quits.

On the server side, closing `boot`'s scope shuts everything down. Three
finalizers matter — the sockets', the sessions' and the terminals':

- the WebSocket sockets are destroyed first. `http.Server.close()` waits for
  every open connection to end by itself, and a WebSocket never does, so a
  server with a renderer attached would otherwise never finish closing.
- `SessionManager` closes every open session. Session driver scopes are
  free-standing — a session outlives the command that started it — so nothing
  used to close the ones still open at shutdown, and their finalizers never
  ran: every server exit left the hook block and an `poseidon` MCP entry naming
  a dead port behind, one per session, in files the user owns.

Closing one session is ordered: the handle first, so the connector emits
`session.ended`; then the ingestion fiber's drain, which reports the real
reason; then the scope. Closing the scope first would interrupt the drain,
report `crashed`, and have the supervisor resurrect a session that was
deliberately stopped. A connector whose event stream outlives its close gets
5 s before the scope is closed under it.

`TerminalService`'s finalizer ends every open terminal, all at once: it refuses
new opens from then on, and kills each shell the way closing its tab does —
SIGHUP, then SIGKILL to the shell and everything under it after a second, each
wait bounded — so no shell or job started from one outlives the server and a
wedged pty cannot hold the shutdown up.

---

## Where to look next

| area                                   | start here                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the pieces, one by one                 | [architecture.md](architecture.md)                                                                                                                                    |
| the rules and where they are enforced  | [philosophy.md](philosophy.md)                                                                                                                                        |
| running, testing, packaging            | [development.md](development.md)                                                                                                                                      |
| the CLI on the far end                 | [command-code-connector.md](command-code-connector.md), [claude-code-connector.md](claude-code-connector.md)                                                          |
| commands, events, read models          | `packages/contracts/src/orchestration.ts`                                                                                                                             |
| the connector-neutral event vocabulary | `packages/contracts/src/runtime.ts`                                                                                                                                   |
| the RPC surface                        | `packages/contracts/src/rpc.ts`                                                                                                                                       |
| the composition root                   | `apps/server/src/boot.ts`                                                                                                                                             |
| the decider                            | `apps/server/src/orchestration/decider.ts`                                                                                                                            |
| the integrated terminal                | `apps/server/src/terminal/TerminalService.ts`, `apps/web/src/components/terminal/owned-terminal.tsx`                                                                  |
| the Command Code session               | `packages/connector-cmd/src/session.ts`                                                                                                                               |
| what the real CLI does                 | `packages/testkit/fixtures/cmd/README.md`                                                                                                                             |
| the product, end to end                | `apps/server/test/e2e/` — eleven scenarios over a real server and a real socket; the ten with a harness run the real CLI (`POSEIDON_LIVE_CMD=1`) or a recording of it |
| the same, on Claude Code               | `apps/server/test/e2e-claude/` — the Claude connector's scenarios, replayed, live (`POSEIDON_LIVE_CLAUDE=1`) or recorded (`POSEIDON_RECORD_CLAUDE=1`)                 |
