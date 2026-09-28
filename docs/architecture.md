# Architecture

Poseidon is a desktop application that drives an agentic coding CLI and gives it
a real interface: a sidebar of projects and threads, a streaming timeline,
approval cards, a diff pane, a browser pane, a file pane, an integrated
terminal, settings.

Nothing above the connector boundary knows which CLI is running. A _connector_
owns a harness — how to find its binary, how to spawn it, how to translate what
it emits into the `RuntimeEvent` vocabulary — and everything else is written
against that vocabulary. Three connectors ship today:
`packages/connector-cmd`, for the Command Code CLI (`cmd`),
`packages/connector-claude`, for the Claude Code CLI (`claude`) driven through
the Claude Agent SDK, and `packages/connector-codex`, for the Codex CLI
(`codex`) over its app-server.

This document describes the pieces and how they connect, written against the
code as it stands. Its companions:
[how-it-works.md](how-it-works.md) traces what happens at runtime,
[philosophy.md](philosophy.md) says which of these shapes are rules and where
they are enforced, [development.md](development.md) is how to run and check the
thing, and [command-code-connector.md](command-code-connector.md),
[claude-code-connector.md](claude-code-connector.md) and
[codex-connector.md](codex-connector.md) are what the `cmd`, `claude` and
`codex` CLIs actually do.

## Processes

Three processes of our own, plus three kinds of child the server starts: a
`cmd` per turn, `agent-browser` per browser call, and a login shell per open
terminal. It also launches the editor, file manager or terminal app a person
opens a workspace in, and lets go of it at once.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Electron main — apps/desktop/src/main                               │
│   window + poseidon:// protocol + IPC + will-attach-webview policy   │
│   ServerSupervisor — apps/desktop/src/backend/ServerSupervisor.ts   │
└──────┬────────────────────────────────────────┬─────────────────────┘
       │ spawn, handshake on fd 3               │ preload bridge (IPC)
       ▼                                        ▼
┌──────────────────────────────┐      ┌──────────────────────────────┐
│ server — apps/server         │ ws   │ renderer — apps/web          │
│ Effect · SQLite · HTTP + WS  │◄─────┤ React · TanStack Router      │
│   /ws  /healthz  /mcp        │      │ atoms · timeline · composer  │
│   /hooks/pretooluse          │      │ right dock                   │
└───┬───────────┬─────────────┬┘      └──────────────────────────────┘
    │ spawn     │ execFile    │ pty
    │ per turn  │ per call    │ per terminal
    ▼           ▼             ▼
 cmd child  agent-browser   login shell, in the
            browser pane,   project folder
            browser_* tools
```

**Electron main → server.** `ServerSupervisor` spawns the server as a child
with `stdio: ["ignore", "inherit", "inherit", "pipe"]` — fd 3 is the handshake
pipe. The server writes one JSON line to fd 3 (`writeHandshake` in
`apps/server/src/rpc/bootstrap.ts`) carrying `{ url, token, serverInstanceId }`,
and falls back to stdout when fd 3 is not a handshake pipe — including when the
process has a node IPC channel, which also lands on fd 3. The supervisor reads
at most 64 KiB waiting for that line, gives up after 15 seconds, restarts on crash
with 500ms→10s backoff, and after five consecutive failures stops and reports
instead of spinning (`onRepeatedFailure`, wired to a dialog in
`apps/desktop/src/backend/serverDeps.ts`).

What is spawned is in `apps/desktop/src/backend/serverArgs.ts`: the packaged
`out/server/main.cjs` under `ELECTRON_RUN_AS_NODE`, or in dev
`node --import <tsx loader> apps/server/src/main.ts`. The `--import` form
matters — the `tsx` CLI re-execs node, and the grandchild does not inherit
fd 3.

**Electron main → renderer.** The renderer is served from the app's own
`poseidon://app/` scheme with SPA fallback (`apps/desktop/src/main/protocol.ts`,
`rendererRequest.ts`). The preload bridge
(`apps/desktop/src/preload/bridge.ts`) exposes `getConnection`,
`getServerState`, `onServerState`, the browser-pane guest channel and the
attention seam (`attention`: notify, badge, beep, keep-awake, busy count,
notification clicks and the quit request, wrapped for the renderer with
plain-browser fallbacks in `apps/web/src/lib/desktop-attention.ts`); it is
built against a three-member `PreloadIpc` interface so it can be tested without
Electron.

**Renderer → server.** One WebSocket to `ws://127.0.0.1:<port>/ws?token=…`. The
token is the boot token from the handshake, compared in constant time
(`apps/server/src/rpc/server.ts`); anything else gets 401 before the RPC
protocol runs. `packages/client-runtime/src/resolver.ts` finds the credentials:
the preload bridge first, then the dev endpoint `GET /__poseidon/connection`
served by the Vite plugin in `apps/web/vite.config.ts` out of
`~/.poseidon/dev/connection.json`, then `?server=&token=` search params.
Credentials are re-read on every connect attempt, because a supervisor restart
means a new port, a new token and a new `serverInstanceId`.

**Server → CLI.** One child process per turn. Command Code's print mode is one
turn per process, so `send` spawns `cmd -p "<prompt>" --session <id> …`,
`detached` so it leads its own process group and interrupt/close can signal the
group.

**Server → agent-browser.** `execFile` in argv form, never a shell, one
invocation per call against a named session
(`apps/server/src/browser/agentBrowser.ts`). The Rust daemon underneath
persists between invocations.

**Server → editor.** `editors.open` starts the app a person picked in argv
form with `shell: false`, `detached` and unreferenced, never waited on
(`apps/server/src/editors/`). The command comes only from what detection found
— an app bundle in `/Applications` or `~/Applications`, the CLI inside it or
on `PATH`, or the platform's own opener — and the one argument a client shapes
is the target: a path held inside the thread's workspace root lexically and
through `realpath`, passed absolute so it can never read as a flag. The child's
environment is the server's without `ELECTRON_RUN_AS_NODE`, which the packaged
server runs under and which would start an Electron editor as bare node.

**Server → shell.** One login shell per open terminal, started in a
pseudo-terminal by `@lydell/node-pty` (`apps/server/src/terminal/pty.ts`). A
terminal belongs to a thread, and starts in the thread's workspace (its
worktree, else its project's folder), or — on the New task page, before any
thread exists — to a project, and starts in the project's folder, or — in
first-run setup, before any project exists — to home (`{ home: true }`), and
starts in the user's home folder. A shell lives until its terminal is closed,
its thread is deleted or archived (its project removed, for a project's own),
or the server shuts down; switching threads or reloading the renderer leaves
it running. When the New task page starts a
local thread — one working in the project's folder — `terminal.adopt` hands
the project's terminals to it, shells and scrollback intact.

## Workspaces

A pnpm workspace driven by turbo. Packages are scoped `@poseidon/*` and consumed
through their `exports` map, one entry per module; apps are unscoped.

| Directory                   | Package name                 | What it is                                                 |
| --------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `apps/desktop`              | `desktop`                    | Electron main, preload, server supervisor, platform glue   |
| `apps/web`                  | `web`                        | The renderer: routes, atoms, timeline, composer, panes     |
| `apps/server`               | `server`                     | The Effect server: store, orchestration, RPC, gateways     |
| `packages/contracts`        | `@poseidon/contracts`        | Schemas: ids, enums, runtime, orchestration, settings, rpc |
| `packages/connector-sdk`    | `@poseidon/connector-sdk`    | What a connector is, and the suite every one must pass     |
| `packages/connector-cmd`    | `@poseidon/connector-cmd`    | The Command Code connector                                 |
| `packages/connector-claude` | `@poseidon/connector-claude` | The Claude Code connector                                  |
| `packages/connector-codex`  | `@poseidon/connector-codex`  | The Codex connector                                        |
| `packages/client-runtime`   | `@poseidon/client-runtime`   | Connection, folds and atoms shared by any client           |
| `packages/shared`           | `@poseidon/shared`           | Ids, paths, permission patterns, image sniffing            |
| `packages/ui`               | `@poseidon/ui`               | The base component set and its styles                      |
| `packages/testkit`          | `@poseidon/testkit`          | Recordings, the replayer, the fake connector, test helpers |
| `packages/config`           | `@poseidon/config`           | The shared `tsconfig.base.json`                            |

## Boundaries

`scripts/check-boundaries.mjs` enforces five rules over the tree, and it is part
of `pnpm check`. The rules are pure functions in `scripts/boundary-rules.mjs`,
tested by `scripts/boundary-rules.test.mjs`, which `pnpm check:boundaries` runs
before the walk.

**1. Import allowlist.** A workspace may import itself and whatever the table
says; anything else fails. A workspace with no rule may import no workspace
package at all. The rule applies however the import is spelled — `from`, bare
`import`, dynamic `import()`, `require()`, and template literals with a static
package segment.

| Workspace                 | May import                                    |
| ------------------------- | --------------------------------------------- |
| `apps/web`                | `ui`, `contracts`, `client-runtime`, `shared` |
| `apps/desktop`            | `contracts`, `shared`                         |
| `apps/server`             | `contracts`, `connector-sdk`, `shared`        |
| `packages/connector-sdk`  | `contracts`, `shared`                         |
| `packages/connector-*`    | `connector-sdk`, `contracts`, `shared`        |
| `packages/contracts`      | `shared`                                      |
| `packages/client-runtime` | `contracts`, `shared`                         |
| `packages/testkit`        | `contracts`, `connector-sdk`, `shared`        |
| `packages/shared`         | nothing                                       |
| `packages/ui`             | nothing                                       |
| `packages/config`         | nothing                                       |

Test files under `apps/server` get five extras: `testkit`, `client-runtime`,
`connector-cmd`, `connector-claude` and `connector-codex`. Test files under
`packages/connector-claude` get `testkit`, for the `sdk-stream` replayer and
tee their recordings go through, and so do those under
`packages/connector-codex`, for the `stdio-jsonrpc` replayer. Test files under `apps/desktop` get
`testkit`, so the browser bridge's tests read the agent-browser recordings
through `@poseidon/testkit/recording`. A file counts as a test when
`.test.`/`.spec.` precedes its extension, or when any path segment is `test` —
which is how the end-to-end harness under `apps/server/test/e2e/` qualifies.
Keeping them out of the production list is what makes an accidental import in
`apps/server/src/main.ts` fail: `apps/server` is bundled to a single file for
packaging, and testkit must never ship. One production file has extras of its
own: `apps/server/src/boot.ts`, the composition root, may import
`connector-cmd`, `connector-claude` and `connector-codex` to build the
registry. Every other
server file reaches a connector through the registry.

A relative specifier that climbs out of its own workspace directory is a
violation whatever it lands on. `../../../packages/testkit/src/receipts` is a
boundary crossing wearing a path.

**2. Connector leaks.** Non-test sources under `apps/web`,
`packages/client-runtime` and `apps/server` — `boot.ts` aside — import no
`@poseidon/connector-*` package other than `connector-sdk` and contain no quoted
connector kind (`"cmd"`, `"claude"`, `"codex"`, `"opencode"`, any quote style).
A connector kind travels as data, from the registry and `connectors.describe`;
code that compares against one by name is branching on a harness. The one
exemption is by exact path, with its reason beside it:
`packages/client-runtime/src/keybindings.ts`, where `"cmd"` is the Command key.

**3. Renderer connector-neutrality.** The strings `command code` (spaced or
not), the quoted literal `"cmd"`, and `claude`, `codex` and `opencode` as words
must not appear anywhere under `apps/web/src` — in any file, whatever its extension, and in file names as well
as contents. One path is exempt, `apps/web/src/components/ui/icons`, so a
connector's own logo can ship under its own name: `brand-icons.ts` there maps a
connector's `iconKey`, an editor and a model's provider to the Honeyicons logo
or glyph the renderer draws, and nothing outside it names a harness.
The renderer renders whichever connector is configured; a connector's name in a
CSS class, an SVG title or a JSON label breaks that as surely as one in a string
literal. This is why a connector's name, icon key and docs link arrive as
`ConnectorMetadata` over `connectors.describe`, and a failing probe's own help
link as `ConnectorProbe.helpUrl`, rather than being written into a component.
The contracts package names no connector either: there is no kind constant and
no connector config schema in it.

**4. Reference names.** The products Poseidon was compared against while it was
built are not named anywhere in `apps/`, `packages/`, `scripts/` or the
top-level `docs/*.md`, in file names or contents, in any case. The recordings
of real runs under `packages/testkit/fixtures/`, `node_modules`, build output
and the local `docs/plans/` are skipped.
The guard keeps the names base64-encoded so that it does not spell them.

**5. No barrels.** An `index` module anywhere under `packages/` is refused —
`.ts`, `.tsx`, `.js`, `.jsx` or `.mjs`: a package exports one entry per module
through its `exports` map. Apps are exempt — the router's
`apps/web/src/routes/settings/index.tsx` is a route, and the Electron entry
points are named by electron-builder.

A second guardrail, `scripts/check-file-sizes.mjs`, caps non-test source files
at 800 lines and renderer components under `apps/web/src/components` at 400.

## The apps and packages, one by one

### apps/desktop

Owns the operating system. Nothing about orchestration lives here.

- `apps/desktop/src/main/index.ts` — single-instance lock, privileged scheme registration,
  supervisor start, window creation, quit handling (`quit.ts`, with a 15s
  deadline for the server child). Its one `before-quit` listener asks the
  quit guard first (`quitGuard.ts`, Electron-free): while the renderer
  reports threads running or waiting on the user, the first quit is held and
  the window gets `poseidon:quit-request`; its `poseidon:quit-answer` either
  quits (through `quit.ts` as before) or clears the hold, and a second quit
  while it is asking goes straight through. On Windows and Linux, where
  closing the last window quits, that close is held while threads are busy
  and turned into a quit the guard asks about (`holdsWindowClose`); a close
  that is part of a quit already past the guard is never held. With no
  window to ask the quit is not held.
- `apps/desktop/src/main/attention.ts`, `attentionChannels.ts`,
  `attentionIpc.ts` — the attention seam. The renderer decides when a thread
  needs the user; main carries it out for a `window` sender only, after the
  Electron-free parsers in `attention.ts` (a notice's thread id must match the
  bridge's thread-id pattern, its text is capped, counts are clamped):
  `poseidon:attention-notify` posts a silent system notification, held until
  it is clicked or closed, whose click shows and focuses the window and sends
  `poseidon:open-thread`; `-badge` sets `app.setBadgeCount` (0 clears);
  `-beep` is `shell.beep()`; `-keep-awake` holds at most one
  `prevent-app-suspension` power-save blocker (released on `will-quit`) and
  answers whether it is held; `-busy` stores the count the quit guard reads.
  When the window's page is destroyed (the window closed while the app keeps
  running on macOS) or its renderer crashes, main lets go of the blocker,
  clears the badge and zeroes the busy count itself, since a torn-down page
  never runs its own release (`releaseWhenPageGone`).
  The channel names sit alone in `attentionChannels.ts` because the sandboxed
  preload bundles them and `attention.ts` pulls in `node:crypto`.
- `apps/desktop/src/main/protocol.ts` — the `poseidon://app/` scheme.
- `apps/desktop/src/main/webview.ts` — the `will-attach-webview` policy for the browser
  pane. Only `persist:thread-*` partitions may attach, with an http(s) or
  `about:blank` src, and the handler overwrites the guest's `webPreferences`
  rather than only refusing bad ones, so a guest that reaches that point still
  runs sandboxed, context-isolated, without Node and without a preload. Popups
  are the one capability a pane tab opts into (`allowpopups`); see
  [The browser bridge](#the-browser-bridge) for where they go.
- `apps/desktop/src/main/ipc.ts` — the preload bridge's handlers, and the one-time
  setup of every pane guest at `web-contents-created`: its window-open
  handler, the human-input relay (`browser/guestInput.ts`:
  `before-input-event` and `before-mouse-event` on the guest are the only place
  a pane gesture is observable; each is sent to the guest's current embedder
  tagged with its thread and `webContents` id, and the renderer forwards it as
  `browser.humanInput`), the pane's keys (`browser/guestChords.ts`, below), and
  the bridge registry.
  It also answers `poseidon:browser-clear-thread` (`browser/clearThread.ts`):
  the window asks it to clear a deleted thread's `persist:thread-<id>`
  partition (storage and cache), and main checks the id against the bridge's
  thread-id pattern before it names a partition, drops the thread's
  browser-bridge connections, and leaves alone a partition that was never
  written to disk. `poseidon:browser-clear-all` is the Browser
  settings page's "Clear browsing data": every `thread-<id>` directory under
  `Partitions`, cleared the same way. `poseidon:browser-clear-stale` takes the
  ids of every thread that still exists and clears each `thread-<id>`
  directory not among them, refusing an empty list and clearing nothing when
  `POSEIDON_HOME` is not the default home (`homeOwnsPartitions`).
  `poseidon:browser-capture` answers a PNG of a pane tab by its guest's
  `webContents` id, for "screenshot to chat". Clear-all, clear-stale and
  capture answer only a `window` sender, and capture only a registered pane
  guest.
  A key pressed inside a pane page goes to the guest and never reaches the
  window's keybinding listener, so the window hands main its resolved
  `browser.*` chords on `poseidon:browser-chords` (only a `window` sender may,
  and `parseChords` keeps at most 32 well-formed `browser.*` entries), and the
  guest's `before-input-event` matches each keyDown against them with the pure
  `decideChord`: a match is `preventDefault`ed and relayed to the embedder as
  `poseidon:browser-command {threadId, wcId, command}`, once per press, not on
  auto-repeat. The app installs no menu, so Electron's default one is live and
  its Reload (`Cmd+R`, `Cmd+Shift+R`; `Ctrl` off macOS) reloads the whole
  window — every pane tab with it; those chords are swallowed inside a guest
  whether or not anything binds them.
- `apps/desktop/src/main/browser/` — the browser bridge: the scoped CDP
  endpoint agent-browser drives the pane webviews through
  ([below](#the-browser-bridge)). `upgradeGate.ts`, `cdpPolicy.ts`,
  `bridgeSession.ts`, `server.ts`, `tabsChannel.ts`, `guestChords.ts` and
  `agentPointer.ts` are Electron-free;
  `guests.ts` is the Electron side (the `GuestPort`), written against
  Electron's types with its runtime pieces injected; `start.ts` starts it from
  `index.ts`.
- `apps/desktop/src/main/updater.ts` — an update-check stub that does nothing.
  The app has no update feed, and no UI or menu offers updates;
  `POSEIDON_UPDATER=1` only logs that no feed is configured.
- `apps/desktop/src/backend/` — `ServerSupervisor`, the spawn spec, the public server state
  the renderer sees.
- `apps/desktop/src/platform/` — per-platform window defaults, lifecycle, and
  `browserBridge.ts`: whether the bridge starts (the `POSEIDON_REMOTE_DEBUG=0`
  kill switch) and the remote-debugging switches stripped from the command
  line.

Public seam: the preload bridge object, whose shape the renderer declares in
`packages/client-runtime/src/resolver.ts`. May import `contracts` and `shared`
only; must never import the server, the connector packages or the renderer.

### apps/web

The renderer. TanStack Router routes under `apps/web/src/routes`, state through
`@effect/atom-react`, components under `apps/web/src/components`.

| Route                             | What it is                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `_home/index`                     | the New task page: start a thread, pick a project; `?pane=` carries the project dock's tab                |
| `_home/t/$threadId`               | the thread view; `?pane=` carries the dock tab                                                            |
| `_home/customize/*`               | skills, MCP servers and plugins: what extends the agent, one tab per kind                                 |
| `settings`, nine pages            | general, models, connectors, keybindings, permissions, git & worktrees, browser, archived threads, import |
| `browser.$threadId`               | the browser pane on its own, against a real `browser.subscribe`                                           |
| `dev/{timeline,composer,changes}` | fixture pages, DEV only                                                                                   |

The shell is a left sidebar (projects → threads), the thread column (the
timeline, then the composer with any open approval, question or plan card
docked above its input, and while subagents run an "N agents working" strip
there too, whose View opens the dock's agents tab on the newest one (a request
in `state/agents-reveal.ts` the thread view answers) and whose Stop, shown only
when the bound session's `capabilities.stopTask` is true, sends
`thread.task.stop` for that one, then the terminal drawer — a strip with a show button
while closed — whose toolbar finds text and quotes a selection into the
composer draft, and whose mod-clicked http(s) links open on the dock's browser
tab) and a right dock whose strip holds only the tabs opened in that thread
this session, in opening order, each with a close button and a "+" menu for
the kinds not open yet. The kinds come from a small registry in
`apps/web/src/components/dock/` (`DOCK_TABS` in `dock-toggle.ts`,
`DOCK_TAB_META` in `dock-tab-meta.ts`, `DOCK_TAB_PANES` in
`dock-tab-panes.tsx`); there are five today: **changes** (`git.diff` in three scopes
— this turn's checkpoints with the restore controls, the branch against its
base through `mergeBase`, and the uncommitted working tree — with a
split/unified toggle, a changed-file tree, next-unviewed and change keys,
scrollbar change marks, per-file discard and blame through `git.discard` and
`git.blame`, and a View menu for whitespace and wrapping), **browser** (the
pane), **files** (a search over
`files.search` that drills into directories and previews a file through
`files.read`, paged by line offset because a window is capped by characters,
not lines, and syntax highlighted when a small code file fits one page; a file chip in the timeline opens it on a file at a line, through
a per-thread request in `state/file-reveal.ts` that the thread view answers by
writing the file into the thread's Files view and opening the dock on Files),
**agents** (the thread's subagents from its snapshot's task rows, grouped
Working / Done / Failed, where a task is working only while its own turn runs
— one an ended or interrupted turn left open reads as Failed; thread docks only; an entry's target button leaves a
request in `lib/timeline-reveal-request.ts` that the timeline answers by
opening what folds the task row and scrolling to it) and **pull request** (a
thread's only, offered once `git.pullRequest.marks` says its branch has one:
`git.pullRequest.view` read through gh, with the summary, the checks and the
reviews; a comment can be added to the chat or opened in Changes on the
branch's diff). When less than 640px remains beside the sidebar, the dock overlays
the thread so its tabs stay reachable. Wider rows fit a thread column of at least 360px beside the dock.
The dock has keys of its own, answered by the thread view: `dock.toggle`
(Mod+Alt+B) closes it or reopens it on the tab it was closed on, and
`dock.changes` (Mod+Shift+D), `browserPane.toggle` (Mod+Shift+B) and
`dock.files` (Mod+P) open their tab, or close the dock when it already shows
that tab; `dock.agents` does the same for Agents and is unbound by default. Opening Files by its key also puts the cursor in the Files search.
Every other opener — a file chip, "Open in Files tab", the agent-browser Show
button — adds its tab if it is absent and activates it. Closing a tab only
hides its pane, as switching away does; closing the last one shows the
launcher with the dock still open.
The New task page, before any thread exists, has the same frame for the
picked project's own folder: a one-row header with Run, the git actions and
the terminal and dock toggles, the project's terminal drawer, and a dock with
Changes (the folder's uncommitted work, or its branch against the default
branch) and Files — no Browser, which is a thread's — answering the same keys
but `browserPane.toggle`.
Archived threads leave the sidebar tree for the archived threads settings page,
which unarchives or deletes them. The import settings page
(`apps/web/src/components/import/`) lists the sessions `sessions.importable`
answers, grouped by folder, and imports a selection one row at a time
(`apps/web/src/lib/session-import.ts`); its list atom is not kept alive, so
the harnesses' session files are read only while the page is open.
First-run setup (`apps/web/src/components/onboarding/`) is one dialog,
mounted once at the root (`OnboardingHost` in `routes/__root.tsx`) and opened
by an atom (`apps/web/src/state/onboarding.ts`): by itself once, when
`projects.list` and the settings have both answered with no projects and
`onboardingCompleted` false (`shouldOpenOnboarding` in
`apps/web/src/lib/onboarding.ts`, fed by `useLoadedProjects`, which is `null`
while loading), and again from the palette's "Set up Poseidon…"
(`onboarding.open`) or Settings → General's "Run setup again". Its steps are
harnesses, theme, a project and — only when `sessions.importable` has entries
— import; Skip setup, Finish and closing it all write `onboardingCompleted:
true`. The harness step draws a row per enabled connector summary with what
its probe found, re-probes on Re-check, and runs the connector's own install
or sign-in command as a script in home's terminal (`HomeTerminal`), whose
drawer opens inside the dialog. The project step and the sidebar's Add project
dialog share one form (`apps/web/src/components/sidebar/add-project-form.tsx`),
and the import step is the import page's panel, whose Open ends setup. The
keybindings settings page
(`apps/web/src/components/keybindings/keybindings-editor.tsx`) lists every
catalog command by area, each with its chords and `when` clauses, and warns
when a chord collides with another binding in a context that can overlap, when
the system owns it, or when it does not parse. A command resets on its own, or
every command at once, and Save stores only the overrides.
Every settings page is built from one composition
(`apps/web/src/components/Settings/settings-section.tsx`): a page header, then
titled sections whose card holds rows — title and description on the left, a
compact control on the right, hairlines between rows. Dialogs put a long body in
`DialogBody` (`dialog-body.tsx`), which scrolls while the header stays put, and
their buttons in `DialogActions` (`dialog-actions.tsx`), a tonal footer under
one hairline. Such a dialog also caps its `DialogContent` to the viewport
(`max-h-[calc(100dvh-2rem)] overflow-y-auto`), so in a window too short for all three the whole
popup scrolls and the footer buttons stay reachable.

A thread row is built on the stock sidebar menu parts
(`apps/web/src/components/sidebar/thread-row.tsx`). A fixed status slot sits
left of the title and holds one mark, from `ThreadSummary.awaiting` and
`status`: "Needs you" for an open approval or question, "Plan ready" for a plan
awaiting review, a spinner while a turn runs, a warning on error — and, only
when none of those applies, the unread dot. The right edge shows how long ago
the thread last moved ("now", "5m", "3h", "2d", "4w", then the month), from
`updatedAt` on a single one-minute tick the tree owns. A row that is only
working — running, waiting on nobody, not the open thread — recedes: its title
turns muted whether or not it is unread, and the right edge shows how long the
turn has been working instead ("<1m", "3m", "1h 4m", from `runningSince`;
`apps/web/src/components/sidebar/working-time.ts`). It comes back to full
weight when the turn ends or needs the user. While the thread's own terminals
run a shell, a small terminal mark sits beside the title, with the count when
more than one runs and a tooltip naming them
(`apps/web/src/components/terminal/thread-terminals-mark.tsx`); every row reads
one `terminal.listRunning` listing, so a long sidebar costs one call per
refetch rather than one per row. A thread whose branch has a pull request
shows a glyph tinted by its state (open, draft, merged, closed, checks failing;
`apps/web/src/components/sidebar/thread-pr-mark.tsx`), read from one
`git.pullRequest.marks` listing per project; a click on it opens the thread on
its Pull request tab. On hover the time gives
way to the overflow menu, which a right-click on the row opens too
(`apps/web/src/components/sidebar/thread-menu-items.tsx`):
rename, regenerate title (a model writes one from the conversation; disabled while offline or
when no harness can write text), pin or unpin, mark unread, mark done or active, a Copy submenu (the workspace path, the
branch of a worktree thread, the thread ID), open terminal here (the thread
with its terminal drawer open), open pull request (only while the branch has
one), new thread in this project (in the same
worktree for a worktree thread), fork from here (the fork dialog, for the
whole thread; `apps/web/src/components/thread/branch-off-dialog.tsx`), then
archive or unarchive and delete. An
archived row, listed only while it is open, offers the menu alone. The
selection bar under the tree archives, marks unread, marks done (or active,
when every picked thread is done) or deletes every picked thread. "Mark unread" lights the dot and the bold title
until the thread is opened again. The open thread is being read, so its menu
disables the item and the selection bar skips it. Pinned threads leave their project for a
"Pinned" group above Projects (`apps/web/src/components/sidebar/pinned-threads.tsx`),
newest pin first, whether or not their project is folded. Done threads move
to a collapsed "Done · N" section under their project's active rows
(`apps/web/src/components/sidebar/done-threads.tsx`; how-it-works §12, "Done
threads"). Archive, pin and unpin, mark unread, mark done or active and rename
can be undone
(`apps/web/src/components/sidebar/use-sidebar-actions.ts`). The archive
toast offers Undo, and `Mod+Z` outside text fields, the terminal and the
browser pane undoes the latest of them. Archiving unpins a thread; undoing
the archive unarchives it, pins it again and, when it was the open thread,
opens it again. The sidebar's thread commands go out one at a time
(`apps/web/src/components/sidebar/thread-actions.ts`): they share the one
dispatch atom, so sending a bulk archive or its undo all at once would
interrupt all but the last command and hand every caller its receipt.
`Mod+Shift+P` pins or unpins the open thread, and `Mod+Alt+K` marks it done or
active. A
double-click on any row's title, or Rename in its menu, swaps it for a title field, prefilled and
selected (`apps/web/src/components/sidebar/thread-title-input.tsx`, with
`thread-rename.ts` naming the one row being renamed): Enter sends
`thread.rename` when the trimmed title is new and not empty, and Escape or a
click away keeps the old one.

The sidebar's order is also a keyboard order. Pinned threads come first, then
projects in their listed order, each with its threads in list order and then,
while its Done section is expanded, its done threads; a folded project contributes only
the open thread, and threads whose project is gone come last
(`apps/web/src/components/sidebar/thread-order.ts`, which the tree draws from
too, so the two cannot drift). A folded project's header shows the most
urgent status among the threads it hides — Needs you, then Plan ready, then
working, then an error — with the row's icon and tone and a tooltip counting
the threads in that state (`apps/web/src/components/sidebar/project-status.ts`).
`Mod+1`…`Mod+9` open the Nth thread in that
order, and `Mod+Shift+[` / `Mod+Shift+]` step to the previous or next one,
wrapping at the ends. `Mod+Alt+J` jumps to the freshest thread that needs
you, else the freshest unread one
(`apps/web/src/components/attention/next-attention-shortcut.tsx`). `Mod+Shift+N` starts a thread in the open thread's
project, else the last project used, else the first. Every create that opens
the new thread (this key, the palette, the sidebar) asks that thread's composer
to take the focus once it mounts (`apps/web/src/lib/composer-focus.ts`), so the
first message can be typed straight away. `Mod+[` and `Mod+]` walk
the router's history, like the chrome's back and forward buttons. These live in
`apps/web/src/components/Layout/app-shortcuts.tsx`, mounted once at the root so
they work on every route. On an open thread, `Mod+Alt+R` renames it,
`Mod+Shift+A` archives it (or unarchives it when it is archived) and
`Mod+Alt+Backspace` opens the delete confirmation; a key alone never deletes.
`apps/web/src/components/thread/thread-shortcuts.tsx` owns those, with the row
menu's rename form, confirmation and dispatch, and answers the palette's
"Regenerate title" (`thread.regenerateTitle`, no default chord) while
something can write text (`apps/web/src/components/thread/regenerate-title.tsx`). The open thread's row menu shows
the same keys.

The command palette (`Mod+K`, `apps/web/src/components/Layout/search-command.tsx`
with its groups in `palette-groups.tsx` and `palette-commands.tsx`) lists these
groups:

- Navigation: new task, skills and MCP servers.
- One entry per settings page.
- A "New thread in …" entry for each project. The one `Mod+Shift+N` would
  start a thread in shows that chord.
- The commands, one group per area.
- The threads. Archived threads come last and are marked, so the palette is
  a second way back to an archived thread besides its settings page. The
  first nine rows of the sidebar show their `Mod+1`…`Mod+9` chord, numbered
  in sidebar order (`useThreadTargets`, shared with `AppShortcuts`).
- The messages. Past two characters, once typing pauses for 200 ms, the
  palette also asks `threads.searchMessages` for threads whose message text
  holds the query, across every project
  (`apps/web/src/components/Layout/palette-message-hits.tsx`). A disabled
  "Searching messages…" row stands in while it waits; each newer query cancels
  the older call. Each hit shows the thread's title, its project (archived
  threads marked) and a one-line snippet with the match in a `<mark>`. The
  hits carry a keyword the palette's matcher scores just above zero, so they
  are never dropped by the fuzzy filter and always rank after the title hits.
  Picking one opens the thread with the find bar prefilled with the query, at
  the match inside that message (`apps/web/src/lib/thread-find-request.ts`).

The command groups are built from the command catalog
(`apps/web/src/lib/command-catalog.ts`). Each row shows its chord with the
user's overrides applied. Picking a row fires the command through the
keybinding registry, exactly as its chord would. A row is offered only while a
mounted surface answers its command, so the palette never lists something that
would do nothing. A catalog entry can also carry a `paletteWhen` clause over
the published flags: "Stop turn", for example, appears only while a turn is
running. Some entries are marked `palette: false` and never appear:

- entries that another group's row already reaches, such as settings, skills,
  new task, new thread in this project and jump to thread N; that row shows
  the command's chord instead;
- the palette's own toggle;
- pick option N, which only means something while a question card is up.

The palette closes when the route changes under it, so a chord pressed while
it is open, such as `Mod+1`, lands on the thread rather than behind the
dialog.

"Keyboard shortcuts" is one of the General commands. It opens the shortcuts
sheet (`Mod+/`, `apps/web/src/components/keybindings/shortcuts-dialog.tsx`,
mounted once at the root): every catalog command grouped by area with its
current chords, overrides applied, and its `when` clause, plus the composer's
fixed keys, searchable by name, id or key (`apps/web/src/lib/cheatsheet.ts`).
Settings → Keybindings has a button that fires the same command.

A leading `>` narrows the list to
commands and hides the threads and the message search; the text after it is matched by the usual fuzzy
filter (`apps/web/src/lib/palette-query.ts`). A footer names the keys: arrows
to move, Enter to open, Escape to close, `>` for commands.

The atom runtime is built once. `apps/web/src/state/app-runtime.tsx` owns the
single `makeRuntime` instance, the shared registry and the offline layer that
keeps every atom mountable when there is no server;
`apps/web/src/lib/app-runtime.ts` adds the settings atoms on top of that
instance; `apps/web/src/lib/client-runtime.tsx` publishes it to React
(and lets a fixture page substitute a scripted client). Components read through
`apps/web/src/state/hooks.ts` and hold no RPC client of their own.

Presentation state that never reaches the server lives in
`apps/web/src/state/ui.ts` and the browser's own storage — row disclosure, dock
width, the per-thread dock tab, the last pull request link of each thread's
branch, the Changes pane's scope and diff style and, in memory only, each
thread's review there (which files are open and which are marked viewed; the
pane's View menu options are the settings document's `diffView`, through
`apps/web/src/lib/use-diff-view.ts`), the
"last seen" stamp behind the unread dot and the sidebar's pinned threads
(`apps/web/src/components/sidebar/thread-pins.ts`)
— in `apps/web/src/state/changes-view.ts`, in memory only, whether the Changes
pane's file tree is shown and each thread's folded folders and filter in it,
and in `apps/web/src/state/terminal-ui.ts`, which threads have their
terminal drawer open and how tall it is. The terminals themselves are the
server's: the drawer's tabs are a fold of `terminal.list`
(`apps/web/src/components/terminal/drawer-state.ts`), kept in memory per
thread so the active tab survives a thread switch, and a terminal the server
no longer knows drops out of them.
The in-app browser's tabs are the same kind of state, in
`apps/web/src/state/browser-tabs.ts`: per thread, the tabs (`tabId`, the
guest's `wcId`, url, title, loading, history, and who opened it — the agent,
a popup or a person) and the selected one, with pure reducers.

**The browser host.** A pane tab is an Electron `<webview>`, and its guest
lives exactly as long as the element keeps its place in the DOM: unmounting,
re-keying or reparenting it destroys the guest, which the agent sees as
`tab_gone`. So no pane renders one. `BrowserHost`
(`apps/web/src/components/browser-host/`) is mounted in `routes/__root.tsx`,
above both the home and the settings layouts, and renders every live tab of
every thread in one list in creation order — a list that only appends and
removes, so React never moves a webview. Each is `position: fixed` and placed
by CSS alone (`host-geometry.ts`): the selected tab of the thread whose pane
is on screen is laid over the pane's `BrowserSlot` (`data-browser-slot`,
tracked with a `ResizeObserver` and the window's resize and scroll), above
the dock and below dialogs; every other tab keeps the pane's last rect (or
1024×768 before the pane was ever shown), clamped inside the viewport, and is
`opacity-0 pointer-events-none` beneath the app. Never offscreen, 0×0,
`visibility: hidden` or `display: none`: a guest laid out that way gets no
input and never answers `Page.captureScreenshot` (the spike's hidden-pane
runs). The host is the window's tab host (`serveTabs`): it answers the shell's
`create` — refused for a thread the list does not hold or shows archived, and
for anything but http(s) and `about:blank` — with the new guest's
`webContents` id at its first `dom-ready` (the earliest a webview answers
`getWebContentsId`; `did-attach` comes before it), `close` and `select` by
`wcId`, and places a popup right after the tab that opened it. It forwards
every relayed guest gesture as `browser.humanInput` and each thread's
selected tab as a passive `location`, whether or not the pane is open. It
drops an archived thread's tabs at once, and a deleted one's — gone from the
list for 2 s while connected, 10 s when the list is empty, since that is also
what a resnapshot looks like before its snapshot lands — and asks the shell to
clear that thread's partition. Threads deleted while it was not watching (the
app closed, another client, a quit inside the grace) are caught once per
launch: after the connected list has been non-empty and unchanged for 10 s,
the host hands its ids to `clearStale` (`use-partition-sweep.ts`). The shell
sweeps only when it runs against the default home: every `POSEIDON_HOME`
shares its partitions, and a scratch home's list would make every real
thread look deleted. On quit the webviews go with the window. The web
renderer has no preload bridge, so the host renders nothing there.

**Closed by default.** Nothing opens the dock or the Browser pane, and
nothing creates a webview, at start, project open or thread open; a dock tab
comes back only because the user left the thread on it (`useDockMemory` in
`apps/web/src/state/ui.ts`: per thread, in memory only, the dock's last tab
and the tabs opened this session, `DockMemory.openTabs`).
While the agent uses the browser — a `browser_*` call in flight, or a tab it
opened — and the pane is not on screen, the thread header shows a chip with a
Show button (`apps/web/src/components/thread/agent-browser-indicator.tsx`): a
pulsing "Agent is using the browser" while a call runs and for 4 s after, so
one task's calls do not flicker it, and a still "Agent opened a browser tab"
when only the agent's tab is left. The
`browser.openPaneOnAgentUse` setting (off by default) opens the pane once per
agent activity that starts while the thread is on screen (each visit's first
sight of a thread, taken once the server's browser state has arrived, is only
a baseline), never over a pane the user closed while the agent was active, and
without remembering it as the thread's dock tab; the rules are pure
(`apps/web/src/components/panes/browser/auto-open.ts`) and the per-thread
record is in `apps/web/src/state/browser-activity.ts`, in memory only. Other
surfaces open a page through one entry point, `openInThreadBrowser(threadId,
url, { reveal })` (`apps/web/src/components/panes/browser/open-in-browser.ts`):
http(s) only, it selects the thread's tab already on the url or opens one,
and asks the thread view to show the pane (in the web renderer it navigates
the headless browser instead). A failed attach is a destructive `Alert` over
the pane with Retry, whose `reload` gesture only clears the server's error;
under the kill switch the pane says "In-app browser is disabled
(POSEIDON_REMOTE_DEBUG=0)" and still lets a person browse; the web renderer
labels its frame stream "Headless browser (web mode)".

**The pane's chrome** (`apps/web/src/components/panes/browser/`,
`in-app-toolbar.tsx`). In-app, the pane is the address bar (`address-bar.tsx`:
back and forward disabled at the ends of the history, reload that becomes stop
while the page loads, a zoom badge when not at 100%) with a "more" menu
(`more-menu.tsx`: zoom in, out and reset through the webview's zoom level,
stepped through Chromium's presets in `zoom.ts`; DevTools, which opens in its
own window beside the bridge's debugger; open in the system browser; copy the
address), and under it the tab strip (`tab-strip.tsx`: stock Buttons per tab —
the stock tabs cannot hold a close button inside a trigger — with the page's
http(s) favicon, a spinner while it loads, and New tab). Everything moves the selected webview
directly (`tab-actions.ts`) and reports a history move as the matching
`browser.humanInput` gesture — `stop` included — so the epoch bumps and the
server never runs agent-browser for a person. `address.ts` decides what a
typed address loads: http(s) and `about:blank` as typed, a bare local host
with `http://`, any other bare host with `https://`, and everything else —
`file:`, `javascript:`, `data:`, words — becomes a DuckDuckGo search, never a
navigation. The pane's keys (`browser.focusUrl`, `browser.reload`,
`browser.back`, `browser.forward`, bound `when: browserFocus`) answer in
the toolbar, since the pane's root carries `data-context="browser"`; pressed inside
the page they come back from the shell (`poseidon:browser-command`, see
`apps/desktop/src/main/ipc.ts`) to the host's `use-guest-keys.ts`, which moves
the tab the key came from and hands `browser.focusUrl` to the command
registry. The host re-sends the chords whenever the table changes.

**The page in the conversation.** Beside the address bar
(`page-actions.tsx`, pure parts in `page-to-chat.ts`), Pick an element runs a
picker in the page through the webview's `executeJavaScript`: it outlines the
element under the pointer, swallows the click that picks it and resolves with
a CSS path, the tag, its text (200 characters) and the start of its HTML
(2,000). Picking focuses the page, so its own Escape handler hears the key;
Escape anywhere else in the window, a second press, a tab switch or a new
document in the tab (`did-navigate`; an in-page hash or history change keeps
the page and its picker, so the pick goes on) cancels it too, and a pick the
pane ended that way never lands in the draft if it settles late. The answer is the
page's own data, so it is checked and cut again here and appended to the
thread's composer draft (`@/state/ui`), where the person reads it before
sending. Screenshot to chat asks the shell for a PNG of the tab
(`poseidon:browser-capture`) and adds it to the draft's files through the
composer's own attachment rules. Neither talks to the agent by itself.

**The agent's cursor.** The bridge hands every native-input command it lets
through to the shell's pointer relay (`apps/desktop/src/main/browser/agentPointer.ts`)
before it reaches the guest; presses are always told and moves thinned to
one per 50 ms per tab, on `poseidon:browser-agent-pointer`. The browser host
(`agent-cursor.tsx`) keeps each tab's latest point, scales it by the tab's zoom
onto the webview's box (`pointer-transform.ts`) and draws a cursor with a pulse
on each press over the tab on screen only; it fades 2.5 s after the agent's
last move.

**Timeline rows.** A `mcp__poseidon__browser_*` row reads as what the agent did
to the page — "Opened <url>", "Clicked @e3", "Pressed Enter", "Took a
screenshot" — with the globe icon (`apps/web/src/components/timeline/browser-tool.ts`);
typed and filled text is never shown in the label. The rows still come from
the harness transcript, never from the gateway.

**Settings → Browser** (`apps/web/src/components/Settings/browser-panel.tsx`,
also in the command palette) holds `browser.openPaneOnAgentUse` (off by
default), a plain account of the in-app attach and what it can reach,
agent-browser's status from `browser.status` — the server's mode, whether
`agent-browser --version` answered at startup and what it printed, asked on
every reconnect (`browserStatusAtom`) — with the install commands the mode
needs when it is missing, and Clear browsing data, which forgets the address
bar's history and, on the desktop, clears every thread's partition after a
confirmation.

**Suggestions.** Focusing the address field opens a stock `Popover` holding a
stock `Command` list (`address-suggestions.tsx`) with the project's running
dev servers, then the pages the project's tabs visited (`suggestions.ts`
narrows both by what is typed). Focus stays in the field: the popover opens
without taking it, a press in the list is kept from blurring it, and the
arrow keys move the highlighted row from the field, so Enter loads the
highlighted row or, with none, what was typed. The servers come from
`browser.discoverServers` (`packages/client-runtime/src/browserAtoms.ts`),
asked while the bar is on screen and again each time the list opens; the
empty pane lists the same servers as buttons that open a tab through
`openInThreadBrowser`. The history is per project, in this window's
localStorage (`apps/web/src/state/browser-history.ts`, pure rules in
`history.ts`): http(s) only, a revisit moves to the front, at most 50 pages.
On the desktop the browser host records every tab of every thread, shown or
not (`use-history-recorder.ts`); the web renderer's pane records the headless
browser's page.
There is no `unread` flag on the wire: whether this window has looked at a
thread is not the server's business, and a thread with no stamp is deliberately
not unread. "Mark unread" stores an empty stamp, older than any `updatedAt`.
Pins are the same kind of state — how one person arranges one sidebar — so a
second client keeps its own.

The three `dev/*` pages load their bodies through a dynamic import inside
`if (import.meta.env.DEV)`, so no fixture data reaches a production bundle.
`/dev/composer` and `/dev/timeline` run the real atom stack over
`makeFixtureClient` (`apps/web/src/lib/fixture-client.ts`): an in-process
`Connection` whose decider answers a command with the events a server would
emit, and whose other RPC answers come from inline data in
`apps/web/src/lib/fixture-rpc.ts`. `/dev/timeline` loads one of two scenarios
into it: the contracts' every-kind snapshot, or `buildRichTimelineSnapshot`
(`apps/web/src/components/dev/timeline-fixture-data.ts`), a thread of settled
turns and one running turn whose ids are minted on a moving clock, so
durations and checkpoints read as they would on a real thread. From there the
page can start, stream into, settle and send turns, repeat the thread ×10 or
×50, and narrow the column; it publishes `threadOpen` as the thread view
does, so the timeline's collapse-all and expand-all keys answer there. The
fixture's checkpoints behave like the
server's without git: a settled turn records one, `checkpoints.list` answers
the document's list, and an accepted restore settles a moment later; the page
header names the last command it dispatched and its receipt.
The conversation scenario covers every row the timeline draws: short and long
user messages with attachments and skill and plugin references, markdown with
code blocks in several languages and named files, file path links inside and
outside the workspace, reasoning, commands that pass and fail, edits, a
nested task, todos, a plan with its decision, answered approvals and
questions, a steered message, an error, a compaction, an unknown kind and a
running turn. `apps/web/src/lib/fixture-files.ts` is its workspace:
`files.stat` and `files.read` answer from that listing with the server's
containment rules, and a file chip opens the real Files pane beside the
timeline.

Syntax highlighting has one engine. `DiffWorkerPoolProvider`
(`apps/web/src/components/timeline/diff-pool.tsx`), mounted in
`routes/__root.tsx`, starts the `@pierre/diffs` worker pool, which is two
workers with the `pierre-light`/`pierre-dark` themes. Shiki tokenizes in
those workers. Both the inline diffs (`InlineDiff`) and the markdown code
blocks (`CodeBlock`, through the library's `File`) highlight through that
pool, with options from `diff-options.ts`, and so does the Files preview
(`panes/files/highlighted-page.tsx`, options and the decision in
`panes/files/preview.ts`). A code block rendered without a
pool, as in tests, falls back to a plain `pre` rather than load Shiki on the
main thread, and the Files preview to its plain line table. The renderer depends on `shiki` directly only for its list of
bundled languages (`bundledLanguagesInfo`, the same one the pool resolves
grammars from, at the version `@pierre/diffs` already brings), so a fence
names any language the workers can highlight (`code-fence.ts`).

The timeline (`apps/web/src/components/timeline/`, behaviour in
[how-it-works §4, "Rows on screen"](how-it-works.md#rows-on-screen)) keeps
its rules in pure modules with unit tests and its rows in thin components:

| Concern               | Pure logic                                                                                | Components                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Rows from items       | `turns.ts` (turns by `turnId`, task nesting, decision anchors), `fold.ts`, `fold-rows.ts` | `timeline.tsx` (LegendList), `timeline-item.tsx` (one component per kind)                                  |
| Labels and folds      | `work-summary.ts`, `live-step.ts` (labels), `disclosure.ts` (expand/collapse-all ids)     | `turn-fold-row.tsx`, `work-group-row.tsx`, `use-step-ended-at.ts`, `turn-summary-row.tsx`, `row-shell.tsx` |
| Markdown and code     | `markdown-blocks.ts`, `code-fence.ts`, `remark-user-text.ts`, `user-message-collapse.ts`  | `markdown.tsx`, `code-block.tsx`, `user-message-row.tsx`, `message-rows.tsx`, `attachments.tsx`            |
| File chips            | `path-links.ts`, `tool-target.ts`                                                         | `path-chips.tsx`, `use-path-chips.ts`, `markdown-paths.tsx`, `file-chip.tsx`, `file-change-row.tsx`        |
| Footers and restore   | `turn-checkpoints.ts`                                                                     | `message-footer.tsx`, `restore-before-turn.tsx` (the Changes pane's `restore-dialog.tsx`)                  |
| Scroll and navigation | `send-anchor.ts`, `turn-rail.ts`, `list-hold.ts` (scroll holds), `reading-position.ts`    | `use-send-anchor.ts`, `use-reading-position.ts`, `jump-to-latest.tsx`, `turn-rail-view.tsx`                |
| Context for every row | —                                                                                         | `thread-context.tsx`, filled by `use-timeline-thread.ts`                                                   |

A user message's "Edit and resend" (`edit-message-button.tsx`) records the
edit, with the restore point it resends from, in `state/message-edit.ts`; the
composer's `use-edit-resend.ts` sends it as a restore carrying `resend`, and
its settle rules and wording are pure (`composer/edit-resend.ts`).

Row state that must outlive a recycled container — disclosures, turn folds,
"Show more" — lives in the row disclosure map (`state/ui.ts`,
`state/turn-folds.ts`), and stateful subtrees are keyed by item id. The
composer notes each send in `state/local-sends.ts`, which the send anchor
reads to tell this reader's send from a drained queue or another window, and
the timeline keeps each thread's reading position for the session in
`state/timeline-positions.ts`.

Public seam: none; it is a leaf. May import `ui`, `contracts`,
`client-runtime`, `shared`. Must never name a connector.

### apps/server

The whole backend, assembled in one composition root.

`apps/server/src/boot.ts` builds the layer graph and starts it in the calling scope:
closing that scope shuts down the server, the database, every open connector
instance and every terminal's shell. It returns once the handshake is written,
which is the moment the first client may connect. Two things about it are load-bearing:

- **One `Layer.build` for the whole graph.** `Layer.build` memoizes per call, so
  a layer handed to two builds is constructed twice. `OrchestrationEngine` and
  `SessionManager` are reachable both from the services (through the browser
  service and the MCP gateway) and from the server (through the RPC handlers and
  the reactors); two builds gave the process two of each, sharing a database but
  not their PubSubs.
- **`ConnectorHost.install` runs before the handshake.** The connector manager
  opens instances while the graph is still building, before the HTTP server
  listens or the hook bridge exists, so the `ConnectorServices` it hands them is
  a façade that `install` fills in with the real MCP endpoint, hook endpoint,
  hook handler registry, permission ladder and the plugin registry's
  `sessionPlugins`. Just before it, `boot` writes the built-in plugins into
  `builtin-plugins/` (never at layer build, which tests do). `boot` then waits on
  `ConnectorManager.ready` so no client is admitted while `ConnectorSelection`
  would still answer `NoConnector`.

Directories, relative to `apps/server/`:

| Path                 | What lives there                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/persistence/`   | `Sqlite`, `EventStore`, `ReadModels`, `Migrations`, `migrations/*`                                                              |
| `src/orchestration/` | decider, engine, state fold, reactors, session manager and supervisor, live buffer                                              |
| `src/rpc/`           | WebSocket transport, handlers, service tags, handshake, origin check                                                            |
| `src/permissions/`   | the ladder, the pattern re-export, the sensitive-path list                                                                      |
| `src/hooks/`         | the PreToolUse bridge                                                                                                           |
| `src/mcp/`           | the MCP gateway and its HTTP routes                                                                                             |
| `src/browser/`       | browser service, agent-browser CLI, drivers, tool catalogue, dev-server discovery                                               |
| `src/terminal/`      | terminal service and sessions, pty seam, shell and env, scrollback, batcher                                                     |
| `src/git/`           | status/diff, discard/blame, branches, commit/push, gh pull requests, worktrees and their setup script, file search, checkpoints |
| `src/fs/`            | `fs.browse`                                                                                                                     |
| `src/editors/`       | editor, file manager and terminal detection, path containment, launch argv (`editors.list`, `editors.open`)                     |
| `src/scripts/`       | package.json script detection: workspace patterns, package manager, run commands (`scripts.detect`)                             |
| `src/settings/`      | settings store users, connector manager and host, connector extension routing                                                   |
| `src/attachments/`   | the staging store and its reactor                                                                                               |
| `src/generation/`    | generated text: the writer resolver, prompts and answer parsing, the git reads, the `TextGeneration` service and title reactor  |
| `src/plugins/`       | the plugin registry, manifest and MCP config reading, the built-in plugins and writing them at boot                             |
| `src/import/`        | the session importer (`sessions.importable`, `sessions.import`), its ledger, a transcript as timeline events                    |

`SessionImporter` (`src/import/`) brings sessions a harness recorded on its
own in as threads. It never reads a harness file itself: `sessions.importable`
asks every open instance that carries a `sessions` extension for its newest
sessions (an instance whose list fails is logged and skipped), marks each with
the project already open on its `cwd` and the thread that already holds it,
and sorts them newest first. That thread is the one an earlier import made
of it, else a live thread of Poseidon's own whose session runs it: Poseidon's
Claude Code and Codex threads keep their sessions in the same folders the
readers list, so the extension's optional `sourceIdOf` turns a thread's
persisted `sessionRef` back into a `sourceId`, matched across every instance
of the connector's kind (two instances reading one folder list the same
sessions). `sessions.import` reads the transcript through the instance, finds
the project whose root is the session's `cwd` or dispatches `project.create`
there (refusing, `not-found`, when that folder no longer exists), and
dispatches `thread.create` for a local thread on it with the instance as its
connector, since a resume must run where the session ran. The command carries
`imported: { connectorKind, sourceId, session? }`, with
`session: { connectorInstanceId, sessionRef }` when the instance's
`capabilities.resume` is true and the reader gave a `sessionRef`. It then
appends, as the system, one completed `thread.item.upserted` per message, a
new turn at each user message and the replies after it sharing it. Each of
those events occurred when its message was said (a message with no time takes
the one before it, the first the session's start), so the thread's
`updatedAt` is the session's last message and a batch of imports lists in the
sessions' own order. No session is bound: the supervisor's boot scan resumes
only bound threads, so an imported thread nobody has run never spawns a
harness. Its first turn continues the conversation the way a native fork does
(see the fork section under Contracts): it resumes the recorded session, or
starts fresh with the imported rows as a transcript. A never-run imported
thread also counts, by its `imported.sourceId`, as the thread that holds that
session. Which thread each `<instanceId>:<sourceId>` became is kept in
`session-imports.json` under the Poseidon home, replaced through a temporary
file and a rename; importing a session whose thread still exists, or that a
live thread runs, answers that thread without a copy, and `importable` names
it only while it does. Imports run one at a time. A failure after
`thread.create` dispatches `thread.delete`, so a retry starts clean; a project
the import added stays.

Public seam: the RPC group in `packages/contracts/src/rpc.ts` and the three
loopback HTTP routes. May import `contracts`, `connector-sdk` and `shared`;
`connector-cmd`, `connector-claude` and `connector-codex` in `boot.ts` and in
tests only;
`testkit` and `client-runtime` in tests only. Must never import `apps/web` or
`apps/desktop`.

**Generated text** (`src/generation/`). `TextGeneration` answers the three
generation RPCs and the title reactor's `autoTitle`, and never names a
harness: `resolveWriter.ts` picks the writer by capability. The Writing model
(`generation.writingModel`) is used while its instance is open, its harness
and model are switched on — the same rule as the web's
`lib/model-visibility.ts`, re-implemented there — and the instance has
`generateText`. Otherwise Same as the thread answers: the thread's
`connectorInstanceId` (or its bound session's) with its model, and with no
thread, or a thread whose harness cannot write, the routed default (the first
open enabled connector in the connectors page's order, with the model
`seedModel` gives a new thread). A chosen model passed over adds the answer's
`notice`. No writer is `unavailable`. `generation.writingEffort` is sent only
when the model lists it. `gitContext.ts` reads the change with `git diff`,
`git log` and `git ls-files` straight through `git/process.ts` (external diff
drivers and colour off, the index never written), `prompts.ts` builds every
prompt and JSON schema and finds the pull request template, and `parse.ts`
reads the answer leniently (a code fence, a sentence before the object, plain
text). Each call is capped at 120 s, and interrupting it interrupts the
connector's call.

`boot.ts` registers Command Code first, Claude Code second and Codex third.
The order is
routing order on a fresh install: every definition is seeded as an enabled
instance in that order, and a thread that names no instance runs on the first
enabled one.

### packages/contracts

Every wire shape, as `effect/Schema` codecs. Modules: `base`, `ids`, `enums`,
`runtime`, `orchestration`, `decisions`, `git`, `editors`, `search`, `generation`, `scripts`, `settings`,
`keybindings`, `connectors`, `terminal`, `rpc`. `keybindings` holds the shipped keymap, the
chords reserved for features still being built, and how the user's stored
overrides layer on the keymap, since both server and renderer need it.
`git` holds `ThreadWorktree`, the worktree a thread was created in, and the branch, commit, push, pull-request and worktree RPCs with
their shapes (`GitBranch`, `GitBranchList`, `GitCommitResult`, `GitPushResult`,
`GitPullRequestResult`, `GitWorktreeInfo`, and the `WorktreeSetupFrame` union
the setup script streams); they are defined there rather than in `rpc.ts`,
their names are spread into `RPC_METHODS`, and `rpc.ts` lists them in the
group. `editors` does the same for `editors.list` and `editors.open`, with
`EditorId` and `DetectedEditor`, `search` for `threads.searchMessages`,
with `MessageSearchHit` and its `MESSAGE_SEARCH_LIMIT` of 50, and `scripts`
for `scripts.detect`, with `DetectedScript`, `PackageManager` and
`ProjectScript`, the saved script `settings` holds per project.
`generation` holds the generated-text settings `settings` embeds
(`GenerationSettings`: `writingModel`, a `{ connectorInstanceId, model }` pair
or null for Same as the thread, `writingEffort` `low`/`medium`/`high` and
`autoTitle`, each defaulted on decode; `WritingStyle`, `CommitDraftMode` and
the `CUSTOM_INSTRUCTIONS_MAX` of 20 000 characters the git settings use) and
the shapes of `git.generateCommitMessage`, `git.generatePullRequest` and
`thread.regenerateTitle` with their `GENERATION_RPC_METHODS`, spread into
`RPC_METHODS` and listed in the group like the others. `git.ts` holds
`GitWorktreeCreated`, what `git.worktree.create` answers: the `ThreadWorktree`
fields plus an optional `notice`. `ThreadWorktree` itself is stored in events
and does not carry it.
`PoseidonRpcError` lives in `rpcError.ts` so `git`, `editors`, `search` and
`scripts` can name it without an import cycle, and `rpc` re-exports it.
`browser.ts` holds the browser pane's
payloads (`BrowserState`, `BrowserHumanInput`, `DevServer`,
`BrowserToolStatus`), and `files.ts` the workspace file RPCs
(`FILE_RPC_METHODS`, spread into `RPC_METHODS` like the others) and their
payloads (`FileSearchResult`, `FileContent`, `FileCreated`, and `FileStat`
with the `FILES_STAT_MAX_PATHS` cap of 100 that `files.stat` takes in one
call); `rpc` re-exports the payloads too, so they are read from
`@poseidon/contracts/rpc`. `thread.ts` holds the value objects of a thread and
`readModels.ts` the sidebar's `ProjectSummary` and `ThreadSummary` and the
`ThreadDetailSnapshot`; both are reached through `orchestration`, which
re-exports them, rather than as modules of their own.
`decisions` holds the record a thread keeps of each settled approval, question
and plan, which the thread read models in `orchestration` carry. `connectors`
holds what the renderer learns about a connector — models, probe, configured
instances, metadata and config form, and the skills, plugins and MCP servers
its extensions list. `sessionImport` holds `ImportableSession`, one session
a harness recorded on its own, as a `sessions` extension lists it for an
import, and `sessions.importable` and `sessions.import`, with the
`ImportableSessionEntry` the list answers and the `SessionImportResult` an
import does. `terminal` holds the integrated terminal's owner (a thread, a
project or home), its summary, its output stream frames and the limits both
ends share. `rpc` holds the methods
that carry them.

Ids are branded UUIDv7 strings, so a `ThreadId` cannot be passed where a
`TurnId` is expected, and they are validated on decode — a malformed id fails at
the transport boundary rather than deep inside a projection. `ConnectorKind` is
deliberately an unconstrained string: adding a connector must not touch this
package.

`Effort` is the canonical reasoning ladder, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`, `ultra`, exported in that order as `EFFORT_ORDER`. It is a
superset: which rungs a model accepts is `ModelOption.efforts`, and a harness
maps its own names onto these. The union only grows, so a stored thread's effort
always decodes. `ultra` is Codex's rung past `max`, maximum reasoning with
automatic task delegation, offered only on a model whose `model/list` row lists
it; the effort keys never step onto it, a model that states no ladder does not
offer it, and a harness without it never receives it — Claude Code and Command
Code leave their effort flag out for it, so the CLI default applies.

`ThreadSettings.ultracode` (optional, also on `ThreadSettingsPatch`, so on
`thread.settings.update` and `thread.settings.updated`, and on the
`model.changed` runtime event) is Claude Code's ultracode session mode: `xhigh`
effort plus standing dynamic-workflow orchestration. Absent is off, which is
every event written before it existed; it means something only on a session
whose capabilities carry `ultracode`.

The server keeps the flag to the rules of the harness's own flag-settings
handler (`apps/server/src/orchestration/settingsRules.ts`), so the stored
settings never show a combination the session is not in: switching ultracode
on also sets the effort to `xhigh` (on `thread.create` too, over the patch's
effort and the Settings default); switching it off keeps the effort; and a
`thread.settings.update` that names an effort but not ultracode, on a thread
that has it on, switches it off — picking `xhigh` itself included. A
`model.changed` that reports ultracode is stored as reported, without these
rules, since it is what the session already did. The composer's Ultracode
toggle (`apps/web/src/lib/ultracode.ts`) is offered where the instance's
capabilities carry `ultracode` and the model lists `xhigh`, and applies the
same rules to New task's local settings before `thread.create`, plus one more:
a model pick the toggle is not offered on switches ultracode off, from the
model picker and from the composer's `/model` rows alike.

`ModelOption.hidden` is optional: a connector may list a model it does not want
offered by default. The settings document's `modelPicker` holds the user's
switches over that — `harnesses` keyed by connector instance id, `models` by
instance id then model id, plain string keys so a stale id still decodes. Only
a flipped switch is stored, like `plugins`, so a default a connector changes
later still applies. It is defaulted on decode, so older rows read as nothing
switched. The rules that read it — every harness on, every model on unless
hidden, the current pick always kept — are `apps/web/src/lib/model-visibility.ts`.

`ModelOption.description` is optional too: the connector's one-line tagline for
the model, shown only as secondary text. The model's name is always `label`,
never the tagline. A connector leaves the field out rather than send an empty
string, since `description` is a `NonEmptyString` and an empty one fails the
whole model list. Nothing persists a `ModelOption` — the server caches the list
in memory and `connectors.list`/`connectors.models` pass it through — so the
field needs no migration.

The settings document also holds the generated-text options. `git` gains
`writingStyle` (`repository`, `conventional`, `custom`), `customInstructions`
(capped at `CUSTOM_INSTRUCTIONS_MAX`), `followPrTemplate`,
`draftCommitMessages` (`template` or `generate`) and `worktreeFromOrigin`;
stored `git` rows hold only `branchPrefix`, so each is defaulted on decode, and
because a patch's `git` replaces the whole struct a client always spreads the
current one. `defaults.workspace` (`local` or `worktree`) is optional and
absent means Local. `generation` (`GenerationSettings`) and
`confirmThreadDelete` (default true) are defaulted on decode.
`onboardingCompleted` is too, as true, so an install from before first-run
setup never gets it, while `defaultSettings()` writes false for a fresh one.
The server reads `generation`, the writing style, custom instructions,
`followPrTemplate` and `worktreeFromOrigin`; `draftCommitMessages`,
`defaults.workspace`, `confirmThreadDelete` and `onboardingCompleted` are the
renderer's alone.

Public seam: its `exports` map. May import `shared` only.

### packages/connector-sdk

What a connector is, and the promises it must keep.

- `definition.ts` — `ConnectorDefinition<Config>`, `ConnectorInstance`,
  `ConnectorServices`, `GenerateTextInput`, the error union,
  `eraseConnectorDefinition`.
- `sessionHandle.ts` — `SessionHandle` and the bounded event queue.
- `turnScopedHandle.ts` — the turn correlation wrapper.
- `extensions.ts` — the optional per-instance extensions (skills, plugins, MCP
  servers, the harness's own slash commands, its session files).
- `sessionFiles.ts` — what a `sessions` extension reads with: JSON Lines a
  line at a time, files newest first, a title from a prompt, a transcript
  within its caps.
- `approvalGate.ts` — the shared approval flow: ask the permission ladder, and
  on prompt open a request and park until the user answers.
- `registry.ts` — definitions by kind, live instances by id.
- `conformance.ts` — the executable suite.
- `streamCollector.ts` — the collector the suite and testkit share.

May import `contracts` and `shared`. Must never import the server or any
connector.

### packages/connector-cmd

The Command Code connector. `definition.ts` wires the pieces: `probe.ts` and
`binary.ts` (find and interrogate the CLI), `spawn.ts` (argv and the environment
allowlist), `turnArgs.ts` (what one turn's argv is), `session.ts` (one session
per thread), `ndjson.ts` (frame parsing), `translate.ts` (frames →
`RuntimeEvent`), `transcript.ts`, `plans.ts`, `subagents.ts`, `questions.ts`,
`approvals.ts`, `hookAnswers.ts`, `hookScript.ts`, `config.ts`, `exitCodes.ts`,
`sessionRef.ts`, `attachments.ts`, and the two extensions the Customize page
edits through, `mcpServers.ts` and `skills.ts`. `makeCmdConnectorDefinition`
takes the harness's config home, so a test can move it.

May import `connector-sdk`, `contracts`, `shared`. It is the only place in the
tree that knows `cmd` exists, apart from the one line in `boot.ts` that
registers it.

### packages/connector-claude

The Claude Code connector, over `@anthropic-ai/claude-agent-sdk`.
`definition.ts` wires the pieces: `binary.ts` (find `claude`), `env.ts` (the
default-deny child environment), `probe.ts` (version, `auth status`, and the
zero-turn SDK handshake that lists the models), `models.ts`, `capabilities.ts`,
`configSchema.ts` (`binaryPath`, `configDir` for `CLAUDE_CONFIG_DIR`,
`defaultModel`), `spawn.ts` (the SDK's `spawnClaudeCodeProcess`: its own
process group, and the proof it is gone), `inputQueue.ts` (the streaming-input
prompt), `queryOptions.ts`, `toolGate.ts` (the PreToolUse hook and
`canUseTool`, both through the permission ladder), `approvals.ts` (the CLI's
tools in Poseidon's approval vocabulary), `interactions.ts` (the question and
plan cards AskUserQuestion and ExitPlanMode open), `questions.ts` and
`plans.ts` (their shapes), `attachments.ts` (images as content blocks, other
files by path), `userMessage.ts`, `sessionRef.ts`, `steering.ts` (when a
steered turn is over), `session.ts` (one long-lived CLI process per thread),
`sessionFiles.ts` (the `sessions` extension: the CLI's own transcripts under
`<config>/projects`, read for an import), and `translate/` (SDK messages →
`RuntimeEvent`; `tools.ts` holds the tool rows, `subagents.ts` the tasks and
their nested rows, `compaction.ts` the compaction row). `makeClaudeConnectorDefinition`
takes the turn and budget caps a recording puts on every session; production
passes none.

May import `connector-sdk`, `contracts` and `shared`; its tests also import
`testkit`. It is the only place in the tree that knows `claude` exists, apart from the
line in `boot.ts` that registers it.

### packages/connector-codex

The Codex connector, over `codex app-server`'s JSON-RPC on stdio; no SDK
package is involved. `boot.ts` registers it third. `definition.ts` wires
`binary.ts` (find
`codex`), `env.ts` (the default-deny child environment, `CODEX_HOME` from the
instance only), `spawn.ts` (a process group per child, stdin closed first, and
the proof it is gone), `rpc.ts` (the line-delimited JSON-RPC client),
`protocol.ts` (narrow schemas for the messages read, pinned to the CLI release
they were read against), `handshake.ts` (`initialize`, `account/read`,
`model/list`), `probe.ts` (`--version`, `login status`, and the zero-turn
handshake), `models.ts`, `capabilities.ts` and `configSchema.ts`
(`binaryPath`, `codexHome`, `defaultModel`).

A session (`session.ts`) is one app-server process per thread. `launch.ts`
hands it Poseidon's per-thread MCP server as `-c mcp_servers.poseidon.*`
overrides, the bearer in a child-only environment variable, never in argv.
`threadOpen.ts` opens the thread with `thread/start`, or `thread/resume` from
the ref (`sessionRef.ts`: the CLI's thread id and the cwd), falling back to a
new thread when the CLI has no rollout for it. Each turn is a `turn/start`
naming the thread's model and effort; `modes.ts` keeps the approval policy
`untrusted` in every mode and varies only the sandbox. `userInput.ts` and
`attachments.ts` send images as `localImage` inputs and name other files by
path. `translate/` turns notifications into runtime events: `tools.ts` (item
rows), `usage.ts` (turn usage from the thread's running total, and the
context) and `translator.ts` (turns, errors, warnings, MCP status, and the
`IGNORED` list). The command and file-change approvals go through the shared
approval gate (`toolGate.ts`, `approvals.ts`): each request becomes a `Shell`
command (the script inside the CLI's login-shell wrapper) or one `Edit` per
path the file change's item named, the ladder decides, and a prompt opens a
card on a fiber of its own. Allow, allow always and allow for the session
answer `accept` (the session is Poseidon's rule, so the CLI keeps asking and
the ladder answers), deny `decline`; Stop answers an open card
`cancel`, closing answers nothing, and a request the CLI withdraws
(`serverRequest/resolved`, or its turn ending) resolves its card `deny`. A
turn in which a file change, or a command outside the CLI's known-safe reads,
ran with no request ends with a `session.warning`. On the recording machine
0.156.1 asked about every command, `cat .env` under full access included.
An MCP tool call is asked about as an `mcpServer/elicitation/request` marked
`codex_approval_kind: mcp_tool_call` (`mcpApprovals.ts`); it goes through the
same gate as an `mcp_tool` request (`mcp__<server>__<tool>`), so the in-app
browser's tools run on Codex once allowed. `serverRequests.ts` refuses what
has no card: extra sandbox permissions, any other MCP elicitation and the
older protocol's approvals, each with a warning.

Plan mode, questions, steering and compaction (all four capabilities true,
each backed by a recording): a plan turn sends `collaborationMode: plan` on
`turn/start` (experimental, which is why the handshake sets
`experimentalApi`), and from then on every turn names its mode with the turn's
model and effort (`plans.ts`); a resumed thread does so from its first turn.
The `plan` item is the plan row, and a turn that ends `end_turn` with one
emits `turn.plan.proposed`; accepting is the server's next turn. The model's
`item/tool/requestUserInput` is the question card (`questions.ts`), answered
by option label; Stop answers it empty, and a withdrawal or close answers
nothing, each resolving the card once. `steer` is `turn/steer` with the
running turn's id as `expectedTurnId` (`steering.ts`); the CLI keeps the turn,
and any refusal is `NotSteerable` for the server to queue. A `/compact` turn is
`thread/compact/start` (`compaction.ts`); the CLI runs it as a turn of its
own, whose id only its `turn/started` names.

Its extensions: `extensions/skills.ts` reads the skill roots the CLI loads
(the project's `.codex/skills` and `.agents/skills`, `CODEX_HOME/skills`, and
`~/.agents/skills`), and `extensions/mcpServers.ts` lists, adds and removes
MCP servers through `codex mcp`, keeping the names Poseidon added in
`CODEX_HOME/poseidon-mcp.json` since the CLI carries no ownership marker, and
`sessionFiles.ts` lists and reads the CLI's own rollouts under
`CODEX_HOME/sessions` for an import.

May import `connector-sdk`, `contracts` and `shared`; its tests also import
`testkit`. It is the only place in the tree that knows `codex` exists, apart
from the line in `boot.ts` that registers it.

### packages/client-runtime

Everything a client needs that is not React.

- `connection.ts` — the reconnecting supervisor. Effect's socket protocol is
  single-use, so reconnecting rebuilds socket, protocol and `RpcClient`
  underneath callers; `Connection.client` is a per-call accessor that waits for
  whichever client is live. `ConnectionStatus` includes a terminal
  `incompatible` for a protocol-version mismatch.
- `clientState.ts` — the client-side fold: `ThreadStreamItem`s onto a
  `ThreadDetailSnapshot`, `ThreadListStreamItem`s onto a summary array. A
  projection of the server's projection; it decides nothing. Between snapshots
  it appends the same decision records the server keeps, and the next snapshot
  is authoritative.
- `atoms.ts`, `gitAtoms.ts`, `fileAtoms.ts`, `fsAtoms.ts`, `browserAtoms.ts` — the
  atom factories. `browserAtoms.ts` holds `devServersAtom(threadId)`, which a
  failed call leaves an empty list rather than an error. `fileAtoms.ts` holds
  `fileStatAtom`, keyed by the sorted, deduplicated set of paths so the same
  candidates are one call and then a cached answer, held five minutes after its
  last reader so a timeline row scrolled away and back does not ask again,
  and by a revision the caller names (the timeline's count of settled turns
  and restores), so an answer from before files were created or removed is
  asked again; a set larger than one `files.stat` carries goes out as several
  calls. `statFiles` asks the same as a one-shot call, for the terminal's file
  links, which keep their own answers. Its `createFile` is the `files.create`
  one-shot call (`oneShot.ts`), resolving with its own `Exit`.
  `gitAtoms.ts` holds `checkpointsAtom`, keyed by the thread and a revision the
  caller names (the timeline passes its fold's checkpoint count), so a list
  read before a checkpoint was created is never mistaken for one after it; a
  project refresh rereads it like every git read. The
  renderer builds the file and git read atoms once per client runtime
  (`panes/files/file-atoms.ts`, `panes/changes/git-atoms.ts`), so the fixture
  pages get them over their scripted client.
- `gitCommands.ts` — the worktree writes: create, the setup script (a stream
  atom whose value is the run so far, so the output shows as it arrives) and
  remove; and the header's commit, push and pull request. Built on
  `gitAtoms`: a worktree write refreshes the project's branch list, a commit
  or push refetches every git read of the project.
- `gitReview.ts` — the Changes pane's discard (a one-shot that refetches every
  git read of the project) and blame (an atom per file and line range, read
  through `gitAtoms` so a refresh rereads it). The renderer binds it per
  client runtime next to the git reads (`useGitReview` in
  `panes/changes/git-atoms.ts`).
- `editors.ts` — `editorsAtom`, the server's `editors.list`, listed once per
  connected epoch and kept alive so the header and every file menu share one
  answer (a failed call is the empty list, which hides the "Open in" control);
  and `openIn`, a one-shot `editors.open` that resolves with the server's
  refusal for a toast. The renderer builds them once per client runtime
  (`open-in/editor-atoms.ts`), and `open-in/favourite.ts` picks the button's
  editor from the stored `preferredEditor`, falling back to the first editor
  found. The thread header's split button (`open-in/open-in-control.tsx`)
  reads both, and remembers an editor picked from its menu as the favourite
  (`open-in/use-open-in.ts`). The file menus of the Changes and Files panes
  (`open-in/file-menu.ts`, `open-in/file-menu-items.tsx`) open single files
  through the same call, in the workspace their pane provides
  (`open-in/file-menu-scope.tsx`).
- `searchAtoms.ts` — `messageSearchAtom(query)`, one `threads.searchMessages`
  call per query, run once per connected epoch. A new query is a new member of
  the family, so the old one is disposed with its last reader and its call is
  interrupted; a failure is a value (`{ _tag: "error", message }`), and a
  query under three characters answers no hits without asking the server.
- `scriptAtoms.ts` — `detectedScriptsAtom(scope)`, the server's
  `scripts.detect` for a project or one thread's root, asked once per
  connected epoch while mounted. It is not kept alive and nothing preloads
  it: only the open Run menu reads it, so detection runs when the menu opens.
  A failed call is the empty list. The renderer builds it once per client
  runtime (`run/script-atoms.ts`) for the header's Run control
  (`run/run-control.tsx`).
- `oneShot.ts` — `runOneShot`, how every git write but the start panel's
  setup atom runs (a setup nothing watches, `worktreeSetupRun`, is one too): a
  fresh atom per call, held until it settles. A shared `runtime.fn` atom would
  interrupt a call still in flight when the next one starts and hand the first
  caller the second's result; two threads committing at once, or two deleted
  threads removing their worktrees, must not.
- `oneShotCommands.ts` — `dispatch` and `stageAttachment` as one-shot calls,
  for starts that run in the background or side by side. `dispatchAtom` and
  `stageAttachmentAtom` are single atoms the composer shares, so a second
  start would interrupt the first. The renderer binds them to its registry in
  `lib/one-shot-commands.ts`.
- `generationCommands.ts` — `git.generateCommitMessage`,
  `git.generatePullRequest` and `thread.regenerateTitle` as one-shot calls,
  each taking an `AbortSignal` that interrupts the call on the server (which
  stops the harness). The renderer binds them to its registry, with the
  availability check and the cancellable runner the Generate buttons share,
  in `lib/use-generation.ts`.
- `terminalAtoms.ts` — an owner's terminal list (a thread's, a project's or
  home's, by `terminalOwnerKey`), every thread's running
  terminals in one listing (`runningTerminalsAtom`), the open/write/resize/close
  calls, and `terminalAttachAtom`, which hands one terminal's output to a
  callback item by item. It is a `runtime.fn`, not an atom over the stream,
  because an atom built from a stream keeps only the last item of each chunk.
  It reattaches with a fresh snapshot after a dropped socket or an overflow,
  and reports a terminal the server no longer knows as `gone`. Input goes
  through one lane per terminal, so keys typed while a write is in flight
  follow it in order as the next write.
- `connectorAtoms.ts` — `modelCatalogAtom`, every enabled connector instance
  with its models in `connectors.list` order, which the model pickers and the
  Models settings page read. It follows `connectorsAtom`, and an instance whose
  `connectors.models` fails lists no models without emptying the others. It
  stays whole: the Models page's harness and model switches filter only what a
  picker lists (`visibleCatalog`), so lookups such as the effort ladder and
  context window still see a switched-off model.
- `resolver.ts`, `desktop.ts` — how a client finds its server and its shell.
- `composerTrigger.ts`, `keybindings.ts` — shared input logic. `keybindings.ts`
  is the matcher: chord notation, matching one keypress, `when` clauses and the
  text-field rule.
- `keymap.ts` — the keymap as a whole: the context keys a `when` clause may
  name and the axioms between them, the physical chord a binding is on each
  platform, the overlap-aware conflict finder, and the chords the system owns.
  `default-keymap.test.ts` runs these checks against the shipped and reserved
  keymaps.

May import `contracts` and `shared`.

### packages/shared

Dependency-light helpers both sides need: `ids.ts` (UUIDv7), `paths.ts`
(`~/.poseidon` and everything under it), `permissionPattern.ts` (the pattern
parser and matcher, shared so the renderer previews an "allow always" rule with
the exact semantics the server enforces), `imageBytes.ts` (magic-byte sniffing
and the attachment size cap), `decisionSubject.ts` (the one-line subject a
resolved decision is recorded with, shared so both folds write the same words),
`browserBridge.ts` (the browser bridge's launch key and per-thread capability,
shared because the shell verifies what the server mints), `branchSlug.ts` (the
worktree branch and directory slug, shared so New task's compare fan-out can
pre-slug names that keep their model suffix under the server's 40-character
cut). Imports no workspace package at all.

### packages/ui

The base component set (`src/components`), hooks, `lib`, and `globals.css`.
Imports no workspace package.

### packages/testkit

Test infrastructure, never shipped.

- `packages/testkit/fixtures/<kind>/` — real recordings of each harness, one directory per
  scenario, keyed by the connector kind. `fixtures/cmd/` holds Command Code's, indexed by its
  `README.md`; `fixtures/agent-browser/` holds agent-browser's CDP traffic through the browser
  bridge. Nothing in them is hand-written; when the CLI changes they are re-recorded.
- `packages/testkit/src/recording.ts` — the transport-neutral recording format: the versioned
  manifest (`formatVersion`, `kind`, `transport`, `real: true`, with defaults for manifests that
  predate those fields), `RecordedFrame` (direction, channel, optional timestamp, data), the
  `fixtures/<kind>/` lookup, `readFrames` for a JSON-lines capture, and the `Replayer` shape
  each transport implements.
- `packages/testkit/bin/replay-cmd.mjs` — puts a recording back on the wire with no behaviour of
  its own; `packages/testkit/src/replayCmdProcess.ts` loads a recording through `recording.ts`,
  flattens a turn into `RecordedFrame`s, and produces the spawn configuration that makes the
  replayer stand in for `cmd` (`cmdReplayer`, transport `stdio-ndjson`).
- `packages/testkit/bin/stdio-tee.mjs` and `packages/testkit/src/sdkStreamRecording.ts` — the
  `sdk-stream` recorder. It is a launcher that tees a real CLI's stdio into `RecordedFrame`s,
  and a finaliser that scrubs the capture into `fixtures/<kind>/<scenario>/`.
  `packages/testkit/bin/replay-sdk-stream.mjs` and `packages/testkit/src/replaySdkStream.ts`
  (`sdkStreamReplayer(kind)`) are the replay half. It is gated on stdin, rewrites the SDK's
  request ids, and exits 97 on divergence. See
  [development.md](development.md#sdk-stream).
- `packages/testkit/src/stdioJsonRpcRecording.ts` — the `stdio-jsonrpc` recorder: the same tee
  and finaliser, with JSON-RPC's defaults. `packages/testkit/bin/replay-stdio-jsonrpc.mjs` and
  `packages/testkit/src/replayStdioJsonRpc.ts` (`stdioJsonRpcReplayer(kind)`) are the replay
  half, gated per JSON-RPC message and rewriting the connector's request ids. See
  [development.md](development.md#stdio-jsonrpc).
- `packages/testkit/src/fakeConnector.ts` — a real `ConnectorDefinition` whose sessions replay a
  scripted event list, for everything above the connector layer. With `steering` on its sessions
  offer `steer`, recorded as a call like every other method, and `refuseSteering` makes each
  one fail so a test can take the fallback to the queue. A scripted `generateText` gives every
  instance a `generateText` that calls the test's own function in process, and turns
  `textGeneration` on; the generated-text service's tests write through it.
- `packages/testkit/src/receipts.ts` — await a command by its receipt instead of sleeping.
- `packages/testkit/src/sqlite.ts` — a throwaway database on the same engine the server uses.
- `packages/testkit/scripts/record-cmd.mjs` and `record-probe.mjs` — the
  recorders. They spend a
  real account's plan, so they are never run from CI.
- `packages/testkit/scripts/record-agent-browser.mjs` — records the real agent-browser through
  the real bridge, in front of real Electron webviews
  (`apps/desktop/scripts/bridge-recording-host.mjs`). Run by hand.

May import `contracts`, `connector-sdk`, `shared`.

## The data model

SQLite through `node:sqlite`'s `DatabaseSync`, one connection for the process,
serialised by a semaphore (`apps/server/src/persistence/Sqlite.ts`). SQLite is a
single-writer engine and keeping every statement on one connection is what makes
`withTransaction` mean what it says. WAL on, `busy_timeout` 5000ms. The database
holds every prompt, answer, tool input and diff, so the directory is created
0700 and the database and its `-wal`/`-shm` siblings are chmodded 0600 — on
every open, because neither `mkdir` nor `open` lowers the mode of something that
already exists.

### Events

`events` is append-only and is the source of truth. Everything else is a
projection of it.

| Column                                               | Meaning                                                  |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `sequence` (INTEGER PK AUTOINCREMENT)                | the global cursor: client resume and projector watermark |
| `event_id`                                           | unique event id                                          |
| `stream_kind`, `stream_id`                           | the aggregate: `project` or `thread`, and its id         |
| `stream_version`                                     | per-stream 1..N, unique with the two above               |
| `type`, `payload_json`, `occurred_at`                | the event itself                                         |
| `command_id`, `causation_event_id`, `correlation_id` | provenance                                               |
| `actor`                                              | `user`, `system` or `connector`                          |

Indexes: `(stream_kind, stream_id, sequence)`, `(command_id)`,
`(correlation_id)` and `(type, sequence)`.

`EventStore.append` reads the stream's current maximum version, assigns
`base + n`, and relies on `UNIQUE (stream_kind, stream_id, stream_version)` as
the optimistic-concurrency backstop. The engine serialises writers, so a
violation means a bug rather than contention, and it surfaces as
`ConcurrencyConflict`.

Every planned event is decoded against the `OrchestrationEvent` union _before_
it is written. The refined schema types are not branded — `NonEmptyString`'s
`.Type` is plain `string` — so TypeScript accepts values the schema rejects, and
a row like that is a poison pill: every read path decodes, so one bad payload
stopped the thread opening and took the server's boot replay with it. A rejected
payload now fails the command that produced it (`InvalidEvent`). On the read
side, a row that still cannot be decoded is logged and skipped rather than
thrown, because throwing escaped as a defect past `Effect.catch`.

`command_receipts` (`command_id` primary key, status, reason, `last_sequence`)
is what makes dispatch idempotent: a retried `commandId` returns its stored
receipt instead of deciding again. That is what makes reconnects and client
retries safe, and it is why every id a command needs is minted by the caller.

### Projections

`projects` is the sidebar's project row. `threads` stores `thread_id`,
`project_id`, `title`, `status` and `doc_json` — the whole thread document as
JSON. The snapshot _is_ the projection, so a snapshot read is a single-row fetch
and a rebuild is a pure fold. `ThreadDoc`
(`apps/server/src/orchestration/state.ts`) is the wire `ThreadDetailSnapshot`
plus the bookkeeping the decider needs and the wire never sees: the full open
approval set, pending user inputs, the list preview, the `deleted` flag.

`thread_messages` is the message-search index: one row per user or assistant
message with non-empty text (`thread_id`, `item_id`, `role`, `text`), under an
external-content FTS5 table, `thread_messages_fts`, with the trigram tokenizer,
so a query matches any case-insensitive substring of three characters or more.
Tool output, command output, diffs and reasoning are never indexed.
`ReadModelStore.putThread` syncs the thread's rows in the same transaction as
its document (`persistence/MessageIndex.ts`): new messages are inserted, a
message whose text changed is reindexed, an unchanged one is left alone, and a
message no longer in the document is dropped. `removeThread` and
`clearProjections` empty it with the rest. `ReadModelStore.searchMessages`
answers one hit per thread (its newest matching message) with a one-line
snippet around the match, most recently active thread first, archived threads
included and marked, at most 50. `threads.searchMessages` serves it through
the `MessageSearch` service (`persistence/MessageSearch.ts`); a failed query
reaches the client as a bare `internal` error.

`worktree` is on the wire too, on `ThreadDetailSnapshot` and `ThreadSummary`:
the git worktree a thread works in — its absolute `path`, its `branch` and the
`baseBranch` it was cut from — or absent for a local thread on the project's
root. `thread.create` names it, `thread.created` records it and nothing
changes it afterwards; the decider refuses a path that is not absolute. The
field is optional on the command, the event and both read models, so every
event and snapshot written before it existed decodes as a local thread, and
the document reads a `doc_json` without it as `null` (`worktreeOf`).

The thread's **workspace root** is its worktree's path when it has one and the
project's `workspaceRoot` otherwise (`orchestration/workspaceRoot.ts`). The
session starts there, the permission gate judges sensitive paths against it,
checkpoints are captured and restored there, and `git.status`, `git.diff`,
`files.search`, `files.read`, `files.stat` and `checkpoints.list` read it when
the call names the thread, and `files.create` writes there (`threadId` is
optional on their payloads; without it they use the project's root, and a
thread of another project is ignored).
Checkpoint prune is the one exception and stays on the project's root: the
hidden refs are shared by every worktree of a repository, and a deleted
thread's worktree may already be gone.

`files.stat` (`apps/server/src/git/stat.ts`) answers which of a batch of paths
exist in that root. A relative path resolves against the root; an absolute one
counts only under the root as stored or under its canonical form, since a
harness may report either. Every target is then resolved through its symlinks
and has to land strictly inside the canonical root, the check `files.read`
makes, so `..`, an absolute path elsewhere and a link out of the workspace are
never reported, and neither is the root itself. A path that fails is left out
of the answer rather than failing the call. Each answer carries the path as it
was asked, the root-relative path (a link's own name when it went through an
in-root symlink) and that path joined onto the root.

`files.create` (`apps/server/src/git/create.ts`) is the one file write, used by
a plan card's Save as .md. It only creates: the path must be relative, end in
`.md` (`FILES_CREATE_EXTENSION`) and stay under the root, and the deepest
folder of it that already exists must resolve, symlinks followed, inside the
canonical root before any missing folder is made. The file is opened with the
exclusive-create flag, so an existing file, or a link at the name, fails
`conflict` and is left alone; every other refusal is `invalid`. The answer is
the root-relative path it wrote.

A worktree comes from `git.worktree.create` (`apps/server/src/git/Worktrees.ts`)
before the thread is created: a branch named from the settings document's
`git.branchPrefix` (default `poseidon/`) and a slug of the thread's first
message, cut `--no-track` from the chosen base, in
`~/.poseidon/worktrees/<project slug>/<slug>` — never inside the user's
repository. The directory root is the `WorktreesRoot` service, which `boot`
points at `worktreesDir()` and a test at a tmp directory. The settings
document's `projectSettings` holds each project's optional `setupScript`,
which `git.worktree.setup` runs there; both keys are defaulted on decode, so a
settings row written before them still reads. Both are edited on the Git &
worktrees settings page (`apps/web/src/components/Settings/git-panel.tsx`,
also reached from a project's overflow menu). Removing a worktree and running
the script in one both take the path only when it is a registered, non-main
worktree of the project's repository. The start screen is where a thread gets
one: its Local / New worktree picker runs create, setup and `thread.create`
in that order (`apps/web/src/components/thread/start-in-worktree.ts`), and the
thread header's branch picker (`apps/web/src/components/git/branch-picker.tsx`)
and sidebar row mark a worktree thread with its branch. The picker switches or
creates a branch only for a local thread; a worktree thread's branch is its
own. Beside it, the git actions control
(`apps/web/src/components/git/git-actions-control.tsx`) commits, pushes and
opens a pull request from the thread's root, as stacked steps planned by
`apps/web/src/lib/git-actions.ts` — and, in the New task page's header, from
the project's own folder. The Changes pane's "Branch vs base" scope
compares the thread's root with the worktree's `baseBranch`, or with the
repository's default branch for a local thread.
Deleting such a thread is where one goes: the delete confirmation offers to
remove the worktree after the delete is accepted, never with `force` unless
the user confirms twice (`apps/web/src/components/sidebar/delete-thread.ts`).
Removing a project removes no worktrees.

`decisions` is on the wire: one `ResolvedDecision` per settled approval,
question or plan, oldest first — its kind, the request id (the turn id for a
plan), the outcome (`unanswered` when the runtime released the request as its
process exited, before the user chose), a one-line subject, the pattern an approval kept, when it
landed and `afterItemId`, the thread's last item at that moment. The event
payloads carry nothing new; the fold reads the subject off the open request
before it clears it. The field is optional on `ThreadDetailSnapshot`, so a
snapshot from before it existed still decodes as "none".

The sidebar's `ThreadSummary` says whether anything waits on the user
(`awaitingInput`) and which card it is (`awaiting`): the most urgent open one,
`approval` before `question` before `plan`, and absent when nothing waits. A
row can tell "needs you" from "plan ready" without subscribing to the thread.
While the thread is `running`, `runningSince` is when the turn in flight was
requested (stamped on `ThreadDoc.currentTurn.startedAt`); it is absent
otherwise and optional, so older summaries still decode.

The summary also carries the sidebar's Active/Done split
(`apps/server/src/orchestration/threadDone.ts`). `doneAt` is when the user
marked the thread done (`thread.done.marked`); `thread.done.cleared` and
`thread.unarchived` drop it. `lastActivityAt` is the last `thread.created`,
`turn.requested`, `turn.steered`, `message.queued`, `turn.completed`,
`unarchived` or `done.cleared`. A thread is marked done while
`doneAt >= lastActivityAt`, so newer activity brings it back with no event of
its own. Auto-done is the client's: it compares `lastActivityAt` with the
`autoDoneAfterDays` setting, and the server never stores it. Both fields are
optional on the wire; a `ThreadDoc` projected before them is read through
`doneAtOf` and `lastActivityOf`, which falls back to `updatedAt`. Neither
done event moves `updatedAt`: marking a thread done or active changes nothing
in it, so its row time and unread dot stay where they were.

`projection_state` holds one row per projector: `last_applied_sequence`,
`updated_at` and `projector_version`. Projections are written inside the
command's transaction, so a projection can never get ahead of its events.

### Migrations

Numbered files under `apps/server/src/persistence/migrations/`, listed in a
static record in `Migrations.ts`, applied in id order, each in its own
transaction. Ids must be contiguous from 1 and existing files are never edited
once merged; a lineage test enforces both. Every layer that reads a table
provides the migrations layer, so the graph itself says the schema exists first.

| Migration                  | What it adds                                                          |
| -------------------------- | --------------------------------------------------------------------- |
| `0001_events`              | `events`, its indexes, `command_receipts`, `projection_state`         |
| `0002_projections`         | `projects`, `threads` and their indexes                               |
| `0003_settings`            | `settings`, `permission_rules`                                        |
| `0004_projector_version`   | `projection_state.projector_version`                                  |
| `0005_events_type_index`   | `events(type, sequence)`                                              |
| `0006_terminal_keybinding` | `terminal.toggle` → `Cmd+J` in a stored keybinding table              |
| `0007_dock_keys_new_task`  | stored dock keys' `threadOpen` clause → `threadOpen \|\| newTaskOpen` |
| `0008_message_search`      | `thread_messages` and its FTS5 index, backfilled from `threads`       |

### Rebuilding projections

`threads.doc_json` is parsed straight back into a `ThreadDoc` with no schema and
no version, so the first release that adds a field would serve stale rows
missing it. The engine stamps `PROJECTOR_VERSION` (currently `4`) on every
watermark write and compares it at boot: on a mismatch it clears the projection
tables inside one transaction, re-folds every stream from `allEvents`, writes
the documents back and stamps the new version. Rows written before the column
existed read back as `0`, which is exactly right — they are stale by definition.

The 0005 index exists for the same class of problem from the other side: the
checkpoint reactor's boot replay used to scan and decode every thread event ever
written, inside the layer build, under the desktop supervisor's fixed 15-second
handshake timeout. With the index it asks for four event types and reads a
handful of rows.

## The orchestration loop

`OrchestrationEngine` (`apps/server/src/orchestration/Engine.ts`) is the single
writer of durable state. Two entry points: `dispatch(command)`, which runs the
decider, and `appendThreadEvents(threadId, planned)`, which is the same append
path without it, for connector- and system-originated events. Both take the
one write mutex.

```
dispatch(command)
  │
  ├─ store.receipt(commandId) ─── already recorded? ──► return that receipt
  │
  └─ BEGIN (one SQLite transaction)
       loadStream(kind, id) ──► foldThread / foldProject ──► state
       buildContext(command) ───────────────────────────────► ctx
       decide(command, state, ctx, env)
          │
          ├─ rejected ─► recordReceipt(rejected, lastSequence)
          │
          └─ accepted
               store.append(events)   → sequence + streamVersion assigned
               applyProjection()      → threads.doc_json / projects
               setWatermark(PROJECTOR, last, now, PROJECTOR_VERSION)
               insertPermissionRule()  (only for "allow always")
               recordReceipt(accepted, last)
     COMMIT
       │
       ├─ publishAll(events)      → subscriptions, reactors
       ├─ invalidate(rules)       → only when a rule was written
       └─ publish(acceptedCommand) → ProviderCommandReactor
```

`decide` (`decider.ts`) is pure: command plus folded stream state plus
cross-aggregate facts plus an id/clock environment, in; events out. No clock, no
I/O, no id minting of its own, which is why a scripted conversation replays
byte-identically in tests. A rejection is a result, not an exception — the
command receipts as `rejected` and nothing is appended.

`DeciderContext` carries the facts the decider may check that are not in its own
stream, gathered inside the transaction: whether the project exists, whether a
workspace root is taken, whether a sibling thread that shares this thread's
workspace root has a checkpoint restore in flight (the git work covers that
whole directory, so the exclusion covers every thread working there: all of a
project's local threads, or all the threads of one worktree), the settings
defaults a `thread.create` without them inherits, and — for a `thread.create`
that forks — the source thread's document as the read model holds it
(`forkSource`, `null` when there is none).

`appendThreadEvents` accepts a function of the thread document instead of a
fixed list. The function runs inside the write transaction on the document as it
is at append time, so a caller whose events depend on current state — "send the
head of the queue" — cannot be overtaken by a command decided between its read
and its append.

### Commands and events

Twenty commands (`packages/contracts/src/orchestration.ts`):
`project.create`, `project.remove`, `thread.create`, `thread.rename`,
`thread.archive`, `thread.unarchive`, `thread.delete`, `thread.turn.start`,
`thread.turn.steer`, `thread.turn.interrupt`, `thread.task.stop`, `thread.settings.update`, `thread.approval.respond`,
`thread.userInput.respond`, `thread.plan.respond`, `thread.queue.remove`,
`thread.queue.reorder`, `thread.checkpoint.restore`, `thread.done.mark`,
`thread.done.clear`.

Thirty-five events, from `project.created` through `thread.error`, then
`thread.done.marked` and `thread.done.cleared`. `thread.done.mark` is refused
for a missing, deleted or archived thread; `thread.done.clear` is accepted for
any thread that exists, marked or not, because a thread that went to Done on
its own did so on the client. The catalogue
is kept as data (`commandTypes`, `orchestrationEventTypes`) and a test holds
each list and its union in lockstep. The value objects the commands, events
and read models share — `ThreadSettings`, `QueuedMessage`, `ThreadSession` and
the rest — live in `thread.ts` beside it, and `orchestration.ts` re-exports
them, so that is still where they are imported from.

`thread.create` may name a thread to fork (`fork: { threadId, throughItemId? }`).
The decider (`forkSeed.ts`) refuses a source that is missing, deleted or in
another project, an item that is not one of the source's user messages, a
message of the source's running turn, and the whole thread while a turn runs. Otherwise the title defaults to
"<source title> (fork)" and the settings to the source's — its model, effort,
runtime mode and harness (the bound session's instance first), and ultracode
unless the command names an effort of its own, never plan
mode — under whatever the command names. `thread.created` then carries a
`ThreadFork`: the source's id and title, the message, and a plain-text
transcript of the source's user and assistant messages and plans through the
end of that message's turn (the whole thread without one), capped near 60,000
characters by dropping the oldest turns behind an `[earlier turns omitted]`
line. The transcript lives on the event, so a fork keeps it when the source
is renamed or deleted; the summary and snapshot carry only
`forkedFrom: { threadId, title }`. `fork` and `forkedFrom` are optional, so
events and documents written before forks decode unchanged.

A fork can also be native (`nativeFork.ts`). When the source's bound session
declares the `fork` capability, nothing runs in the source, the fork point is
its latest turn (or the whole thread), and the fork stays on the source's
connector instance (pinned in its settings) and in the source's workspace,
the `ThreadFork` also records `session: { connectorInstanceId, sessionRef,
afterTurnId }`, `afterTurnId` being the source's latest turn then. The fork's
first session then comes from `resumeSession({ sessionRef, fork: true })` on
that instance instead of `startSession`, and the harness copies the
conversation itself. The harness copies the session as it stands on the fork's
first turn, so the session manager first reads the source again
(`sourceStillAt`): it must be idle, on the same `sessionRef`, with no turn
after `afterTurnId`. The transcript is recorded anyway: if the source has run
on since, or that resume fails, the session manager starts a fresh session and
the transcript goes ahead of the first message as for any other fork. Every other fork — an earlier message, a
running source, another harness or workspace, a harness without `fork` —
is a copy.

`thread.create` may instead record an import (`imported: ThreadImport`, from
`sessions.import`): the connector kind, the session's `sourceId`, and the
harness session to continue when the instance can resume. `thread.created`
carries it and the document keeps it; it is optional, so older events decode
unchanged, and it stays off the wire. The imported thread's first session
comes from `resumeSession({ sessionRef })` on the recorded instance
(`pendingImportResume`), without `fork`, while the thread has no session, is
on its first turn, and still names that instance in its settings — a thread
moved to another harness never resumes a foreign session. When there is no
session to resume, the resume fails, or the connector started afresh in its
place (its session's `sourceIdOf` names another session), the session manager
uses a fresh session and the first message carries the thread's items before
that turn as a transcript, with a line saying the conversation continues one
the harness recorded (`withForkContext`). Later turns carry nothing extra.

A plan's "Implement in new thread" goes through the same dialog but is not a
fork: the renderer sends `thread.create` with the source's settings out of plan
mode and no `fork`, sends the plan as the first turn, and, while the plan is
still pending (from its card or its timeline record), answers the source's plan
`handoff` (`branch-off.ts`, `use-branch-off.ts`).

`thread.turn.steer` is how a message reaches a turn that is already running.
The decider decides it from the thread's bound session: `thread.session.bound`
carries the `ConnectorCapabilities` the session announced, and only a session
whose `steering` is true is steered — `thread.turn.steered`, stamped with the
running turn; the user's row follows from the reactor once the message is
delivered. Everything else about the command is the
same as `thread.turn.start`: the same checks bar it, with no turn running it
starts one, while an interrupt settles it queues, and for a harness whose
session says it cannot steer it is refused with the queue as the recourse.
Before anything has said either way — no session bound yet, or one bound
without capabilities — it is queued. `capabilities` is optional on the session
and on the event, so a log written before it decodes.

Commands do not appear as individual RPCs: `orchestration.dispatch` takes the
whole union, which is what keeps the decider the single place a state change is
decided.

A thread chooses its harness through `ThreadSettings.connectorInstanceId`, set
on `thread.create` or by `thread.settings.update`. The field is optional: events
written before it existed decode unchanged, and absent means the default routing
rule. The choice can change only until the thread has a bound session, a
running turn or a user message — `threadLocksConnector` in the contracts is that
rule, read by the decider (which rejects a change after it, suggesting a new
thread) and by the renderer's picker alike. After the lock, "a change" means
naming an instance other than the one the thread runs on — the bound session's,
which routing may have chosen over the stored one — so naming that instance
again is accepted and left out of the event, and a thread with neither a
session nor a stored instance has nothing to change. The field is routing, not
a session setting: the reactor strips it before `handle.updateSettings`. The renderer's
model picker is where the choice is made: a harness avatar per enabled
instance, with a flyout of its models, and a pick sends the instance with the
model. Settings → Models can switch a
harness or a model out of the pickers (`Settings.modelPicker`); that filters
the list only, never routing, so a thread already on it keeps it.

A turn's input is the same four fields wherever it travels —
`thread.turn.start`, `QueuedMessage` on `thread.message.queued`,
`thread.turn.requested`, and the connector's `TurnInput`: the `text`, the
`attachments` (staged file references, never bytes), the `mentions`
(workspace-relative paths) and the `references` (`TurnReference`: a
`kind` of `skill` or `plugin` and a `name`). `references` is optional
everywhere, so events written before it existed decode unchanged and absent
means none; the decider leaves the field off when there are none. The
`user_message` row the decider mints with the turn carries the attachments
and the references, each only when there are some; mentions are not copied
onto it. The queue drain redispatches a `QueuedMessage` field by field, so
each of the four has to be copied there, and a resumed session re-sends the
in-flight turn's input from the thread document, references included.

### Reactors

A reactor consumes the engine's published streams and performs the side effect
an event calls for. Reactors never dispatch as an input to a decision that has
already been made; they act on what was decided. Four of them are merged in
`boot.ts` — `ProviderCommandReactor`, `CheckpointReactor`, `AttachmentReactor`
and the session supervisor — and they subscribe eagerly at layer build, because
a forked fiber does not start until the builder yields and the engine's PubSub
drops what it publishes while nobody is listening. `RuntimeIngestion` is the
exception: one fiber per session, forked by the session manager.

| Reactor                              | Watches                    | Does                                                                                                                                                        |
| ------------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProviderCommandReactor`             | the event stream           | turn send, steer, interrupt, approval/question/plan responses, settings push, queue drain, session close, cascade of `project.removed` into `thread.delete` |
| `RuntimeIngestion` (`ingestSession`) | one session's event stream | `RuntimeEvent` → `PlannedEvent`, appended and tagged with the runtime event that caused it; reports session end on the lifecycle channel                    |
| `SessionSupervisor`                  | boot scan + lifecycle      | resumes or marks lost                                                                                                                                       |
| `CheckpointReactor`                  | the event stream           | capture on turn completion, restore on a work order, prune on deletion                                                                                      |
| `AttachmentReactor`                  | the event stream + boot    | purges a deleted thread's attachments and sweeps unreferenced staged files                                                                                  |
| `TitleReactor`                       | the event stream (live)    | names a thread still called "New thread" from its first message, beside its first turn                                                                      |

`TerminalService` (`apps/server/src/terminal/TerminalService.ts`) carries one
more watcher of its own, subscribed the same eager way inside its layer: on
`thread.deleted` or `thread.archived` it kills that thread's shells.

**`ProviderCommandReactor`.** `turn.requested` → ensure the session and
`handle.send(turnId, turn)`. A fork's or an imported thread's first turn — no session of the thread bound in
an earlier turn (the fold records the turn one first binds in as
`forkSeededIn`), so a first turn that failed before reaching the harness
leaves the next one first — is sent with the earlier conversation's transcript and a line saying what
it is ahead of the user's text (`withForkContext`), here and in the mid-turn
resend after `session.bound`; the user's row keeps only what they typed, so
the transcript never reaches the timeline or message search. A session the
harness forked natively, or an imported session resumed, goes without it: the
session manager says so (`forkedNatively`), for the sessions this process started. `turn.steered` →
`handle.steer(turnId, turn)`, then the user's `user_message` row on that turn
once it is delivered; when there is no live handle or the steer fails, no row
is written there and the message is dispatched
again as `thread.turn.start { queued: true }` — a new turn if the running one
has ended, the queue if not — and put on the queue directly if even that is
refused, so it is never lost. `turn.interrupted` → `handle.interrupt(turnId)`,
and the turn stays in flight until the connector settles it — this fiber settles
it itself only when there is no live session left to do so.
`approval.resolved` / `userInput.resolved` / `plan.responded` → the matching
`respond*` on the live handle, plus the plan follow-up (a `handoff` answer only
leaves plan mode and starts no turn: the plan went to a new thread). `settings.updated` →
`handle.updateSettings`. `turn.completed` → dequeue the head of the queue and
dispatch it as a new turn, whatever its `stopReason`. After an interrupt that
is on purpose: a message sent while an interrupt settles is queued so it runs
once the connector is free, which is how interrupt-then-correct works. After a
failed turn (`stopReason: "error"`) it is a known gap, not a design choice:
when the connector keeps failing — auth, rate limit, a dead connector — each
queued message is sent into the same failure in turn. Pausing there would need
a resume command through the contracts, decider and reactor, and there is no
paused queue yet. A failing side effect records `thread.error` — and a
synthetic `turn.completed` when a turn was mid-flight — rather than leaving a
thread wedged in `running`. Four of the five errors it can see are tagged errors
with no message, so it falls back to the tag: "removed connector" reads very
differently from "session closed", and writing `""` onto `thread.error` produced
a row the union could not decode.

**`RuntimeIngestion`.** `translateRuntimeEvent` is pure except for a
per-session map of item snapshots: `content.delta` frames fold into the item
they belong to, so the log gets whole `thread.item.upserted` snapshots instead
of a delta stream. Streamed text is coalesced on the way in on a 50ms window —
every delta used to become its own upsert carrying the whole accumulated
snapshot, and every append rewrote the thread's whole `doc_json`, which is
O(N²). A held delta is flushed before any other event of the session, so the
log's order is still the connector's order.

**`SessionSupervisor`.** On boot it scans the thread read model inline during
layer build (at real boot the database is the only state that exists, so
"running with no session" genuinely means lost; forking would let live
dispatches interleave). A thread mid-turn or waiting whose session vanished gets
`thread.session.lost`; one still bound to a `sessionRef` gets a `resumeSession`
attempt, up to four attempts with 250ms doubling backoff, then `session.lost`.
While running it watches the lifecycle channel: a `crashed` end writes a visible
`thread.error` notice and starts the same resume loop; a `stopped` end is
deliberate and restarts nothing.

**`CheckpointReactor`.** `CheckpointHook` is the seam the git implementation
fills (`apps/server/src/git/CheckpointHook.ts` over
`apps/server/src/git/CheckpointStore.ts`); the default is an explicit no-op so
the stack runs without git. `turn.completed` → capture → `checkpoint.created`.
A restore is a durable work order: the accepted command writes
`thread.checkpoint.restore.requested` before any git runs, and only after the
git work does `thread.checkpoint.restored` or `restore.failed` follow. Orders
with no recorded outcome are replayed at layer build, so a crash between receipt
and git cannot drop the request. A restore that went through is kept on the
thread snapshot (`restores`, with the latest turn at the time), since it records
no checkpoint and the next turn starts from the restored one. An edit and
resend rides on the same order: `thread.checkpoint.restore` takes an optional
`resend` (text, attachments, mentions, references), the decider copies it onto
`restore.requested`, and the reactor dispatches `thread.turn.start` with it
right after appending `restored`, in the same run. The turn's command id is
the order's event id, so its receipt records that the send went out. A failed
restore sends nothing, a replayed order sends on replay, and a settled order is
never run again; a thread's latest `restored` order whose command has no
receipt, with no turn since the restore, is sent at layer build, which covers a
stop between `restored` and the send. No restart loses the edited message,
and none sends it twice. Thread deletion and project removal each prune
the hidden refs under the thread's prefix.

**`TitleReactor`** (`apps/server/src/generation/TitleReactor.ts`). It listens
to the live PubSub only and never reads the log, so a boot does not retitle a
thread the user left as "New thread". On a thread's first
`thread.turn.requested` — no user message from an earlier turn — while
`generation.autoTitle` is on (read at that moment) and the title is exactly
`DEFAULT_THREAD_TITLE`, it forks a job into its own scope and goes back to
listening, so the turn is never waited on. The job asks
`TextGeneration.autoTitle`, which writes a title from the first message and
appends `thread.renamed` (actor `system`) through `appendThreadEvents` with a
function of the document: the title is checked again inside the write, so a
rename the user made meanwhile stands. A thread gets one attempt per process.
Every failure goes to the log and nowhere else; the title stays.

**`SessionManager`.** Not a reactor but the thing reactors act through: one
driver per thread, being the turn-scoped handle plus the ingestion fiber
draining its events into the log. A driver is removed when its event stream ends
or when the thread is deleted. `ConnectorSelection` decides which instance a
thread runs on: by the bound session's persisted `connectorInstanceId` when it
has one; otherwise by the instance the thread chose
(`ThreadSettings.connectorInstanceId`) while that instance is open; otherwise
the default rule, the first instance in the settings document's order that is
actually open. `connectorRouting.ts` is the single reading of that order, shared
with the engine's model seeding so the two can never name different instances.
A `thread.create` that chose an instance and named no model is seeded from that
instance: its `defaultModel`, then its first model, ahead of the app-wide
default, which may belong to another harness.

### Subscriptions

`subscribeThread` and `subscribeThreadList` deliver `snapshot | replay →
synchronized → live`.

```
                     events PubSub
                          │
   subscribe first, then read the baseline (nothing commits in the gap)
                          │
  ┌───────────────────────┴────────────────────────┐
  │ afterSequence absent → snapshot from doc        │
  │ afterSequence present → replay streamAfter      │
  └───────────────────────┬────────────────────────┘
                          │ then { kind: "synchronized" }
                          ▼
   filter: this stream, sequence > cutoff
                          │
                          ▼
   ┌──────────────── LiveBuffer ─────────────────┐
   │ 50ms window, merge by key, arrival order     │
   │ boundary item (mergeKey null) flushes first  │
   │ retained items/bytes charged until pulled    │
   └───────────────────────┬─────────────────────┘
       over 1000 items or 8 MiB │
                               ▼
                 { kind: "resnapshot-required" }, then end
```

The budget is per subscription, and both ends agree on the numbers because they
live in `packages/contracts/src/rpc.ts`: `STREAM_BUDGET_ITEMS` 1000,
`STREAM_BUDGET_BYTES` 8 MiB, `STREAM_COALESCE_MS` 50. Every item delivered but not
yet pulled counts; pulling one releases its charge. A subscriber that falls too
far behind gets a terminal `resnapshot-required` and re-subscribes for a fresh
snapshot, rather than being fed a backlog it will never catch up with.

Coalescing merges replaceable items — the latest `thread.item.upserted` per
`itemId`, the latest usage frame per turn, the latest context frame — and leaves
everything else alone. An item with no merge key is a boundary: it flushes the
pending window first so ordering markers (`synchronized`, turn boundaries) are
never merged away. A merged item moves to the _end_ of the window, because it
carries the newest version of its key and belongs where that version arrived;
replacing in place made a window of two keys flush in first-seen order, and the
client drops an event whose sequence is not greater than the one it holds.

Two ordering details are deliberate. A thread subscription reads its snapshot
and takes the document's `snapshotSequence` as the cutoff. A list subscription
reads `lastSequence` _first_ and the documents second: with the documents read
first, a commit landing in the gap is both missing from the snapshot and
filtered out of the live pump, whereas the other way round a re-delivered event
is an idempotent `upserted`.

`terminal.subscribe` follows the same pattern with offsets in place of
sequences. It subscribes to the terminal's output hub, then reads the
scrollback into a `snapshot` whose `offset` is the total number of chars the
terminal has produced, and drops any live `output` at or below that offset.
Its LiveBuffer has no window and no merge key — every item is a boundary, since
two chunks of output are never the same thing twice — and its own budget,
`TERMINAL_STREAM_BUDGET_ITEMS` 4096 and `TERMINAL_STREAM_BUDGET_BYTES` 4 MiB in
`packages/contracts/src/terminal.ts`, because a busy shell produces many small
items. The stream ends after `exited`.

## The connector contract

### The definition

```ts
interface ConnectorDefinition<Config> {
  kind: ConnectorKind;
  metadata: ConnectorMetadata; // displayName, iconKey, accent, docsUrl?
  configSchema: Schema.Codec<Config, unknown> & { fields: Schema.Struct.Fields };
  defaultConfig: () => Config;
  probe: (config: Config) => Effect<ConnectorProbe, ProbeFailed>;
  createInstance: (input) => Effect<ConnectorInstance, ConnectorError, Scope>;
}
```

`Config` is invariant, so a heterogeneous list of connectors cannot be typed
directly. `eraseConnectorDefinition` is the answer: it decodes the incoming
`unknown` configuration through the connector's own schema at the boundary where
the untyped value actually enters, and a configuration that does not fit fails
as `ProbeFailed` or `SpawnFailed` for whichever operation needed it.

A definition describes itself, so no layer above it has to. `metadata` is how
it presents itself: `displayName` (what a new instance is named and the
connectors page offers to add), `iconKey` (a key the renderer maps to a logo or
glyph it ships — `claude-code`, `codex`, or a generic glyph such as `terminal`
for a harness with no logo — falling back to a generic one for a key it does
not know), `accent` (a colour, carried as data; the renderer keeps
to the theme's tokens and does not paint it) and an optional `docsUrl`, which
is also the renderer's fallback help link for a probe that failed on the
account. `configSchema` must be a struct whose fields carry `settingsForm`
annotations: erasure reads them once, with `settingsFormFields`, into
`configFields`, the form the connectors page renders for an instance of that
kind. The schema itself never leaves the server. `registry.describe` lists one
`ConnectorDescriptor` (`kind`, `metadata`, `configFields`) per kind the build
ships, in declaration order, and `connectors.describe` answers it.

`probe` answers whether the harness can run a turn on this machine, in
harness-neutral terms. The connector's `ConnectorProbe` carries a `status`
(`ready`, `not-installed`, `not-authenticated`, `error`), `installed` (true
once the harness resolved, even if it then refused), `auth` (`present`,
`absent`, `unknown`), and optionally `version`, `account`, `loginCommand` and
`installCommand` — the commands the harness's own output or docs name for
signing in and installing, left out rather than guessed. It also keeps
`models` and `warnings`, which stay on the server. `toWireProbe` narrows it to
the wire `ConnectorProbe` that `ConnectorSummary.probe` carries, adding
`authenticated` (`auth` as a boolean, absent when unknown) and `modelCount`.
Only the `probing` stand-in an entry reports before its first probe lands has
no `installed`; a probe that never ran (no definition for the kind, a
`ProbeFailed`, the timeout) reports `installed: false`. The
renderer builds every health message from these fields, so it never names a
harness's commands itself.

A `ConnectorInstance` is one _configured_ connector, live —
`startSession`, `resumeSession`, `listModels`, plus its capabilities.
`resumeSession` takes the persisted `sessionRef` and an optional `fork`: with
it, the connector continues that session's conversation in a new harness
session and leaves the original untouched. Only a connector declaring the
`fork` capability is asked, and one that cannot fork the ref fails rather than
starting fresh, so the server can carry the conversation over as text instead.
An instance may also have `generateText({ prompt, system?, model, effort?,
jsonSchema? })`, present exactly when it declares `textGeneration`: one piece
of text (a commit message, PR text, a thread title) written in a one-shot,
tool-less, read-only call in a temporary directory, with no session persisted.
It answers the harness's final text, and the caller parses and trims it. A call
the harness refuses or answers unusably fails with `GenerationFailed`
(`kind`, `instanceId`, `message`), which joins the `ConnectorError` union
beside `SpawnFailed`. Command Code implements it as one print run
([command-code-connector.md](command-code-connector.md#writing-one-piece-of-text)),
Claude Code as one tool-less `query()`
([claude-code-connector.md](claude-code-connector.md#writing-one-piece-of-text)),
Codex as one ephemeral thread in the read-only sandbox on an app-server of its
own, the schema sent as the turn's `outputSchema`
([codex-connector.md](codex-connector.md#writing-one-piece-of-text)).
`ConnectorCapabilities` is what the harness can do, and the renderer reads it
instead of the kind:

| Capability                   | Values                               | Read by                                              |
| ---------------------------- | ------------------------------------ | ---------------------------------------------------- |
| `modelSwitch`/`effortSwitch` | `per-turn`, `in-session`, `restart`  | the header pickers: applies now, next turn, or never |
| `planMode`                   | boolean                              | the plan toggle                                      |
| `runtimeModes`               | the `RuntimeMode`s a session honours | the mode picker, which offers only these             |
| `images`                     | boolean                              | the composer, which refuses attachments when false   |
| `attachments`                | `images` or `files`                  | not yet: `attachments.stage` stages images only      |
| `interrupt`                  | `turn` or `session`                  | what stopping cancels                                |
| `rollback`                   | boolean                              | whether the harness can rewind its own conversation  |
| `compaction`                 | boolean                              | whether compaction can be asked for on demand        |
| `questions`                  | boolean                              | whether a turn can put a question to the user        |
| `steering`                   | boolean                              | the decider (bound session) and the composer's Enter |
| `subagents`, `resume`        | boolean                              | declared                                             |
| `stopTask`                   | optional boolean                     | the decider and the agents strip's Stop              |
| `fork`                       | boolean                              | the decider: a fork of the tail forks the session    |
| `textGeneration`             | optional boolean                     | whether `generateText` exists                        |
| `ultracode`                  | optional boolean                     | whether `ThreadSettings.ultracode` can be switched   |

`steering` also decides `TurnInProgress` and whether a handle has `steer`,
below.

An instance may also carry `extensions` (`extensions.ts`): harness
configuration it manages for the Customize page and the composer. `skills`
lists what the harness loads (`list`), and optionally what a shared folder
offers (`available`) and a way to link one in (`link`); `plugins` lists the
plugins a harness that has them has installed (`list` only — each a
`PluginSummary`: `name`, optional `description`, `source` and `scope` in the
harness's own words, and `enabled`); `mcpServers` lists, adds (an upsert) and
removes servers in the harness's own config; `commands` lists the harness's own
slash commands (`list` only — each a `HarnessCommand`: `name` without the `/`,
optional `description` and `argumentHint`); `sessions` lists the sessions the
harness recorded on its own (`list`, newest first — each an
`ImportableSession` from `contracts/sessionImport.ts`: `sourceId`, `cwd`,
`title`, `startedAt`, `updatedAt`, and `messageCount` when the list read the
whole file) and reads one back (`read` — an `ImportedTranscript`: the session,
its newest user and assistant messages as text, and a `sessionRef` the
connector's own `resumeSession` accepts), opening the harness's files
read-only, and may name the session a thread's persisted `sessionRef` points
at (`sourceIdOf`); it takes no `ExtensionScope`. Command Code carries `skills` and
`mcpServers` but no `plugins`, since it has none, and no `commands`, since
nothing lists which of its slash commands a headless run executes. Claude Code
carries `commands`, read from the CLI's initialize handshake, and `plugins`,
read from the CLI's own config files (`connector-claude/src/plugins.ts`).
Claude Code and Codex carry `sessions`, read from the transcripts each CLI
writes (`sessionFiles.ts` in each); Command Code has none. Every other extension takes an
`ExtensionScope` — `{ workspaceRoot: string | null }`, the user scope plus one
project — and fails with `ConnectorExtensionFailed { code, message }`, never an
RPC error: the server (`settings/ConnectorExtensions.ts`) resolves the
`projectId` to a workspace root, calls the open instance's extension, maps the
failure's code across, and answers `unavailable` for an instance that is not
open or has no such extension. `ConnectorSummary.extensions` tells the renderer
which instances have which, so it shows a Customize section only for those, and
the composer's `/`, `@` and `$` menus ask the thread's own instance for its
skills, and `@` for its plugins too. The client runtime's `pluginsAtom` asks
one instance for its plugins and reads an `unavailable` answer, like no
instance at all, as an empty list, so an instance without plugins is not an
error and `@` just lists Poseidon's own plugins (`poseidonPluginsAtom`, over
`plugins.list`, listed first on every harness) and its skills.
`harnessCommandsAtom` reads `connectors.commands.list` the same way, so an
instance without a commands extension lists none, and the `/` menu
(`slash-menu.tsx`) shows what it lists last, under a Harness heading, leaving
out names Poseidon offers itself and the harness's `/clear`; a pick inserts
`/name ` as plain text. There is no `commands` flag on
`ConnectorSummary.extensions`: the renderer only ever asks the thread's own
instance.

Instances
are per configuration, not per thread. The registry (`registry.ts`) routes by
**instance id, never by kind**: two instances of the same harness with different
binaries, credentials or default models are a normal configuration, and a thread
bound to one must never be handed the other. A thread names the instance it
runs on with `ThreadSettings.connectorInstanceId`, fixed once it has run
anything; without one, the default routing rule picks
([Commands and events](#commands-and-events)). A definition is looked up by kind
exactly once, when an instance is opened from the settings document.

`ConnectorServices` is everything the server lends a connector: `mcpEndpoint`
and `hookEndpoint` per thread (each a URL plus a per-session bearer), the hook
handler registration pair, the permission ladder, the attachments directory, a
logger that annotates lines with the thread they came from, and a clock. The
optional `sessionPlugins(threadId)` answers the enabled Poseidon plugins a new
session should load (skills folders and MCP servers, plugin root expanded);
`ConnectorHost` forwards it to the plugin registry once connectors are
installed and answers none before. A connector that leaves it unused loads no
plugins ([plugins.md](plugins.md#what-each-harness-gets)).

### The session handle

`SessionHandle` is the live surface of one session: `events`, `send`,
`steer`, `interrupt`, `respondToRequest`, `respondToUserInput`,
`respondToPlan`, `updateSettings`, `sessionRef`, `close`. `send` and `steer`
take a `TurnInput`: text, attachments, mentions and the optional skill and
plugin `references`. How a reference reaches the harness is the connector's
choice, since each harness has its own syntax for invoking a skill or a
plugin. Command Code's connector writes a skill as a sentence naming it, and
a plugin the same way when it is one of the session's Poseidon plugins,
leaving any other plugin out with a `session.warning`
([command-code-connector.md](command-code-connector.md#the-prompt)). `send`
fails with `TurnInProgress` when a turn is running and `capabilities.steering`
is false; the caller's recourse is to queue, which is what
`thread.turn.start { queued: true }` is for. `steer` is present only when
`capabilities.steering` is true: it delivers a message into the running turn
with no new turn boundary, and the connector keeps that turn open until the
harness has answered the steered message too, so the turn still completes
exactly once. It fails with `NotSteerable` when there is no turn to take the
message. `close` is not best-effort: it resolves only once the connector has
proved the process tree it started is gone. `stopTask`, present only when
`capabilities.stopTask` is true, stops one running subagent by its task row
and leaves the turn going: the decider accepts `thread.task.stop` only for an
`in_progress` task of the running turn, `thread.task.stopRequested` records
it, and the provider reactor calls the handle; the harness then settles the
row as it settles any task.

**The bounded queue.** `makeBoundedEventQueue` is a dropping queue of 2048
slots, of which the last 64 are reserved for terminal events —
`turn.completed`, `session.ended`, `runtime.error`. An ordinary event offered
when the buffer is within the reserve is dropped and counted; a terminal event
may use those slots. Offering never suspends, so a connector's parser fiber can
never be blocked by a slow consumer. A harness that floods loses chatter, which
costs a redraw; losing a `turn.completed` would strand a turn in `running`
forever.

### The turn-scoped handle

`makeTurnScopedHandle` is the single place allowed to join a harness's own
notion of a turn to ours. The server mints a `TurnId` before the process is
spawned; the harness numbers its turns differently or not at all. Three rules:

1. **While a turn is active, every event belongs to it.** Envelopes are stamped
   with our `turnId`, and so is the `turnId` inside the payloads that carry one,
   so a projection never has to guess and never sees the two disagree.
2. **A turn always ends.** If the event stream ends or fails while a turn is
   unsettled, a `turn.completed` with `stopReason: "error"` is synthesized. A
   `runtime.error` with `fatal: true` settles the turn the same way without
   waiting for the stream to end; a non-fatal one is just news.
3. **Turns do not overlap.** A second `send` for a different turn is refused
   with `TurnInProgress`; sending the same turn twice is a no-op, so a retry
   after a lost receipt does not send the prompt twice. Once the stream is over,
   `send` refuses with `SessionClosed`.

`interrupt(turnId)` and `awaitTurn(turnId)` return only once the turn has
actually settled, so the caller that interrupted can act on a thread that is
genuinely idle. Settling is observed on `events`, so a caller that interrupts
must have that stream running.

`steer(turnId, turn)` is turn-scoped the same way: it delivers only while
`turnId` is the active turn, and fails with `NotSteerable` when that turn has
settled, never started, or the handle has no `steer`. It never touches the
active turn — the message belongs to the turn that was already running, and
that turn's one completion still ends it.

### The conformance suite

`runConnectorConformance` (`packages/connector-sdk/src/conformance.ts`) drives
the real definition — `createInstance`, `startSession`, `send`, `close` — and
asserts five promises the engine is written against, for every connector at
once:

1. A session announces itself before it reports any work.
2. Every turn completes exactly once.
3. Every approval request it opens is eventually resolved.
4. Nothing about the work is emitted after `close`.
5. `close` proves the process tree is gone.

A sixth case rides along: every event the connector emitted is encoded back
through the `RuntimeEvent` schema, so a payload that only looks right fails here
rather than at the transport. It proves nothing about vocabulary coverage, and
its name says so. `isProcessGone` is the one hook the suite needs from outside,
because proof that a process tree is gone cannot come from the event stream by
definition.

### The runtime vocabulary

Twenty-three `RuntimeEvent` variants (`packages/contracts/src/runtime.ts`), all
sharing one envelope (`eventId`, `connectorInstanceId`, `threadId`, `createdAt`,
optional `turnId`/`itemId`/`requestId`, optional `raw`): session lifecycle,
turn lifecycle and plan proposal, item started/updated/completed, content
deltas, approval requests and resolutions, user-input requests and resolutions,
subagent task lifecycle, usage, context, model change, MCP status, runtime
errors, and `event.unmapped`.

`event.unmapped` is the escape hatch, and `raw` is mandatory on it: a frame the
connector recognises as belonging to the session but cannot translate is kept,
so a harness change shows up rather than vanishing.

Items are sent whole rather than as patches, so a late subscriber, a resnapshot
and a replay all converge on the same row.

## The Command Code connector

The seam described above, filled in for one CLI. What follows is the shape of
the connector inside this architecture; every fact about the harness itself —
the argv, the frame catalogue, the hook payload, the version policy, plan mode,
subagents, exit codes, resume — is in
[command-code-connector.md](command-code-connector.md), read off the code and
the recordings under `packages/testkit/fixtures/cmd/`.

**One process per turn.** Print mode takes one turn per process, so `send`
spawns a child, waits for it to exit, and settles the turn. The child is
`detached` so interrupt and close can signal its whole process group. Of the
inherited environment it sees only an allowlist; the operator's `extraEnv`
passes by name; the session's own `POSEIDON_*` control plane is applied last so
nothing can override it.

**Three sources feed one event stream.** NDJSON frames on stdout are the live
source. The transcript on disk is history — it is appended once per completed
message, one model round trip behind, so it cannot drive a live UI, but it is
what survives a restart, what carries per-message cost, and what a resumed
session reads. Hook posts are the third. One translator per session, not per
process, dedupes the overlap across turns.

**Turn boundaries.** A turn is a process, from `run_start` to `run_end`. The
harness's own `turn_start`/`turn_end` frames count model round trips inside it,
of which one user turn can contain several.

**Approvals** ride the PreToolUse hook (below), which is the only approval
channel print mode has.

**Files we write into the user's world**, both reverted when the session closes
(`config.ts`): the PreToolUse hook block in
`<workspaceRoot>/.commandcode/settings.local.json`, reverted only while the file
still hashes to the bytes we wrote and only once the last session in that
project has closed, with a line in the repository's `info/exclude` that keeps
it out of the user's commits meanwhile; and the `poseidon` MCP entry in the
CLI's local scope,
written and removed _through the CLI_ (`cmd mcp add-json` / `cmd mcp remove`)
because the directory it lives in is a slug of the workspace path that only the
CLI knows how to spell.

## The Claude Code connector

The same seam over a different shape of harness. What follows is the shape of
the connector inside this architecture; the facts about the harness itself —
the probe, the launch argv, the message catalogue, the tool and approval
tables, the capabilities and why, what to check after a release — are in
[claude-code-connector.md](claude-code-connector.md), read off the code and
the recordings under `packages/testkit/fixtures/claude/`.

**One process per session.** The SDK's `query()` runs in streaming-input mode:
its prompt is the session's input queue, and each turn is one more user
message written to the same CLI process. `startSession` waits for the CLI's
initialize handshake, so a CLI that cannot start, or no longer has the
conversation a resume names, fails there rather than leaving a thread that
never answers. A resume whose conversation is gone starts a new session and
says so with `session.warning`.

**The binary and its environment.** The SDK is always handed the user's own
`claude` (`pathToClaudeCodeExecutable`) and a spawn function of the
connector's, which starts it `detached`, signals its whole process group, and
proves the group gone on close. The environment is default deny: a short
allowlist, the locales, and `CLAUDE_CONFIG_DIR` from the instance. Every
`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_AGENT_SDK_*` and `ANTHROPIC_*` variable
the server inherited is dropped — Poseidon may itself run inside a Claude Code
session — and `HOME` is never moved, because the CLI's keychain login is found
under it.

**The user's harness.** Sessions load the user's, project and local settings
— their CLAUDE.md, skills, MCP servers and hooks — under the CLI's own system
prompt, and add Poseidon's MCP server as `poseidon` with the per-thread bearer.
The SDK passes MCP configuration on the CLI's command line, so that bearer is
visible to `ps` on the machine while the session runs; it is minted per
session and revoked with it.

**Approvals.** A PreToolUse hook asks the permission ladder about every call
and answers allow, deny, or — for "prompt" — ask, which routes the call to
`canUseTool` and the shared approval gate's card. The hook runs in every
permission mode, so "ask" outranks the CLI's own allow rules too, and the CLI
hands a hook's ask to `canUseTool` without consulting its mode, which is what
lets full access run as `bypassPermissions` and still ask about a sensitive
path. AskUserQuestion and ExitPlanMode pass the hook with no verdict, and
`canUseTool` answers them itself (below).
`approvals.ts` maps the CLI's tools onto Poseidon's vocabulary: Bash →
`command`, `Shell(<first word> *)`; Edit, MultiEdit, Write, NotebookEdit →
`file_write`, `Edit(<path>)` (NotebookEdit's `notebook_path` is handed to the
ladder as `file_path`); Read, Glob, Grep, LS → `file_read`, `Read(<path>)`;
WebFetch and WebSearch → `web`, `Fetch(<url or query>)`; `mcp__<s>__<t>` →
`mcp_tool`, `Mcp(<s>.<t>)` with `mcpTool`; anything else → `other`, its bare
name. Allow once and allow always answer allow with the input; "always" is
Poseidon's rule alone, and nothing is written to the CLI's settings files.
Allow for the session adds the CLI's own suggested rules and directories at
its `session` destination, never a mode change. `canUseTool`'s abort signal
goes to the gate, so a withdrawn call closes its card as `deny`; an interrupt
and a close release every open card. A turn whose tool calls ran while the
gate saw none ends with a `session.warning`.

**Runtime modes.** Ask, auto-accept edits and full access run the CLI in
`default`, `acceptEdits` and `bypassPermissions`, a plan turn in `plan`; a
change mid-session is `setPermissionMode`. The session keeps the mode the CLI
last reported (a `system/status` with a `permissionMode`) or was last set to,
and sets it again before a turn whose modes call for another, so the turn
after a plan runs out of plan mode even when the model put the CLI there
itself (EnterPlanMode). The ladder reads the thread's own modes, as they are
at each call.

**Plans.** In plan mode the model writes its plan to a markdown file of the
CLI's own, directly under `<config dir>/plans/`, and calls ExitPlanMode; the
CLI puts the file's markdown and path into the call's input (`plan`,
`planFilePath`) before asking `canUseTool`. The connector settles the call's
row as a `plan` item with that markdown, emits `turn.plan.proposed` with the
path, and denies the call with a message telling the model the plan is with
the user and to stop, so the turn ends on the CLI's result. `respondToPlan`
has nothing to release: accepting, accepting with auto-accept and revising are
the server's settings change and next turn, as on every connector. The ladder
refuses every write in a plan turn, the plan file's included, so a Write, Edit
or MultiEdit of a `.md` file directly in that directory passes the hook with
no verdict in a plan turn, and the CLI's own plan mode — which allows its one
plan file and nothing else — decides it; every other write still reaches the
ladder and is refused. Plans kept elsewhere through the CLI's `plansDirectory`
setting are not recognised: their write is refused, ExitPlanMode arrives with
no plan, and the model is told to write the plan file and call it again. The
same rung refuses Task and its subagents in a plan turn, since they are not
reads.

**Questions.** AskUserQuestion opens the question card: each question's text,
`header`, options (label and description) and `multiSelect`, with ids minted
by position (`q<n>`, `o<n>`) and `freeform` always on, because the CLI lets
the user type an answer of their own. The call waits for
`respondToUserInput`; the answer goes back as its `updatedInput`, the
questions plus `answers` keyed by question text — the chosen labels joined by
", ", then the user's own text — and the CLI hands the model the result. A
withdrawn call, an interrupt or a close answers the card with nothing and the
call `deny`; `user-input.resolved` closes the card either way. The CLI offers
AskUserQuestion to an SDK session without any environment switch: the tool
list in the recorded `system/init` has it.

**Tool rows.** Each `tool_use` block opens a row keyed by its id, and the
`tool_result` the CLI writes back settles it — failed when `is_error`, which is
how a refused call reads. Bash is a `command_execution` with its output and
the exit code the CLI names; the edit tools are `file_change` rows whose diff
comes from the result's structured patch (a created file's from its content);
WebFetch and WebSearch are `web_search`, MCP tools `mcp_tool_call` naming the
server, TodoWrite a `todo`, Skill a `skill`, Task and Agent a `task`,
ExitPlanMode and EnterPlanMode a `plan`, and anything else, AskUserQuestion
among them, a `tool_call`. A plan row carries the plan; the refusal the CLI
writes back after it leaves the row as it is. Output is cut at 64KB. A row still open when its
turn's result arrives is failed there.

**Subagents.** A Task or Agent call's row is a task's: `task.started` goes out
beside it, titled with the call's `description` and naming its `model` when
it sets one. The CLI's `task_started`, `task_progress`, `task_updated` and
`task_notification` messages, which name the call's `tool_use_id` or a
`task_id` their `task_started` tied to it, become `task.updated` while the task
runs and `task.completed` once it settled (`completed`; `failed` for a
failure, a kill or a stop); a task whose call opened a row of another kind — a
shell command the CLI runs in the background — is that row's own business.
Sessions run with the SDK's `forwardSubagentText`, so the subagent's text and
thinking arrive as well as its tool calls: every message carrying the call's
id as `parent_tool_use_id` is read as the main loop's is, and every row it
opens is nested under the task (`parentItemId`), which the timeline folds into
the task row. A subagent's messages never move the session's context, cost or
rewind point. One that arrives before its task's row is open is held until the
row opens; whatever is still held when the turn ends is shown unnested. Unlike
Command Code's, a subagent's own tool calls reach the PreToolUse hook — the
SDK's hook input names the subagent (`agent_id`) — so they are gated one by
one. `fixtures/claude/subagent/` is the recording that will show a delegation
end to end; it waits for a signed-in CLI.

**Model and effort.** `updateSettings` switches the model with the SDK's
`setModel` (none for `default`, so the CLI's default applies again) and the
effort with `applyFlagSettings({ effortLevel })`, both on the running process
and taking effect from its next request; `modelSwitch` and `effortSwitch` are
`in-session`. `fixtures/claude/session-controls/` has the CLI taking both, with
no restart. The session then emits `model.changed` with what the CLI runs on:
the new pick once the CLI took it, the one before when it refused, so the
thread never shows a model the session is not using.

**Compaction.** A turn whose text is `/compact` is sent as a plain string, the
form the CLI reads a slash command from, and runs as the CLI's own command. Its
`system/status: compacting` opens a `context_compaction` row, and
`system/compact_boundary` settles it with the size before and after and
reports the context that is left. A compaction that fails has no boundary: the
status clears with `compact_result: "failed"` and the CLI's error, which fails
the row; the CLI then says the same line as the turn's answer
(`session-controls`, a `/compact` on a CLI that is not signed in).

**Attachments.** An attachment whose bytes sniff as PNG, JPEG, GIF or WebP
(`@poseidon/shared/imageBytes`) goes to the model as an image content block,
base64, ahead of the text — the text goes last because the CLI reads a
message as a slash command only when its last block is text. Any other file is
named by path, as Command Code's are: the server's staged file where it is, a
file from elsewhere copied into the thread's attachments directory, which is
among the CLI's readable directories. A file that cannot be read or copied is
still named by its path, with a `session.warning`. `fixtures/claude/image/` is
the recording that will show a model answering from an image.

**Steering.** `steering` is true: `steer` writes one more user message to the
running CLI, with no `turn.started`. The CLI queues it and takes it one of two
ways — folded into the running agent loop between two of its requests, so the
turn's one `result` answers both, or, when the loop ended first, run next as a
turn of the CLI's own with a `result` of its own. Its `command_lifecycle`
receipts, which name each message by the uuid the session stamped on it, say
which: a message is `started` before the running turn's `result` when it was
folded, after it when it runs next. So `steering.ts` holds Poseidon's turn open
at a `result` while a steered message has been neither `started` nor ended,
and the session sums the usage of every `result` the turn spans. The decision
and the end of the turn are one step, so a steer racing the last `result`
either holds the turn or finds none and falls back to the queue. Stop settles
the whole turn at its `result`, and interrupts with the SDK's `cancelQueued`
when a steered message is still waiting, so the CLI drops it rather than
running it afterwards; a turn already held for a message that ends without
being `started` ends on that receipt, since no `result` follows it. A CLI that has not shown it sends receipts — a receipt,
or `msg_lifecycle_v1` in its `system/init` — is not steered: `steer` fails
with `NotSteerable` and the server queues the message, and once an init lists
no `msg_lifecycle_v1` the session announces `steering: false`
(`fixtures/claude/receiptless-steer/`, CLI 2.1.150). `fixtures/claude/signed-out-steer/` has a message
steered in after the CLI's `system/init` and run next;
`fixtures/claude/steering/`, which will show one folded into a running loop,
waits for a signed-in CLI.

**Signed out.** A CLI that is not signed in answers each message with its own
"Not logged in" line and an error result, without calling the API. The
translator turns that into a fatal `runtime.error` naming the login command,
as Command Code's exit 3 is: a fatal error is a row on the timeline, and
nothing the thread sends will work until the user signs in. Other failed
requests stay non-fatal, because the next message may well work.

**Tests.** Every Claude recording is made through a real process boundary
and replayed under the real SDK: `apps/server/test/e2e-claude/` through the
whole server (replay, `POSEIDON_LIVE_CLAUDE=1`, `POSEIDON_RECORD_CLAUDE=1`),
and the connector's conformance, recorded-frames and recorded-session suites
without one. `src/liveConformance.test.ts` runs the conformance suite, a
mapping check and a denied write against the operator's own CLI, behind
`POSEIDON_LIVE_CLAUDE=1`. [development.md](development.md#the-claude-code-end-to-end-suite)
has the drivers and the budget rules.

## The Codex connector

The same seam over a third shape of harness: a JSON-RPC server rather than an
SDK or a one-shot CLI. The facts about the harness itself — the probe, the
launch, the notification catalogue, the approval mapping and runtime modes,
the capabilities and the recording behind each, what to check after a release
— are in [codex-connector.md](codex-connector.md), read off the code and the
recordings under `packages/testkit/fixtures/codex/`.

**One process per session.** Each thread is one `codex app-server` process,
opened with `initialize` (experimental API on) and `thread/start` or
`thread/resume`; each turn is a `turn/start` on it. Stop is `turn/interrupt`,
steering `turn/steer`, `/compact` `thread/compact/start`. A resume the CLI has
no rollout for starts a new thread and says so with `session.warning`.

**Approvals.** The approval policy is `untrusted` in every runtime mode and
only the sandbox varies, so the CLI asks and Poseidon's ladder decides; its
command and file-change requests go through `makeApprovalGate` like every
other connector's calls.

**Poseidon's MCP server** is added per process with `-c mcp_servers.poseidon.*`
overrides, the bearer in a child-only environment variable, so the in-app
browser and Poseidon's tools reach Codex without anything written to the
user's `config.toml`.

**Tests.** Every recording is a real app-server run through the testkit's
stdio tee, replayed by the `stdio-jsonrpc` replayer: the conformance suite
(approval case included), the recorded sessions and interactions, and the MCP
extension. `src/liveConformance.test.ts` runs the conformance suite, a schema
check of every method used, a plain turn, an allowed write and a plan turn
against the operator's own CLI behind `POSEIDON_LIVE_CODEX=1`.

## The RPC surface

One `RpcGroup` (`PoseidonRpcGroup` in `packages/contracts/src/rpc.ts`) carried
over the WebSocket with JSON serialization. Every RPC fails with the single
`PoseidonRpcError` — `not-found | invalid | unavailable | conflict | internal` —
except `fs.browse`, which has its own error because the picker offers a
different next step for each reason. `PROTOCOL_VERSION` is 3; a mismatch puts
the client in the terminal `incompatible` state.

| Method                        | Kind   | What it does                                                                                                                            |
| ----------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `server.hello`                | call   | Protocol version and `serverInstanceId` — a new id means cached snapshots are stale                                                     |
| `orchestration.dispatch`      | call   | Takes the whole `Command` union, returns a `CommandReceipt`                                                                             |
| `projects.list`               | call   | Project rows for the sidebar                                                                                                            |
| `threads.list`                | call   | Thread summaries, optionally per project, optionally with archived                                                                      |
| `threads.subscribe`           | stream | One thread: snapshot or catch-up from `afterSequence`, then live                                                                        |
| `threads.listSubscribe`       | stream | The thread list, same shape                                                                                                             |
| `threads.searchMessages`      | call   | Threads whose user or assistant text contains a query, at most 50, archived marked                                                      |
| `sessions.importable`         | call   | Sessions the harnesses recorded on their own, newest first, with their project and any earlier import                                   |
| `sessions.import`             | call   | Brings one in as a thread with its transcript; its first turn resumes the harness session when the instance can; idempotent             |
| `connectors.list`             | call   | Configured connectors with their cached probes; `refresh` re-probes                                                                     |
| `connectors.models`           | call   | The model picker's options for one instance                                                                                             |
| `connectors.describe`         | call   | Every connector the build ships: metadata and config form, configured or not                                                            |
| `files.search`                | call   | The composer's `#` file search; `threadId` searches the thread's root                                                                   |
| `files.read`                  | call   | A window of one file, with a `truncated` flag                                                                                           |
| `files.stat`                  | call   | Which of up to 100 paths exist inside the root; the others are left out, not errors                                                     |
| `files.create`                | call   | Writes a new `.md` file inside the root; never overwrites (`conflict`)                                                                  |
| `fs.browse`                   | call   | Subfolders of one directory on the server's machine, for the folder picker                                                              |
| `attachments.stage`           | call   | Uploads one composer image; returns a reference, never echoes bytes                                                                     |
| `attachments.read`            | call   | Reads a staged image back for a thumbnail                                                                                               |
| `git.status`                  | call   | Branch, ahead/behind and changed paths; `threadId` reads the thread's root                                                              |
| `git.diff`                    | call   | Worktree against HEAD or a `mergeBase`, or between two refs; `threadId` as above; `ignoreWhitespace` diffs with `-w`                    |
| `git.discard`                 | call   | Discards chosen paths back to HEAD, a `mergeBase` fork point or a `source` ref, or everything uncommitted; `conflict` while a turn runs |
| `git.blame`                   | call   | Blame of one working file or a line range (at most 5000 lines); `untracked` for a file with no history                                  |
| `git.branches`                | call   | Local and remote branches, the current and default branch, the remotes                                                                  |
| `git.branch.create`           | call   | Cuts an untracked branch, optionally switching to it; answers the new list                                                              |
| `git.checkout`                | call   | Switches branch; `conflict` on a dirty tracked tree or a running turn in that root                                                      |
| `git.commit`                  | call   | Commits all changes or chosen paths as the user; `conflict` on nothing staged                                                           |
| `git.push`                    | call   | Pushes the current branch, `-u` to its remote on the first push                                                                         |
| `git.pullRequest.create`      | call   | Opens (or finds) the branch's pull request with `gh`; `unavailable` without gh                                                          |
| `git.pullRequest.readiness`   | call   | Why `gh` cannot open a pull request (missing, signed out); `null` reason when it can                                                    |
| `git.pullRequest.view`        | call   | The current branch's pull request, checks and reviews via `gh`; `unavailable`/`none`                                                    |
| `git.pullRequest.marks`       | call   | Each thread's pull request state, from one `gh pr list`; empty without gh                                                               |
| `git.pullRequest.action`      | call   | Ready, draft, merge, close or reopen via `gh`; answers the view read afterwards                                                         |
| `git.pullRequest.fixContext`  | call   | Failing checks' log tails, or files conflicting with the base, for a fix thread                                                         |
| `git.generateCommitMessage`   | call   | A commit subject and body written from the diff of the ticked paths; `unavailable` when no harness can write                            |
| `git.generatePullRequest`     | call   | A pull request title and body from the branch's commits and diff against the base; `unavailable` as above                               |
| `thread.regenerateTitle`      | call   | A title written from the end of the thread's conversation, applied with `thread.rename`; `unavailable` as above                         |
| `git.worktree.create`         | call   | Cuts a new thread's worktree and branch under the Poseidon home, from `origin` when the setting asks; a `notice` when it could not      |
| `git.worktree.list`           | call   | The repository's worktrees, the project's own checkout first                                                                            |
| `git.worktree.remove`         | call   | Removes one, keeping its branch; `conflict` on unsaved work unless `force`                                                              |
| `git.worktree.setup`          | stream | Runs the project's setup script (from settings) in a worktree, streaming its output                                                     |
| `editors.list`                | call   | Editors, file manager and terminal installed on the server's machine                                                                    |
| `editors.open`                | call   | Opens the root or a path inside it in one of those, at a line where supported                                                           |
| `scripts.detect`              | call   | package.json scripts of the root and its workspace packages, with commands to run                                                       |
| `checkpoints.list`            | call   | Checkpoints that still exist as refs, read in the thread's root                                                                         |
| `browser.subscribe`           | stream | The browser pane's state, and frames when the browser is ours                                                                           |
| `browser.humanInput`          | call   | A human gesture into the browser the agent is driving                                                                                   |
| `browser.discoverServers`     | call   | The dev servers running under the thread's folder, for the address bar                                                                  |
| `settings.get`                | call   | The settings document                                                                                                                   |
| `settings.update`             | call   | Applies a patch, returns the new document                                                                                               |
| `settings.subscribe`          | stream | The settings document as it changes                                                                                                     |
| `connectors.skills.list`      | call   | Skills one instance loads, user scope plus an optional project                                                                          |
| `connectors.skills.available` | call   | Shared-folder skills that instance does not load yet; empty when it offers none                                                         |
| `connectors.skills.link`      | call   | Links one of those into the instance's user skills                                                                                      |
| `connectors.plugins.list`     | call   | Plugins one instance has installed, user scope plus an optional project                                                                 |
| `connectors.commands.list`    | call   | The harness's own slash commands for one instance; `unavailable` when it lists none                                                     |
| `connectors.mcp.list`         | call   | MCP servers in one instance's harness config, user and project scope                                                                    |
| `connectors.mcp.add`          | call   | Adds or replaces one entry we own; refuses one we do not                                                                                |
| `connectors.mcp.remove`       | call   | Removes one entry we own                                                                                                                |
| `plugins.list`                | call   | Built-in and global Poseidon plugins, invalid ones with their error                                                                     |
| `plugins.setEnabled`          | call   | Turns one plugin on or off for new sessions; stored in the settings document                                                            |
| `plugins.openFolder`          | call   | Creates the global plugins folder when missing and opens it in the file manager                                                         |
| `keybindings.get`             | call   | The user's keybinding overrides, layered on `DEFAULT_KEYBINDINGS` by the renderer                                                       |
| `keybindings.update`          | call   | Replaces the overrides; a `-command` row unbinds that command                                                                           |
| `terminal.open`               | call   | Starts a shell (or runs a `script` through it) under a client-minted id; idempotent                                                     |
| `terminal.write`              | call   | Input for the shell: typed keys, a paste                                                                                                |
| `terminal.resize`             | call   | The terminal's grid in character cells                                                                                                  |
| `terminal.close`              | call   | Kills the shell and forgets the terminal, output and all                                                                                |
| `terminal.list`               | call   | A thread's terminals, exited ones included, oldest first                                                                                |
| `terminal.listRunning`        | call   | Every thread's terminals still running a shell, for the sidebar rows' marks                                                             |
| `terminal.subscribe`          | stream | One terminal: a snapshot of its scrollback, then live output, then its exit                                                             |

Reads that must stay fresh are streams rather than polls, and every stream can
end in `resnapshot-required`.

Two loopback HTTP routes ride the same server besides `/ws` and `/healthz`:
`POST /hooks/pretooluse` and `POST /mcp`. Each refuses a request whose `Origin`
header is present and is not loopback (`apps/server/src/rpc/origin.ts`) before
the bearer is even looked at. `Origin: null` is explicitly _not_ treated as "no
origin": an opaque origin is what a sandboxed iframe, a `data:` document and a
`file:` page send.

## The hook bridge

A harness gates its tool calls one of two ways, and Poseidon supports both:

- **The hook bridge**, for a harness with shell hooks. The harness runs a
  script before each tool call; the script posts to our loopback bridge and
  blocks on the answer. Command Code works this way, and the rest of this
  section is that path.
- **The direct path**, for a harness driven over an SDK or JSON-RPC, where the
  harness asks its host — a permission callback, an approval request on the
  wire. The connector answers it in-process and needs no endpoint.

Both end in the same helper, `makeApprovalGate` in
`packages/connector-sdk/src/approvalGate.ts`. Its `decide` calls
`services.permissions.decide`; `allow` and `deny` return at once and emit
nothing, while `prompt` emits `request.opened`, parks until `respond` answers
(the connector wires it to `SessionHandle.respondToRequest`), and emits
`request.resolved`. `releaseAll` answers every parked request when the process
that asked has gone, so no card outlives its session. A direct-path harness
that can withdraw a question it asked passes its `AbortSignal` with the call:
an abort answers the open request `deny` and emits its `request.resolved`,
even when the signal fired before the card opened. A defect inside
`decide` is answered as a prompt, never as allow. The hook bridge's
`hookAnswers.ts` is a thin adapter over the gate: a hook post in,
`hookSpecificOutput` out.

Command Code's PreToolUse hook is how a tool call becomes an approval card.

```
cmd child ──► ~/.poseidon/bin/cmd-hook.mjs   (system shell, per tool call)
                 │  reads the hook payload on stdin
                 │  reads the bearer from POSEIDON_HOOK_TICKET_FILE
                 ▼
          POST /hooks/pretooluse   (loopback, Authorization: Bearer …)
                 │
             HookBridge.answer(token, body)
                 │  token → thread → the session's registered handler
                 ▼
          permission ladder ──► allow | deny  → answered immediately
                           └──► prompt ──► request.opened ──► card
                                              (parks until the user answers)
                 │
                 ▼
          hookSpecificOutput printed back on stdout → the harness applies it
```

The bearer is the routing key and the capability in one: it is minted per
thread, lives only in the spawned process's world, and revoking it is
`unregister`. It arrives in a **file** named by `POSEIDON_HOOK_TICKET_FILE`, not
in the environment, because the CLI redacts secret-shaped variable names out of
a hook's environment; the failure that taught us so is in
[command-code-connector.md](command-code-connector.md#the-ticket-file).

Every failure path in the script prints a `deny`: bridge down, timeout, garbage
response. The bridge itself answers `deny` for an unregistered thread, a failing
handler and a handler that exceeds 590 seconds — under the harness's 600-second
cap and the script's own 570-second fetch timeout. Bodies are capped at 1 MiB.
An unrecognised bearer is a 401.

One exception to deny-on-unreachable: the hook block we install in a project
outlives the session, so an interactive `cmd` run in that project invokes the
script with no `POSEIDON_HOOK_URL`. That run belongs to the user, so the script
exits cleanly with no output and the harness uses its own prompt flow.

Journaling is the event log, not a side channel: a `prompt` decision emits
`request.opened`/`request.resolved`, which ingestion persists as
`thread.approval.*`.

## The MCP gateway and the browser

`McpGateway` (`apps/server/src/mcp/McpGateway.ts`) is a loopback `POST /mcp`
JSON-RPC endpoint with a per-session bearer, minted for a thread and revoked
when the session ends or the thread closes. `GET /mcp` answers 405 — this
transport has no server-initiated stream. Protocol version negotiation echoes
the client's version when it is one the gateway speaks (`2025-06-18`,
`2025-03-26`, `2024-11-05`) and otherwise answers with ours.

`tools/list` serves the `browser_*` catalogue from
`apps/server/src/browser/tools.ts`: `browser_open`, `browser_snapshot`,
`browser_click`, `browser_fill`, `browser_type`, `browser_press`,
`browser_scroll`, `browser_wait`, `browser_get`, `browser_screenshot`,
`browser_eval`, `browser_tabs`. Each entry carries its JSON Schema,
annotations, the agent-browser argv the call maps to, and whether the call can
move the page. agent-browser reads its global flags anywhere in argv, even
after `--`, so a free-form value (selector, text, key, tab, wait pattern,
script) that starts with `--`, or `-` and a letter, is refused rather than
passed on, where it would become a flag such as `--auto-connect` or
`--session`.

The catalogue belongs to the built-in Browser plugin. Each bearer records
whether that plugin was on when it was minted (`PluginRegistry.browserEnabled`,
read only when the registry is in the graph); a bearer minted with it off gets
`tools: []` from `tools/list`, and a `browser_*` call on it answers a tool error
saying the Browser plugin is turned off in Customize → Plugins. The state is
fixed for the bearer's life, so toggling the plugin changes new sessions only.
The browser's own security model is untouched by this.

`tools/call` goes through `BrowserService.callTool`, which owns the serialized
per-thread queue and the human-control epoch. A call whose prepared form is
marked `script` — `browser_eval`, and `browser_wait` with `fn` — first goes
through `PermissionService.decide` as a `web` request, so plan mode and deny
rules refuse it. Every human gesture bumps the
epoch — a click, a key, a scroll, a toolbar navigation — and a call that
settles under a different epoch than it started returns
`interrupted_by_human`, which the agent reads in the tool result. Nothing the
agent does counts: the shell relays a guest's `before-input-event`, and input
synthesized over CDP never fires one, so a person clicking while
`browser_click` runs interrupts it. Results are capped at 64 KiB counted in
bytes, cut on a byte boundary, and so is the result's `structuredContent`
(`capStructured` in `McpGateway.ts`): a snapshot's refs map used to ride past
the text's cap beside it, so over the cap only where the page is stays.

Timeline rows for `mcp__poseidon__browser_*` come from the harness transcript
through the connector's translator, not from the gateway — emitting items there
would double every row. The renderer labels them as browser actions
([apps/web](#appsweb)).

`browser.status` answers the server's one mode and whether agent-browser
answered `--version` at startup, with its output, for the Browser settings
page.

The browser itself is the `agent-browser` CLI, wrapped rather than mounted as
its own MCP server: wrapping is what gives a session per thread, a pinned
target, the interrupt rule and teardown on thread close. Every call is one
`--json` invocation whose envelope is `{ success, data, error }`.

The server runs in one of three modes for its whole life, fixed at startup by
what the shell handed over (`apps/server/src/browser/agentBrowser.ts`), and
the driver behind the seam in `driver.ts` is opened lazily, on the thread's
first agent call:

- **in-app** — the desktop. The shell gave the server a browser bridge (below),
  and `inAppDriver.ts` drives the thread's own pane webviews through it. There
  is no other browser on the desktop: if the attach fails — the window is
  closed, the pane cannot open a tab — the call fails with the reason and the
  pane shows it, and the next call tries again.
- **disabled** — the desktop under `POSEIDON_REMOTE_DEBUG=0`. Every call answers
  "the in-app browser is disabled (POSEIDON_REMOTE_DEBUG=0)" and nothing is
  started.
- **owned-chromium** — no desktop: the web renderer, or the server run on its
  own. `ownedDriver.ts` has agent-browser run its own headless Chrome, streams
  JPEG frames over the session's WebSocket and forwards the pane's gestures and
  toolbar into it. `launchEnvFor` gives every command but `close` the
  environment `AGENT_BROWSER_ARGS=--use-mock-keychain,--password-store=basic`
  (`OWNED_CHROME_ARGS`), so that Chrome never raises a keychain or keyring
  prompt; `close` goes without, since agent-browser sends a launch ahead of any
  command that carries args. In-app and disabled set no launch args.

In-app, the server reads the bridge's origin and launch key once and deletes
both from its own `process.env`, so nothing it spawns later — a harness, a
terminal — inherits the key. Each agent-browser child gets the thread's URL as
`AGENT_BROWSER_CDP` in its environment, never in argv. The child's environment
is an allowlist, and the operator's own `AGENT_BROWSER_*` and `CHROME_*` are
not on it: `AGENT_BROWSER_CDP`, `AGENT_BROWSER_AUTO_CONNECT` and
`AGENT_BROWSER_ALLOW_FILE_ACCESS` would each redirect or loosen the child.
The same knobs, and stronger ones (`executablePath`, `plugins`,
`initScripts`, `headers`), can come from agent-browser's own config files,
`~/.agent-browser/config.json` and `./agent-browser.json`, so every child gets
`AGENT_BROWSER_CONFIG=<Poseidon home>/agent-browser.json`, which replaces both
lookups; the server writes `{}` there before any run that finds it changed.
`.agent-browser` is also one of the sensitive path segments, so writing the
CLI's own files always asks.

The in-app attach is `tab list` (connecting; on a thread with no webview,
agent-browser's own `Target.createTarget(about:blank)` on connect is what
creates the thread's first pane tab), `--pin-tab tab <targetId>` of the first
listed tab, then `stream disable`, which closes the daemon's unauthenticated
loopback frame stream. A pinned session fails with `tab_gone` when its tab is
destroyed instead of quietly driving another; the driver hands the agent "the
browser tab you were driving was closed in the pane; the next call uses the
pane's current tab", drops the binding, and attaches again on the next call —
the failed call is not retried behind the agent's back. The agent's own
`tab new` / `tab <id>` move the pin (and the driver follows), and closing its
own bound tab makes the next call attach again. After an idle gap of 270 s,
30 s short of the daemon's own reap timeout, the driver pins again before the
next command, because the pin is daemon state; the margin is there because
the driver's clock starts when the CLI child exits, after the daemon's last
activity. `close` is agent-browser's `close`, which in
CDP mode sends no CDP, so the pane's tabs survive it. The human's toolbar never
goes through the server in this mode: the pane moves its webview itself, and
`humanInput` only bumps the epoch and mirrors a navigation's url — a CDP
`Page.reload` from the server would reload the whole window. Every sequence is
recorded against the real bridge (`packages/testkit/fixtures/agent-browser/cli-*`)
and the driver's tests replay the envelopes.

A missing `agent-browser` binary is not fatal: the service reports no binary,
every call fails with `AgentBrowserUnavailable`, and the pane renders an install
prompt.

**Daemon lifecycle.** Every session runs in the namespace
`poseidon-<8 hex of POSEIDON_HOME>` (`AGENT_BROWSER_NAMESPACE`), which is what
bounds `close --all` to the app's own daemons, and is named
`ade-<12 hex of the thread id>`: the daemon's socket is
`~/.agent-browser/namespaces/<ns>/run/<session>.sock`, and with a raw thread id
the CLI refused the path as longer than macOS's 103-byte limit. Three things
close daemons, so none outlives the server that started it:

- the service's build forks a **reap** — `close --all`, a wait for the list to
  empty, a kill of what stays, and removal of the namespace directory — and
  the first driver waits for it;
- the service scope's **finalizer** closes every driver at once within 4 s,
  inside the supervisor's SIGINT→SIGKILL grace;
- **teardown** on thread close takes the session's queue before it closes.

A command timeout (30 s; 15 s for a screenshot, since an unpainted guest never
answers `Page.captureScreenshot`) closes that driver. `close` gets 3 s; a
daemon that does not answer is SIGKILLed through `<session>.pid` in the socket
directory, after checking the pid still names an agent-browser process and
killing its children (owned mode's Chrome) first. Where the pid file is not
there — a layout this was not verified on — it is logged and the 300 s idle
timeout is the net. The layout, `session list` emptying only after
`close --all` has answered, and a SIGSTOPped daemon hanging `close` and
`session info` alike while `session list` still answers, were checked against
agent-browser 0.38.1 on macOS; `cli-reap` records the envelopes.

### The browser bridge

The in-app browser is driven through a CDP endpoint that can reach the
thread's pane webviews and nothing else, rather than through Chromium's
remote-debugging port, which exposes the app window itself. The shell starts
it at launch (`apps/desktop/src/main/browser/start.ts`, from `index.ts`,
before the server is spawned) and never opens the remote-debugging port: the
`remote-debugging-port`, `-address`, `-pipe` and `remote-allow-origins`
switches are stripped from the command line even when the app was launched
with them (`apps/desktop/src/platform/browserBridge.ts`).

**Shape.** One `http.Server` on `127.0.0.1:0` for every thread
(`server.ts`). It has no HTTP surface: every plain request is a 404, and a
WebSocket upgrade reaches `ws` only after `upgradeGate.ts` accepts it. The
gate admits exactly `/cdp/<threadId>/<capability>` with no `Origin` header (a
browser page always sends one) and a `Host` of `127.0.0.1:<port>` or
`localhost:<port>` (a DNS-rebinding page does not). `/json/version`,
`/json/list` and every other path get the same bare 404, so a probe learns
nothing. The capability is `HMAC-SHA256(launchKey, threadId)`
(`packages/shared/src/browserBridge.ts`): the shell mints a 32-byte launch key
per launch, the server mints the thread's `ws://` URL from it, and the gate
compares in constant time.

**Handing it to the server.** `apps/desktop/src/backend/serverEnv.ts` spawns
the server with `POSEIDON_SERVER_BROWSER_BRIDGE` (the bridge's `ws://` origin,
or `disabled`) and `POSEIDON_SERVER_BROWSER_BRIDGE_KEY` (the launch key). The
`POSEIDON_SERVER_` prefix matters: the harness spawn passes `POSEIDON_*`
through and drops only that prefix, so neither reaches an agent. Anything the
shell itself inherited under those names is dropped. The server reads both once and deletes them from its own
environment; agent-browser receives a thread's URL only as
`AGENT_BROWSER_CDP` in its environment, never in argv, where any local
process could read it from the process table.

**Routing** (`bridgeSession.ts`, one per connection). The root session is a
virtual browser: `Browser.getVersion` is answered locally, and
`Target.setDiscoverTargets`, `getTargets`, `attachToTarget` (flat only),
`detachFromTarget`, `createTarget` and `closeTarget` are answered over the
thread's `persist:thread-<id>` guests, each reported as a `page`. Every other
browser-level method is refused, because a guest's own debugger can see and
attach to the app window. A page session is a flat session on that guest's
`webContents.debugger`; `cdpPolicy.ts` forwards a fixed list of domains
(Runtime, Page, DOM, Accessibility, Input, Network, CSS, DOMSnapshot, Overlay,
Log, Performance, Fetch, WebMCP), grants `Emulation` method by method (media,
geolocation, locale, timezone, user agent and the clears), and refuses the
rest — cookie-jar calls, file uploads (`DOM.setFileInputFiles`, and an
`Input.dispatchDragEvent` whose data carries local files), downloads, `Page.close`/`crash`,
`IO.*`, `Security.*`, the calls that would lay the page out at a size of its
own (`Emulation.setDeviceMetricsOverride`, `setVisibleSize`,
`setPageScaleFactor`), and navigation to anything but http(s) or
`about:blank`. The same cookies never ride out another way (`cdpCookies.ts`):
every `Network.*` / `Fetch.*` event and result a client receives loses its
`Cookie` / `Set-Cookie` headers, its cookie lists (`associatedCookies`,
`blockedCookies`, `exemptedCookies`) and its raw header text, and a
`Fetch.fulfillRequest` / `continueResponse` that would set a cookie is refused.
`Page.reload` becomes a guest `reload()` (CDP's reload of a guest view
reloads the whole app window), `Page.bringToFront` selects the pane tab,
`createTarget` opens a pane tab, and native input runs one command at a time
while the guest holds window focus, since CDP input lands in whatever widget
has it. When a client disconnects, every session it opened is detached. The
list fails closed: a method it does not name is an error in the tool result.

**The Electron side** (`guests.ts`, the `GuestPort`). The attach policy tells
the registry each thread whose webview it admits, before the guest exists; at
`web-contents-created` a webview guest belongs to the thread whose
`session.fromPartition("persist:thread-<id>")` is its session, and to nothing
otherwise. Once the guest is attached to its window (`did-attach-webview`, or
its first `dom-ready`), the registry attaches its debugger — once — and reads
its target id with `Target.getTargetInfo`. Child sessions are
`Target.attachToTarget({ targetId: self, flatten: true })` on that debugger,
and its messages are routed by session id; messages on the debugger's root
session are dropped. `created` / `changed` / `destroyed` come from the
guest's own life: registration, `did-navigate`, `did-navigate-in-page` and
`page-title-updated`, and `destroyed` or a debugger detach. A crashed guest
re-registers on its next `dom-ready`. The focus hand-off runs
`executeJavaScript` in the guest's window with only the numeric
`webContents` id: find the `<webview>` whose `getWebContentsId()` matches,
remember `document.activeElement`, focus the view, run the command, and give
focus back to that element (or blur the view when nothing else had it). It
refuses to run when the view is not in the window, so agent typing never
lands in the composer.

**Permissions** (`permissions.ts`). A session with no permission handler
approves every request, so each `persist:thread-<id>` session gets
deny-by-default request, check and device handlers when its first webview is
admitted: a pane page may go fullscreen and write plain text to the
clipboard, and nothing else. That denies `openExternal`, the permission a
top-level navigation to an unknown scheme asks for before the OS launches its
handler, along with clipboard reads, camera and microphone, location,
notifications, local-network access and device APIs.

**Tabs and popups** (`tabsChannel.ts`). A pane tab is the renderer's
`<webview>`, and Electron answers `Target.createTarget` with "Not supported",
so `createTarget`, `closeTarget`, `bringToFront` and popups become requests
to the window on `poseidon:browser-tab-request`, each with an id and a 10 s
deadline; the window answers on `poseidon:browser-tab-answer` with the new
guest's `webContents` id, and only the window that was asked may answer. No
window, a window that closes, or no answer in time is a clear CDP error ("the
Poseidon window is not open"). The preload serves the requests through
`window.poseidon.browserPane.serveTabs`, and answers at once with "the Poseidon
window cannot open browser tabs" while no tab host has registered. The tab
host is the renderer's browser host ([apps/web](#appsweb)), so an agent's
`tab new`, a popup, and the first call on a thread with no tab yet each open
a pane tab — hidden unless that thread's pane is on screen. `createTarget`
honours CDP's `background` flag: the agent's tab is selected in the pane, as
a browser would show it, unless it asked for the background. A popup's request
names the tab that opened it (`opener`), so the pane places it beside its
opener. Every webview guest gets a
`setWindowOpenHandler` at creation that always denies the native window and
routes an http(s) popup to a new pane tab of the same thread; the popup loses
`window.opener`, since it is a fresh guest rather than a child window.
Electron has no popup blocker, so `popups.ts` stands in for one: a thread
gets at most 4 popups in any 10 s and none once it holds 20 pane tabs, and a
popup opens in the background unless the page that opened it has focus.

**The kill switch.** `POSEIDON_REMOTE_DEBUG=0` (or `false`) starts no bridge,
attaches no debugger, and spawns the server with
`POSEIDON_SERVER_BROWSER_BRIDGE=disabled`; a bridge that fails to start is
reported the same way. Any other value of the variable is ignored — the old
`=1` / `=<port>` forms, which opened a DevTools port for attaching by hand,
are gone, because that port exposes the app window. `desktop.json`'s
`browserPane` key and `POSEIDON_BROWSER_PANE` are ignored. Under the kill
switch the server has no browser at all — it never falls back to a headless
one.

**Evidence.** The design came out of a spike against agent-browser 0.38.1 and
Electron 44.3.0, and the recordings under
`packages/testkit/fixtures/agent-browser/` are the proof it works: the real
CLI, given the thread URL in `AGENT_BROWSER_CDP`, connected, drove a page
(snapshot, fill, click, keyboard, scroll, screenshot, eval, navigate),
created a tab in an empty thread, opened and closed a tab, picked up a
`window.open` popup and reloaded, with every command allowed and no request
for `/json/*`. The same spike showed the raw port lets any local process
evaluate in the app window. Against the shell itself, launched with
`--remote-debugging-port`, the port was not open; `/json/version`,
`/json/list` and `/` on the bridge port were 404; agent-browser listed only
its own thread's webviews, filled, clicked, typed and pressed keys with the
host window's focused input untouched and its focus restored, reloaded a tab
without reloading the window, and saw a removed tab disappear and its
remounted successor appear with a new target id; a cross-thread capability
and a request with an `Origin` were refused; and under the kill switch no
bridge listened and no guest had a debugger attached. The server's own
sequences were recorded the same way (the `cli-*` scenarios): a fresh daemon
does open its frame stream, `stream disable` closes it and it stays closed
across a daemon restart, a pinned session whose tab the pane removed fails
`tab_gone` (in the error text — `data` is `{targetId, lastUrl}` with no
`code`), and after `close` both of the pane's tabs were still listed. With
the browser host in the app, a thread whose dock was closed got its first
tab from agent-browser's `tab list` and was driven hidden — open, click, read
text, screenshot — and that tab kept its `webContents` id and target id
through opening the pane, switching to the Changes tab, closing the dock,
switching thread, visiting /settings and coming back, with clicks and
screenshots answering in every state; a `window.open` became the selected
pane tab; archiving the thread took its tabs down at once and the agent's
`tab new` was refused with "the thread is archived"; deleting a thread took
its tabs down after the grace and left its partition with no local storage
and no cookies; and `clearThread("../Default")` was refused. With a fresh
`POSEIDON_HOME`, launching the app, adding a project and opening a thread left
one `webContents` (the window) and no agent-browser process; agent-browser's
first call on that thread created a hidden tab with the dock left closed,
read its title and clicked it, and the header showed "Agent is using the
browser — Show"; Show opened the pane on the same tab. With
`openPaneOnAgentUse` on, a second thread's first call opened the pane without
remembering it as the dock tab, and after the user closed it the agent's next
tab did not reopen it.

**The agent's pointer.** `bridgeSession.ts` hands every native-input command
the policy forwards to an `onAgentInput` hook just before it is queued for the
guest; the shell's relay (`agentPointer.ts`) turns `Input.dispatchMouseEvent`
presses and moves into what the window draws as the agent's cursor. It only
observes: nothing about the command changes.

**Residual risk.** The endpoint is on loopback, so it is protected by a
256-bit capability rather than by the OS. The launch key sits in the server's
environment, and each thread's capability in its agent-browser child's; a
process running as the same user can read another's initial environment from
the process table (`ps eww` on macOS), so the bridge does not defend against
the same user — what it removes is the reach: a web page cannot connect, and
whoever holds a capability reaches that thread's pane webviews and not the
app window, the RPC token or another thread. The bridge owns a CDP filter,
which must be re-checked against a fresh recording on every Electron or
agent-browser upgrade. The focus hand-off can race a user typing at the same
moment. Windows and Linux are unverified.

## Permissions

The ladder (`apps/server/src/permissions/PermissionService.ts`) is pure and
takes everything it needs as arguments:

1. A matching `deny` rule → **deny**.
2. `interactionMode: "plan"` and the request is not a read → **deny**. Plan mode
   is read-only.
3. The request touches a sensitive path → **prompt**. "Ask" outranks allow: a
   remembered `allow` can never skip the secrets check.
4. A matching `allow` rule → **allow**.
5. A read → **allow**.
6. Runtime mode decides the rest: `approval-required` asks;
   `auto-accept-edits` allows writes but still asks for commands and network;
   `full-access` allows everything that got this far.

The sensitive-path check covers a file request's path, every argument of a
command line, and the path or `file:` URL of anything else — including MCP
tools. Without that last clause, `browser_open` on a `file:` URL followed by
`browser_get` read key material with no card shown, where `read_file` on the
same path prompts. The list (`sensitivePaths.ts`) is about credentials
specifically: `.env*`, `.netrc`, `.pgpass`, `credentials`, SSH key names,
`.pem`/`.key`/`.p12`/`.pfx`, and anything under `.ssh`, `.aws`, `.gnupg`,
`.git`, `.config/gh`, or a harness config home — `.commandcode`, `.claude`,
`.codex`, `.config/opencode` — since those hold auth tokens and the harness's
own permission settings — or `.agent-browser`, the browser CLI's auth vault
and config. The directory rules read only what lies below the
parent of the thread's workspace root, so a project kept under
`.claude/worktrees/` is ordinary source, while its own `.claude/settings.json`
and `~/.claude` opened as a project still count.

**Pattern syntax** (`packages/shared/src/permissionPattern.ts`). The
vocabulary is Poseidon's own, the same whichever harness runs the thread; each
connector maps its harness's tool names onto it when it proposes a rule:

| Form                     | Matches                                                   |
| ------------------------ | --------------------------------------------------------- |
| `Shell(npm run *)`       | a command glob; `*` matches anything, `?` one char        |
| `Edit(/src/**)`          | a write's path glob; `**` crosses separators, `*` doesn't |
| `Read(/docs/**)`         | the same, for reads                                       |
| `Fetch(https://x.dev/*)` | a web request's url or search query                       |
| `Mcp(github.create_*)`   | an MCP call's `server.tool`, from the request's `mcpTool` |
| `todo_write`             | a bare tool name, exact or glob                           |

Rules stored in the older spelling stay valid as aliases: `Write(…)` is
`Edit(…)`, `WebFetch(…)` and `WebSearch(…)` are `Fetch(…)`, and a literal
`mcp__server__tool` is still globbed against an MCP request's tool name.

The subject a pattern tests comes from the request's `kind`, `input` and
`mcpTool` (optional on `ApprovalRequest`, since requests persisted before it
existed lack it).

Rules live in `permission_rules`, scoped `global | project | session`, with
`project_id`/`thread_id` stored as `''` rather than NULL so the uniqueness
constraint dedupes. That table is the single source of truth; the wire
`Settings.permissions` array is a projection of it, and the stored settings
document keeps its own copy of that array empty, so the two can never disagree. "Allow always" writes a row
inside the dispatch transaction and, after commit, invalidates the reactive key
so an open settings page re-reads it — after, because a subscriber told to
re-read mid-transaction can see a row the rest of the dispatch then rolls back.

Settings → Permissions lists the saved rules grouped by scope, edits a rule's
pattern with the approval card's pattern editor, and deletes rules. It saves
the whole array through `settings.update`, which replaces the table in the same
transaction as the settings document.

A failure inside a permission decision is logged and answered `prompt`: a
permissions failure must never read as allow.

Connectors reach the ladder only through `ConnectorServices.permissions`, on
either approval path ([the hook bridge](#the-hook-bridge)): the hook bridge's
adapter and a direct-path connector both hand their request to the approval
gate, which asks the ladder and, on `prompt`, opens the card.

## On disk

`~/.poseidon` unless `POSEIDON_HOME` says otherwise
(`packages/shared/src/paths.ts`). `boot` sets that variable process-wide before
anything resolves a path, and connector children inherit it.

| Path                                     | What it is                                  |
| ---------------------------------------- | ------------------------------------------- |
| `~/.poseidon/state.sqlite`               | the event log, projections, settings, rules |
| `~/.poseidon/bin/cmd-hook.mjs`           | the generated PreToolUse hook script        |
| `~/.poseidon/bin/tickets/<id>.ticket`    | a session's hook bearer, 0600               |
| `~/.poseidon/attachments/<threadId>/`    | staged composer images                      |
| `~/.poseidon/worktrees/<project>/<slug>` | a thread's own git worktree                 |
| `~/.poseidon/plugins/<name>/`            | a global Poseidon plugin                    |
| `~/.poseidon/builtin-plugins/<name>/`    | a built-in plugin, written at boot          |
| `~/.poseidon/session-imports.json`       | which thread each imported session became   |
| `~/.poseidon/dev/connection.json`        | the dev handshake, 0600, dev mode only      |

Attachments are references, never bytes, in the event log: an inlined screenshot
would be re-sent on every replay and to every client. The bytes cross the wire
twice — once up in `attachments.stage`, once down per thumbnail in
`attachments.read`. The media type is sniffed from the file's own header on the
way in and the way out, never taken from the name or the browser's claim, and
every path is resolved and checked against the thread's own directory before it
is touched. `AttachmentReactor` purges a thread's directory on
`thread.deleted` — not on archive, since an archived thread can be reopened —
and sweeps files no thread references at boot, with an hour's grace so a file
the previous process staged just before it went away survives.

The integrated terminal adds nothing to this table. A terminal's scrollback
lives in the server's memory only, bounded by `TERMINAL_SCROLLBACK_CHARS`, and
is gone with the process: a server restart ends every shell, and a client
coming back to one learns it is gone. The drawer's open state and height are
the renderer's, in localStorage.

The harness's own home (`~/.commandcode` by default) is separate and is _not_
moved by `POSEIDON_HOME`; `BootOptions.commandCodeHome` exists so an end-to-end
test that adds an MCP server does not edit the operator's real config.

## Tests and the gate

One command is the gate — `pnpm check`: lint, format, types, tests, boundaries,
file sizes, dead code. What each stage enforces and how to run one on its own is
in [development.md](development.md#the-gate).

Unit suites sit beside their subjects in every workspace. Above them:

- **Contract lockstep tests** keep each `*Type` literal list and its union in
  agreement, so a variant cannot be added to one without the other.
- **The decider table** drives `decide` with fixed ids and a fixed clock, which
  is why a scripted conversation replays byte-identically.
- **The conformance suite** runs against the real connector definition.
- **The end-to-end suite** (`apps/server/test/e2e/`) builds the product: `boot`
  assembles the same graph `main.ts` ships, the real client runtime dials it
  over a real WebSocket, and the renderer's own folds turn the subscription into
  the view a pane renders. Eleven scenarios — `turn`, `approval`, `question`,
  `plan`, `interrupt`, `resume`, `checkpoints`, `attachment`, `mcp`,
  `settings`, `terminal`. The `terminal` scenario involves no harness, so it
  runs once rather than per driver, against a real shell. Nothing waits on a
  clock: commands are awaited through their receipts and everything else
  through the subscription, so a scenario that never happens ends as a failed
  wait rather than a slow pass.

The end-to-end suite and the live conformance test have two drivers, differing
only in the binary: the gate runs recordings through
`packages/testkit/bin/replay-cmd.mjs`, and `POSEIDON_LIVE_CMD=1` runs the
operator's own `cmd`. `apps/server/test/e2e-claude/` is the same suite on the
Claude Code connector, over the `sdk-stream` replayer, with a third driver that
records; `POSEIDON_LIVE_CLAUDE=1` runs it, and the connector's live conformance
suite, against the operator's own `claude`. [development.md](development.md#the-end-to-end-suite) has
the commands and how a recording is made.

`pnpm build` produces the server bundle, the web `dist` and the macOS app
through electron-builder. `apps/server`'s esbuild entry is
`apps/server/src/main.ts` and nothing under a `test/` directory is bundled,
which is the other half of why the boundary check keeps testkit out of the
production allowlist.
