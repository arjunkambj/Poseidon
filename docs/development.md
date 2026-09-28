# Development

How to install, run, test, check and package Poseidon. Every command here is one
the workspace actually defines — the root `package.json` scripts, a workspace's
own scripts, or a script under `scripts/` — and every path is relative to the
repository root. For what the pieces are, read
[architecture.md](architecture.md); for what they do at runtime,
[how-it-works.md](how-it-works.md); for the rules the checks enforce,
[philosophy.md](philosophy.md).

## Prerequisites

| Thing            | Version                     | Where it is written                    |
| ---------------- | --------------------------- | -------------------------------------- |
| Node             | `>=22.16`                   | `package.json` `engines.node`          |
| pnpm             | `11.21.0`                   | `package.json` `packageManager`        |
| Command Code CLI | whatever you have installed | `packages/connector-cmd/src/binary.ts` |
| git              | any                         | checkpoints shell out to it            |

pnpm comes from the `packageManager` field, so `corepack enable` is enough.

The app drives the Command Code CLI, so a working `cmd` is a prerequisite for
anything past the first screen. `resolveBinary` in
`packages/connector-cmd/src/binary.ts` looks for it in this order:

1. the `binaryPath` configured on the connector instance,
2. `cmd` on `PATH`, then in `/usr/local/bin`, `/opt/homebrew/bin`,
   `~/.bun/bin`, `~/.local/share/pnpm`, `~/.npm-global/bin`,
3. `npx -y command-code@latest`.

Log in once with `cmd login`; the connector's probe reads `cmd status --json`
for auth, account and version, and `cmd --list-models` for the model picker
(`packages/connector-cmd/src/probe.ts`). Nothing is pinned to a CLI release:
`OLDEST_TESTED_VERSION` (`1.54.0`) is only the floor the probe warns below.

The browser pane needs `agent-browser` on `PATH`, or `POSEIDON_AGENT_BROWSER`
pointing at it (`apps/server/src/browser/agentBrowser.ts`). Without it the pane
renders an install prompt instead of failing the app. The desktop drives the
pane's own webviews, so `npm install -g agent-browser` is all it needs; the web
renderer on its own (owned Chromium) also needs `agent-browser install` for the
Chrome it downloads. Settings → Browser shows whether the server found it, the
version it printed and the command to install it; the server probes once at
startup, so restart the app after installing.

## Install

```sh
pnpm install
```

`pnpm-workspace.yaml` allows post-install builds only for `electron` and
`esbuild`; `msgpackr-extract` is deliberately left unbuilt so a checkout never
needs a C++ toolchain. CI installs with `--frozen-lockfile`.

The integrated terminal's pty module, `@lydell/node-pty`, needs no build
either. It is node-pty's own code with one prebuilt N-API binary per platform,
shipped as optional packages, and it has no install script. N-API means the
same binary loads under plain Node (tests, `pnpm -F server dev`) and under the
desktop app's Electron binary run with `ELECTRON_RUN_AS_NODE`, so there is no
toolchain to install and nothing to rebuild per Node or Electron ABI. The
server loads it on the first terminal it opens, not at boot, and
`apps/server`'s esbuild bundle leaves it external.

`pnpm-workspace.yaml` sets `supportedArchitectures` so that both the arm64 and
the x64 variants of every platform-specific optional package for this OS are
installed, not only the host's. The desktop app is packaged for both
architectures from one Mac or Windows host, and each app needs the pty binary
for its own architecture. The lockfile records every variant either way, so
this changes what gets downloaded, not what `--frozen-lockfile` checks.

## Running it

```
pnpm dev
 ├── turbo run dev -F web      → vite dev on http://localhost:3001 (strictPort)
 └── apps/desktop/scripts/dev.mjs
      ├── esbuild --watch  main | preload | ../server/src/main.ts
      └── electron apps/desktop  (ELECTRON_RENDERER_URL=http://localhost:3001)
           └── ServerSupervisor spawns the server as a child
                <electron> --import <tsx loader> apps/server/src/main.ts
                ELECTRON_RUN_AS_NODE=1  POSEIDON_DEV=1
                handshake { url, token, serverInstanceId } on fd 3
```

`pnpm dev` is `turbo run dev:hmr -F desktop`, which is `concurrently` over the
Vite dev server and `apps/desktop/scripts/dev.mjs`. The desktop shell owns the
server process: `ServerSupervisor`
(`apps/desktop/src/backend/ServerSupervisor.ts`) spawns it, reads the bootstrap
handshake off fd 3, and restarts it with 500 ms → 10 s backoff, pausing after
five consecutive failures. Both in dev and when packaged the child is
`process.execPath` — the Electron binary — run with `ELECTRON_RUN_AS_NODE=1`
(`apps/desktop/src/backend/serverDeps.ts`). In dev its argv is
`--import <tsx loader> apps/server/src/main.ts` rather than the `tsx` CLI, so
the server stays a direct child and fd 3 survives
(`apps/desktop/src/backend/serverArgs.ts`). Unpackaged, it also gets
`POSEIDON_DEV=1`, so a desktop dev run writes the dev connection file too.

There is no root `dev:server` script. The other useful entry points:

| Command                 | What it starts                                        |
| ----------------------- | ----------------------------------------------------- |
| `pnpm dev`              | desktop shell + web dev server + supervised server    |
| `pnpm dev:desktop`      | the same thing (`turbo run dev:hmr -F desktop`)       |
| `pnpm dev:web`          | the Vite dev server alone                             |
| `pnpm -F server dev`    | `tsx watch apps/server/src/main.ts --dev`             |
| `pnpm -F desktop start` | builds web, bundles, runs Electron without watch mode |

### Running the renderer in a browser

`pnpm dev:web` alone has no server to talk to. Start one in dev mode in a
second terminal:

```sh
pnpm -F server dev
```

`--dev` makes the server also write `~/.poseidon/dev/connection.json`
(`apps/server/src/rpc/bootstrap.ts`, mode 0600 in a 0700 directory). The Vite
config serves that file at `GET /__poseidon/connection`, refusing cross-origin
reads (`apps/web/vite.config.ts`), and the client resolver dials it
(`packages/client-runtime/src/resolver.ts`). The resolution order the renderer
uses is: the Electron preload bridge, then that dev endpoint, then
`?server=<url>&token=<t>` on the query string.

The file holds a bearer token for a socket that accepts
`orchestration.dispatch`. Treat it as a credential.

### POSEIDON_HOME

`POSEIDON_HOME` moves every path the app owns — the database, the attachments
directory, the generated hook script, the dev connection file
(`packages/shared/src/paths.ts`). Use a scratch home whenever you are running a
dev build, so an experiment cannot corrupt the real `~/.poseidon` or make the
desktop app and the dev loop fight over one `state.sqlite`:

```sh
POSEIDON_HOME=/tmp/poseidon-scratch pnpm dev
```

`turbo.json` lists it under `globalPassThroughEnv`, because turbo otherwise
hands a task a filtered environment and the variable would reach neither the
server nor the Vite plugin. `boot()` sets it process-wide when it is given a
`home`, so spawned connector children inherit it (`apps/server/src/boot.ts`).

Other environment knobs the server itself reads: `POSEIDON_PORT` (default `0`,
meaning ask the OS), `POSEIDON_DEV=1` (same as `--dev`).

The desktop shell reads one: `POSEIDON_REMOTE_DEBUG=0` (or `false`) turns the
in-app browser off — no browser bridge, no debugger on the pane webviews, and
the server is spawned with `POSEIDON_SERVER_BROWSER_BRIDGE=disabled`. Any other
value is ignored, as is the retired `POSEIDON_BROWSER_PANE`. With it set the
browser tools answer that the in-app browser is disabled; the desktop never
falls back to a headless browser. A server started on its own
(`pnpm -F server dev`, no shell) runs agent-browser's own headless Chrome,
launched with `--use-mock-keychain` and `--password-store=basic`, so no macOS
keychain ("Chromium Safe Storage") or Linux keyring prompt appears; the in-app
path passes no launch args. The
agent-browser child never inherits your own `AGENT_BROWSER_*` or `CHROME_*`
variables, and runs in the namespace `poseidon-<8 hex of POSEIDON_HOME>`, so a
scratch home's daemons are apart from `~/.poseidon`'s and from yours. The shell never opens Chromium's remote-debugging port,
and strips `--remote-debugging-port` and its relatives from its own command
line, so launching Electron with them does nothing. To look at a pane guest
over CDP by hand, mint the thread's bridge URL
(`bridgeThreadUrl` in `packages/shared/src/browserBridge.ts`, from the origin
and key in the server's `POSEIDON_SERVER_BROWSER_BRIDGE*` environment) and give
it to agent-browser as `AGENT_BROWSER_CDP`, with an `AGENT_BROWSER_NAMESPACE`
of your own so its sessions do not mix with the app's.

The in-app browser's own features are plain renderer code over the shell's
channels: the agent's cursor comes from the bridge's pointer relay
(`apps/desktop/src/main/browser/agentPointer.ts`), "screenshot to chat" from
`poseidon:browser-capture` and "Clear browsing data" from
`poseidon:browser-clear-all` (`apps/desktop/src/main/ipc.ts`); the element
picker runs in the page through the webview. In the web renderer none of them
is there, since it has no preload bridge.

## The gate

```sh
pnpm check
```

is `lint → fmt:check → typecheck → test → check:boundaries → check:file-sizes →
knip`, and it is what CI runs on Ubuntu and macOS. Each stage runs alone too:

| Stage      | Command                 | What it enforces                                                                                  |
| ---------- | ----------------------- | ------------------------------------------------------------------------------------------------- |
| lint       | `pnpm lint`             | oxlint: `correctness` as error, `no-explicit-any`, the shadcn rules                               |
| format     | `pnpm fmt:check`        | oxfmt over the tree, the markdown in `docs/` included; `pnpm fmt` writes                          |
| types      | `pnpm typecheck`        | `tsc --noEmit` per workspace; web also runs `vite build`                                          |
| tests      | `pnpm test`             | `turbo run test` → `vitest run` per workspace                                                     |
| boundaries | `pnpm check:boundaries` | import allowlist, connector leaks, neutrality, reference names, barrels, bold icons, even padding |
| file sizes | `pnpm check:file-sizes` | 800 lines a file, 400 for a renderer component                                                    |
| dead code  | `pnpm knip`             | unused files, exports and dependencies                                                            |

`pnpm typecheck` and `pnpm check-types` are the same script.

### Boundaries

`pnpm check:boundaries` first runs the rules' own tests
(`scripts/boundary-rules.test.mjs`, with `scripts/vitest.config.mjs`), then
`scripts/check-boundaries.mjs`, which does seven things in one pass over the
tree. The rules are pure functions in `scripts/boundary-rules.mjs`; the script
only walks and reports.

**Import allowlist.** Every import that names another workspace package is
checked against a table in `boundary-rules.mjs` — the table is reproduced in
[architecture.md](architecture.md#boundaries). A relative specifier that climbs
out of its own workspace directory is a violation whatever it lands on, because
packages are consumed through their `exports` map.

A workspace with no rule may import no workspace package at all; add the rule
before the import. Test files in `apps/server` get five extras — `testkit`,
`client-runtime`, `connector-cmd`, `connector-claude` and `connector-codex` —
which is what keeps
an accidental import of any of them out of `src/main.ts`, since that file is
bundled for packaging. Test files in `packages/connector-claude` get `testkit`,
because they replay the connector's recordings through its `sdk-stream`
replayer and record them through its tee; the connector's sources never import
it. Test files in `packages/connector-codex` get `testkit` for the same reason,
through its `stdio-jsonrpc` replayer. Test files in `apps/desktop` get `testkit`, so the browser bridge's tests
read the agent-browser recordings through `@poseidon/testkit/recording` instead
of resolving fixture paths by hand. One production file gets extras of its
own: `apps/server/src/boot.ts`, the composition root, may import
`connector-cmd`, `connector-claude` and `connector-codex`. A file counts as a test when it ends in
`.test.`/`.spec.` or sits under a `test/` directory.

**Connector leaks.** Non-test sources under `apps/web`, `packages/client-runtime`
and `apps/server` name no concrete connector: they import no `@poseidon/connector-*`
package other than `connector-sdk`, and contain no quoted connector kind —
`"cmd"`, `"claude"`, `"codex"` or `"opencode"`, in any quote style. Tests and
`apps/server/src/boot.ts` are exempt, because they assemble the real connector
on purpose. One file is exempt from the kind rule by exact path,
`packages/client-runtime/src/keybindings.ts`, where `"cmd"` is the Command key
of a shortcut; the reason sits next to the path in `KIND_LITERAL_EXEMPT`. A
harness config path such as `".claude"` or `".config/opencode"` is not a kind
and passes.

**Renderer neutrality.** Connector identity never reaches `apps/web/src`: the
patterns `command code` (spaced or not), the literal `"cmd"`, and `claude`,
`codex` and `opencode` as words are refused anywhere under it, in file names as
well as contents. One path is exempt, `apps/web/src/components/ui/icons`, so a
connector's own logo can be shipped under its own name. Its `brand-icons.ts` is
the one brand → icon mapping: `connectorIconFor` (a connector's `iconKey` → the
monochrome mark for a heading, or a generic glyph), `harnessLogoFor` (the
colour logo for an avatar, or nothing so the monogram stays), `editorIconFor`
and `providerKey`/`providerMarkFor`. Its map keys are unquoted, because the
connector-leak rule still refuses a quoted kind there. Callers pass data (an
`iconKey` from `useConnectorIconKeys`, an editor, a model's id and family) and
draw what comes back.

**Reference names.** The products Poseidon was compared against while it was
built are never named — not in `apps/`, `packages/`, `scripts/` or the
top-level `docs/*.md`, in file names or contents, in any case. `docs/plans/`
(local, gitignored), `node_modules`, `dist` and `out` are skipped; the recorded
fixtures under `packages/testkit/fixtures/` and the hand-written contract
fixtures are read like any source, so a recording must be scrubbed of any such
name before it is committed. The guard holds the names base64-encoded so
that it does not spell them itself, and its tests build their inputs from the
same list. Describe an idea you took from elsewhere in our own words.

**No barrels.** An `index` module anywhere under `packages/` is refused —
`.ts`, `.tsx`, `.js`, `.jsx` or `.mjs`; each package exports one entry per
module through its `exports` map. Apps are exempt — a router `index.tsx` is a
route, and the Electron entry points are named by electron-builder.

**Bold icons.** Icons render the bold variant app-wide. `@honeyicons/react`
draws every icon linear unless told otherwise and has no provider for a
default, so each element spells it: a `.tsx` file under `apps/` or `packages/`
that renders a component imported from `@honeyicons/react` without
`variant="bold"` fails, and the message says to add it. The rule reads the
file's imports from the package (aliases included, type-only imports left out)
and each JSX opening of one of those names, across as many lines as it spans.
An element that spreads props (`<Bell {...props} />`) passes, so a wrapper that
forwards props must pass `variant="bold"` through them. An icon handed around
as a value — a `HoneyIcon` prop, an icon map, a nav item's `icon` — is outside
the rule's reach; render it as `<item.icon variant="bold" />` too. Line-only
icons such as arrows and chevrons draw the same in both variants and take the
prop anyway. The one exemption is brand colour logos: an element whose
imported export ends in `Color` (`ZedColor`, `ClaudeCodeColor`, aliased or
not) passes without the prop, because every `*Color` export is a brand
`-color` logo that draws identically in both variants with the brand's own
fills. Monochrome brand logos (`Zed`, `Github`) still take `variant="bold"`:
most draw the same either way, but meta and instagram are outlines in linear
and their official mark is the bold drawing.

**Even padding.** An element reads as balanced when its vertical padding is
smaller than its horizontal, so buttons, inputs, chips and badges, menu items,
list and sidebar rows, tabs, toasts and small cards spell `px-3 py-1.5`, never
`p-2` or `px-2 py-2`. Rows and controls are 28px (`h-7`): the default and
`sm` button, toggle, input, input group and select trigger, and the sidebar
menu row, are all 28px, with `xs` (24px) and `mini` (20px) below them. `sm`
keeps the height and only sets smaller text and icons, `icon` and `icon-sm` are
the same 28px square, and a select trigger takes no `size` at all. The only
taller sizes are opt-in: `lg` on a button or toggle (32px) and on a sidebar
menu button (48px, a two-line row). Toolbar and pane header strips (`h-8`,
`h-9`) are bars that hold controls, not controls. Heights and padding are
spacing steps and `--spacing` scales with each region's font
size (`packages/ui/src/styles/globals.css`), so the boxes grow with the text
setting; no second size scale is needed.

The rule reads every string literal in the `.ts` and `.tsx` files under
`apps/web`, `apps/site` and `packages/ui` as a class list, comments blanked
first, and fails one whose padding comes out even: it compares the narrowest
horizontal side with the tallest vertical one, so `p-2`, `px-2 py-2`,
`px-2 pb-2` and `py-1 pr-1 pl-3` fail while `px-3 pt-5 pb-2` (a section gap on
top) passes. It also fails an element whose every vertical side is larger than
its narrowest horizontal one, such as `px-2 py-3`, while that vertical padding
is on an element's scale (16px, `py-4`, or less); a page or section at
`px-8 py-10` passes, since its vertical room is meant to exceed its gutters. Every padding form counts — `p`, `px`/`py`, `ps`/`pe`, `pl`/`pr`,
`pt`/`pb`, `px`, arbitrary values and `(--variable)`s — and the cascade inside
one list holds, so `p-1 px-2` passes. Each variant (`hover:`, `sm:`,
`has-data-*:`) is judged on the resting box with its own padding on top; the
literals of one `cn()` or `clsx()` call are judged together; and each `cva()`
value is judged on top of the base. Zero padding and square boxes (`size-*`,
`aspect-square`, or an equal fixed `h-*` and `w-*`, in the same state) pass,
round or not; `rounded-full` alone draws a pill, a chip or badge the rule
covers, so it earns no exemption. A
container whose even inset is genuinely right — a menu or dialog panel, a
sheet, a card band, a thumbnail frame — carries a `// padding-ok: <why>`
comment (or `{/* padding-ok: <why> */}` in JSX) on the reported line or the
line above it. The reason is required, and the words in a string or JSX text
do not count. The line that opens a `cn()` or `clsx()` merge counts too, since
the merge is one element; a `cva()` holds several, so its opening line exempts
only the base and each variant value that needs it is marked beside it.
Everything else gets a smaller vertical step than its horizontal one.

### File sizes

`scripts/check-file-sizes.mjs`: 800 lines for any source file under `apps/`,
`packages/` or `scripts/`, and 400 for anything under
`apps/web/src/components`. Exempt: `.test.`/`.spec.` files, `*.gen.ts`,
`routeTree.gen.ts`, and the two fixture roots
(`packages/contracts/fixtures`, `packages/testkit/fixtures`) — skipped by path,
not by directory name.

### knip and `@public`

Packages are consumed as TypeScript source, so every `exports` entry is an entry
point and by default every symbol a package exports counts as used. Each
`packages/*` workspace therefore sets `includeEntryExports` — knip reads inside
the entry files — together with `ignoreExportsUsedInFile`, so a schema that is
exported and also composed further down its own module is not reported.

`knip.json` sets `"tags": ["-@public"]`, so an export whose JSDoc carries
`@public` is exempt from the dead-export report. Use it for the seams a
composition root or a test drives rather than a caller in the same graph —
`boot`'s options and result, the layers `main.ts` wires
(`apps/server/src/boot.ts`, `apps/server/src/persistence/Sqlite.ts`,
`apps/server/src/settings/connectorRouting.ts`). Everything else that nothing
imports is dead code, and knip says so.

knip reads `apps/web/src/routeTree.gen.ts`, which is gitignored and written by
`vite build`. Run `pnpm typecheck` (or `pnpm build`) before `pnpm knip` on a
fresh checkout. `turbo.json` declares that file as an output of
`web#check-types` so a cache replay puts it back.

## Test conventions

Vitest, one project per workspace, collected by the root `vitest.config.ts`
(`packages/*`, `apps/server`, `apps/desktop`, `apps/web`). `pnpm test` runs
them through turbo; `pnpm exec vitest run <path>` runs one file from the root.

**Nothing waits on a clock.** Every write in Poseidon is a command and every
command comes back as a `CommandReceipt` carrying the event-log position its
effects are visible at, so "did my write land?" is answerable exactly. Tests
record receipts and await the one they care about by `commandId`
(`packages/testkit/src/receipts.ts`); streams are awaited through
`makeStreamCollector`'s `awaitItem`
(`packages/connector-sdk/src/streamCollector.ts`). A scenario that never
happens ends as a failed `awaitItem`, not a slow pass. Where a test genuinely
needs time to move, it uses Effect's `TestClock`
(`apps/server/src/orchestration/LiveBuffer.test.ts`).

**Fixtures are the contract made concrete.** `packages/contracts/fixtures/`
holds one JSON file per `RuntimeEvent` variant, per `ItemKind`, per `Command`,
per `OrchestrationEventType`, per stream frame, per read model and per RPC
result. `packages/contracts/test/fixtures.test.ts` decodes each one and encodes
it again, and the result must equal the bytes on disk. The coverage cases
derive their lists from the schemas, so adding a variant without a fixture
fails, and a fixture nothing round-trips fails too. The renderer's own tests
read the same files (`apps/web/src/lib/turn.test.ts`).

**Git is real, and so is its remote.** The git tests
(`apps/server/src/git/*.test.ts`) run the real `git` binary in `mkdtemp`
directories resolved through `realpath` — macOS's temp directory is a
symlink, and `git worktree list` prints resolved paths. Each repository sets
`user.name` and `user.email` locally, because CI has no global identity, and
push tests push to a local bare repository standing in for the remote. The
setup-script tests prove their process group is killed with a pid file, not
with a sleep. `gh` is an ordinary tool behind the injectable `GhRunner`
(`apps/server/src/git/GitHubCli.ts`): the tests swap in a fake whose output
copies the real CLI's wording, including the not-installed and
not-authenticated paths, and no test ever opens a real pull request
(`fakeGh.ts` holds the fake and gh's captured answers). The pull request reads
(`PullRequests.ts`, `pullRequestJson.ts`) are tested against JSON captured
read-only from gh 2.92.0 on public repositories — `gh pr view --json`,
`gh pr list --json`, the review-thread `gh api graphql` read and a
`gh run view --log-failed` job log — trimmed, with human logins replaced,
under `apps/server/src/git/fixtures/`. The pull request writes
(`PullRequestActions.ts`) are tested by their argv and by refusals worded as
gh's source words them. Capture new
ones the same way, read-only, and never run a pull request write against a
real repository.

**Connectors run a shared suite.** `runConnectorConformance`
(`packages/connector-sdk/src/conformance.ts`) drives a real definition through
`createInstance`/`startSession`/`send`/`close` and holds it to the five promises
listed in [architecture.md](architecture.md#the-conformance-suite). A new
connector's test file is one call to it.
`packages/testkit/src/fakeConnector.ts` is the fake that exercises the SDK
interface itself.

**The CLI is never invented.** Anything a test needs to know about a harness
comes from a recording of it under `packages/testkit/fixtures/<kind>/`, where
`<kind>` is the connector kind that drives it. Command Code's are under
`fixtures/cmd/` and replayed by `packages/testkit/bin/replay-cmd.mjs`. See
[Recordings](#recordings-of-the-real-cli).

**Ordinary tools run for real.** git runs in throwaway repos under the system
temp directory, and the terminal tests start a real `/bin/sh` in a pseudo-terminal
with `HOME` pointed at a temp dir, so the operator's rc files cannot change
what it prints. The shell echoes what it is typed, so they assert on output the
shell computed — `echo $((20+22))` answered by `42`, `stty size` after a
resize — and wait on it, never on a delay. They are skipped on Windows
(`apps/server/src/terminal/pty.test.ts`, `terminalService.test.ts`).

## The end-to-end suite

`apps/server/test/e2e/` boots the product: `boot()` assembles the same graph
`main.ts` ships, `makeConnection` from `@poseidon/client-runtime` dials it over
a real WebSocket, and the folds the renderer's atoms use turn the subscription
into the view a pane renders. Eleven scenarios:

| File                  | Scenario                                              |
| --------------------- | ----------------------------------------------------- |
| `turn.test.ts`        | a turn, from `project.create` to the answer on screen |
| `approval.test.ts`    | the approval gate, all three answers                  |
| `question.test.ts`    | the model asks the user a question                    |
| `plan.test.ts`        | plan mode, accepted and revised                       |
| `interrupt.test.ts`   | Stop, and what the thread does next                   |
| `checkpoints.test.ts` | two editing turns, two checkpoints, and a restore     |
| `resume.test.ts`      | the server dies mid-thread and comes back             |
| `settings.test.ts`    | the settings pages, against the user's real files     |
| `attachment.test.ts`  | an image on a turn                                    |
| `mcp.test.ts`         | Poseidon's own tools, offered to the harness          |
| `terminal.test.ts`    | a thread's and a project's terminal over the wire     |

Each scenario with a harness in it runs against two drivers
(`apps/server/test/e2e/harness.ts`):

- **replay** — the connector's `binaryPath` points at testkit's replayer, which
  puts a recording of that run back on the wire. This is what the gate runs.
- **live** — the connector discovers your own `cmd` and spends your plan.
  Skipped unless `POSEIDON_LIVE_CMD=1`.

```sh
pnpm exec vitest run apps/server/test/e2e              # replay only
POSEIDON_LIVE_CMD=1 pnpm exec vitest run apps/server/test/e2e
```

The same assertions run twice, which is the point: the replay says the product
behaves, and the live run says the recording still describes reality. A
scenario that needs different expectations from the two drivers is a scenario
whose recording has gone stale. `terminal.test.ts` has no harness in it, so
it runs once, outside `forEachDriver`, with no connector configured.

Every test gets a fresh `POSEIDON_HOME` and a throwaway git repo under the
system temp directory. The replay driver also redirects `HOME`, so it cannot
touch `~/.commandcode`; the live driver deliberately does not, because that is
where the CLI's credentials live. Both redirect `commandCodeHome` so the
settings scenario edits a copy rather than your real `~/.commandcode/mcp.json`.

The live conformance suite is separate and cheaper — about six turns:

```sh
POSEIDON_LIVE_CMD=1 pnpm exec vitest run apps/server/src/hooks/cmdLiveConformance.test.ts
```

`POSEIDON_LIVE_CMD_MODEL` overrides the model, `POSEIDON_LIVE_CMD_DEBUG=1` adds
output. The browser equivalent is `POSEIDON_LIVE_BROWSER=1` over
`apps/server/src/browser/live.test.ts`, which spawns a real headless Chromium
with a mock keychain, so it raises no keychain prompt.

### The Claude Code end-to-end suite

`apps/server/test/e2e-claude/` is the same product-level suite on the Claude
Code connector, whose observed behaviour is written up in
[claude-code-connector.md](claude-code-connector.md). It reuses the Command Code harness's homes, client, commands
and view readers, and adds three drivers (`apps/server/test/e2e-claude/harness.ts`):

- **replay**, the default and what the gate runs: the instance's `binaryPath`
  is the `sdk-stream` replayer for the scenario's recording in
  `packages/testkit/fixtures/claude/`. A green run must also have played its
  recording out as recorded: the replayer appends any divergence to a log the
  harness checks after the scenario, so a divergence the connector absorbed
  still fails it.
- **live**, `POSEIDON_LIVE_CLAUDE=1`: the connector discovers your own `claude`
  and spends your subscription. `POSEIDON_LIVE_CLAUDE_CONFIG_DIR` points the
  instance at a separate account (its `configDir`, which sets
  `CLAUDE_CONFIG_DIR`; `HOME` is never redirected).
- **record**, `POSEIDON_RECORD_CLAUDE=1`: live through the stdio tee. When the
  scenario passes and its scope has closed, the capture is finalised into
  `fixtures/claude/<scenario>/` with the CLI version from the connector's own
  probe, the SDK version from the package the connector imports, and the model
  the CLI's `system/init` named. A recording run runs the record driver only.

```sh
pnpm exec vitest run apps/server/test/e2e-claude           # replay
POSEIDON_HOME=/tmp/poseidon-h1 POSEIDON_LIVE_CLAUDE=1 pnpm exec vitest run apps/server/test/e2e-claude
POSEIDON_RECORD_CLAUDE=1 pnpm -F server exec vitest run test/e2e-claude/turn.test.ts
```

`POSEIDON_LIVE_CLAUDE_DEBUG=1` lowers a live run's server log level to debug, so
the connector's own log lines are printed too.

The live conformance suite is separate and cheaper:

```sh
POSEIDON_LIVE_CLAUDE=1 pnpm -F @poseidon/connector-claude vitest run src/liveConformance.test.ts
```

It is `runConnectorConformance` against the discovered `claude` with the
approval case, plus three cases of its own: the probe says the CLI is
installed, at or above `OLDEST_TESTED_VERSION` and signed in; a plain turn maps
without any `event.unmapped` or error; and a file write answered deny leaves
the file uncreated. It runs on the CLI's default model under the conformance
recording's caps (one turn, ten cents a session), in a throwaway git repo
under `/tmp/poseidon-h1`, and uses the same prompts as that recording, so the
two describe the same runs. `POSEIDON_LIVE_CLAUDE_CONFIG_DIR` points it at a
separate account too, and `POSEIDON_LIVE_CLAUDE_DEBUG=1` prints the connector's
log lines and every event type. Signed out, the probe case fails naming the
login command, the plain turns end in the CLI's login error, and the approval
case waits out its three-minute ceiling for a card that never opens.

The Codex connector has no server-level end-to-end suite; its recordings are
replayed at the connector level (below), and its live suite is the same kind
of file:

```sh
POSEIDON_LIVE_CODEX=1 POSEIDON_HOME=/tmp/poseidon-codex \
  pnpm -F @poseidon/connector-codex vitest run src/liveConformance.test.ts
```

It first checks the probe (installed, at or above `OLDEST_TESTED_VERSION`,
signed in, models listed) and generates the CLI's own JSON schema
(`codex app-server generate-json-schema --experimental`) to assert that every
method the connector sends or handles still exists. Then it runs
`runConnectorConformance` against the discovered `codex` with the approval
case, a plain turn that must map without any `event.unmapped` or error, a file
write allowed once that must leave the file written, and a plan turn that must
propose its plan — on the CLI's default model, in a throwaway git repo under
`/tmp/poseidon-codex`, with the conformance recording's prompts.
`POSEIDON_LIVE_CODEX_HOME` points the instance at a separate account (its
`codexHome`, which sets `CODEX_HOME`; `HOME` is never redirected), and
`POSEIDON_LIVE_CODEX_DEBUG=1` prints the connector's log lines and every event
type.

A live run that disagrees with the replay of the same scenario means the
recording is stale: record that scenario again rather than editing either.

A replay runs no tool — the recording stands in for the CLI — so what a
tool did to the workspace (the file an allowed write made, the file a denied
command did not) is checked by the live and record drivers; a replay checks
the thread: the cards, their answers, and the rows.

| File                    | Recording               | Scenario                                                     |
| ----------------------- | ----------------------- | ------------------------------------------------------------ |
| `signed-out.test.ts`    | `signed-out-turn`       | a turn against a signed-out CLI: the probe and the error row |
| `turn.test.ts`          | `plain-reply`           | a turn, from `project.create` to the answer on screen        |
| `interrupt.test.ts`     | `interrupt`             | Stop after the first text, then the next message             |
| `resume.test.ts`        | `resume`                | the server restarts and the conversation goes on             |
| `approval.test.ts`      | `edit-approval`         | a write asked about, then allowed once                       |
| `approval.test.ts`      | `deny`                  | a command denied, and the file it would have made absent     |
| `approval.test.ts`      | `sensitive-full-access` | `cat .env` under full access still opens a card              |
| `plan.test.ts`          | `plan-accept`           | the plan card, then the accepted plan implemented            |
| `question.test.ts`      | `question`              | the question card, and the answer written to `colour.txt`    |
| `subagent.test.ts`      | `subagent`              | a Task delegation, its rows nested under the task row        |
| `subagent-stop.test.ts` | `subagent-stop`         | one subagent stopped, its row failed, the turn going on      |
| `model.test.ts`         | `model-switch`          | the model and effort switched between turns, in session      |
| `attachment.test.ts`    | `image`                 | a staged PNG sent as an image block, and its colour named    |
| `steering.test.ts`      | `steering`              | a message steered in while a command runs, answered in-turn  |

A scenario whose recording has not been made yet is skipped under replay, and
its title says so. `packages/testkit/fixtures/claude/README.md` lists which
those are.

Every driver runs the thread on the CLI's default model (thread model
`default`, which leaves the SDK's `model` option out) and every session under
`CLAUDE_LIMITS` (four turns, fifty cents), passed to the connector through
`BootOptions.claudeCode`. A replay runs under the same caps, so its argv is the
recorded one. The live and record drivers refuse any other thread model unless
it is named in `POSEIDON_CLAUDE_APPROVED_MODEL`. The one switch a scenario
makes, in `model.test.ts`, names the explicit id the CLI's default already
runs as (`run.defaultModelId`: the recording's model under replay, what the
CLI's `system/init` named when recording, and live the model in
`POSEIDON_CLAUDE_APPROVED_MODEL`), so it never spends on another model. Replays and live runs make
their homes under the system temp directory; a recording makes them, and keeps
its raw capture, under `/tmp/poseidon-h1`.

The connector's own suites replay the same fixtures without a server:
`recordedFrames.test.ts` feeds every recorded session through the translator
and fails on any frame it leaves unmapped; `recordedSession.test.ts` replays
the session launch of `plain-reply`, the approval scenarios, `plan-accept`,
`question`, `subagent` and `steering`; `steering.test.ts` replays
`signed-out-steer`, a message steered into a turn on a signed-out CLI that runs
it as its next turn, and holds the session to one turn across both results,
and `receiptless-steer`, a steer refused on an older build (2.1.150) that sends
no receipts — recorded with
`POSEIDON_RECORD_CLAUDE_OLDER_BINARY=~/.local/share/claude/versions/2.1.150` on
`test/recordSession.test.ts`;
`sessionControls.test.ts` replays
`session-controls`, a session on a signed-out CLI that switches model and
effort, sends an image and runs `/compact` (recorded by
`test/recordSession.test.ts`, free because nothing reaches the API);
`conformance.test.ts` runs
`runConnectorConformance` against `conformance`, which is the suite itself
recorded through the tee, one session launch per case
(`POSEIDON_RECORD_CLAUDE=1` on that file re-records it).

### Which models cost money

`cmd --list-models` offers about seventy and most of them bill the account.
Three are authorised in the code, and both the recorder and the live suites
refuse anything else:

| Model                                   | Note                                         |
| --------------------------------------- | -------------------------------------------- |
| `meta/muse-spark-1.3-contributor`       | the account default; cheap, good at tool use |
| `poolside/laguna-s-2.1-free`            | free tier                                    |
| `inclusionai/ling-3.0-flash-sante:free` | free tier                                    |

The end-to-end suite runs on the first of these (`E2E_MODEL`), which is also
the model every recording was made on.

Claude Code has no free model: every answered turn bills the subscription or
the API account the CLI is signed in with, and the per-token price of each
model is in the description the CLI's own model list gives it. So every Claude
recording and live run uses the CLI's `default` — thread model `default`,
which leaves the SDK's `model` option out — under the turn and budget caps
the suites set, and the
live and record drivers refuse any other model unless the operator names it
in `POSEIDON_CLAUDE_APPROVED_MODEL`. What costs nothing: the probe (no message
is sent), and any turn against a signed-out CLI, which refuses it without
calling the API. A signed-in `/compact` costs a summarisation request and is
recorded only with the operator's approval.

Codex, signed in with ChatGPT, spends the plan's usage on every answered turn.
Its recordings and live runs use the CLI's default model (the thread names
none), one-line prompts and decisive answers, since the app-server has no turn
or budget cap; the one exception is `model-switch`, whose manifest names the
second model. The probe and the MCP servers recording send no message at all.

## Recordings of the real CLI

`packages/testkit/fixtures/cmd/` holds one directory per scenario, each a real
run of the real CLI — argv, stdout with its chunk boundaries, stderr, the
on-disk transcript as it grew, the checkpoints file, every PreToolUse
invocation with both halves of the conversation, the plan files and the files
the turn touched. Nothing in it is hand-written, and it is never edited to make
a test pass. `packages/testkit/fixtures/cmd/README.md` is the index and the
scenario catalogue.

### The recording format

Every harness's recordings share one layout, defined in
`packages/testkit/src/recording.ts`: `packages/testkit/fixtures/<kind>/<scenario>/`
holds a `manifest.json` and the transport's own capture files beside it. The
manifest's common fields are `formatVersion` (currently
`RECORDING_FORMAT_VERSION = 1`), `kind`, `transport`, `scenario`,
`description`, `cliVersion`, `recordedOn`, `model` and `real: true`.
`readManifest(kind, scenario)` refuses a manifest that is not marked real or
names a format it cannot read. The Command Code manifests predate
`formatVersion` and `transport` and are never edited, so a manifest without
them reads as version 1 of its kind's legacy layout: for `cmd` that is
`stdio-ndjson`.

A `RecordedFrame` is one unit on the wire, tagged with its direction
(`from-harness` or `to-harness`), the channel it travelled on, an optional
timestamp and its data. `turnFrames` in `replayCmdProcess.ts` gives a Command
Code turn in that form: stdout frames and hook payloads from the harness, and
hook answers to it. A `Replayer` pairs a kind and transport with
`config(scenario, options)`, which returns what a connector instance needs to
talk to the recording instead of the harness. `cmdReplayer` wraps
`replayConfig`.

`RecordingTransport` also names the transports other connectors bring:
`stdio-jsonrpc`, `sdk-stream` and `http-sse`, and the browser's two:
`cdp-websocket` and `cli-json`. A connector that speaks one of
them adds its recordings under its own `fixtures/<kind>/`, sets `transport` in
every manifest, and uses or adds a replayer for that transport. Only `cmd` has
a legacy layout: any other kind's manifest without `transport` is refused. The
existing recordings stay as they are. `fixturesRoot`, `recordingNames` and
`readManifest` take an optional root in place of `packages/testkit/fixtures`,
so the testkit's own tests write their captures to a temp directory.

#### sdk-stream

An SDK that drives its CLI over stdio NDJSON (messages, `control_request` and
`control_response` both ways) is recorded at the process boundary, so a replay
runs the real SDK and the real connector code with only the binary path
changed. Nothing in the testkit imports an SDK.

**Recording.** `makeTeeLauncher({ realBinary, rawDir })`
(`packages/testkit/src/sdkStreamRecording.ts`) writes a `#!/bin/sh` launcher
and its `config.json` into `rawDir`. The launcher runs `bin/stdio-tee.mjs`
with node named by absolute path, so it works under a connector's default-deny
environment. Point the connector's binary path at the launcher.

The tee spawns the real binary with the same argv, cwd and environment. It
stays in the tee's process group, so a connector that kills the group takes
both. The tee forwards SIGINT and SIGTERM and pipes all three streams through
unchanged. Every launch, a `--version` probe as much as a session, claims the
next number `n` and writes two files:

- `invocation-<n>.ndjson`: one `RecordedFrame` per line, appended
  synchronously, so a SIGKILL loses nothing already seen. A frame is
  `{ dir: "to-harness" | "from-harness", channel: "stdin" | "stdout" | "stderr", at, data }`,
  where `data` is the parsed JSON line, or the raw string when a line is not
  JSON or is only a JSON string — a pretty-printed array element, say, which
  parsed would lose its quotes and indentation when replayed.
- `invocation-<n>.json`: argv and cwd, plus the exit code and signal once the
  harness exits.

Environment values are never written.

`finalizeSdkStreamRecording({ kind, scenario, rawDir, description, cliVersion, sdkVersion, model, prompts })`
replaces `fixtures/<kind>/<scenario>/` with a `manifest.json` and the scrubbed
invocation files. The manifest carries the common fields with
`transport: "sdk-stream"`, plus `sdkVersion`, `prompts`, and `invocations[]`,
which lists each launch's scrubbed `argv` and `cwd`, its `file`, `exitCode` and
`signal`. `loadSdkStreamRecording(kind, scenario)` reads a recording back with
its frames.

**Replaying.** `sdkStreamReplayer(kind).config(scenario, { tmpDir, pidDir?, divergenceLog? })`
(`packages/testkit/src/replaySdkStream.ts`) returns `{ binaryPath }`: a
launcher written into `tmpDir` with the scenario baked in, because the
connector's environment is default-deny and cannot carry it.
`bin/replay-sdk-stream.mjs` behind it behaves as follows:

- **Choosing an invocation.** Each launch plays the first unplayed recorded
  invocation of the same argv class: `--version`, `auth status`, a probe's
  `stream-json` handshake (a run with `--no-session-persistence`), a session's
  `stream-json` run, or else the exact argv. A counter in `tmpDir` keeps count,
  so the second session of a resume-after-restart test plays the second
  recorded run whatever the probes did in between. A probe asked again — a
  handshake included — hears the last recorded answer again, because how often
  a server probes is its own business. A session launch with no recorded run
  left is a divergence.
- **Simple invocations** print their recorded stdout and stderr and exit with
  the recorded code.
- **Stream runs** walk the frames in order. A frame from the harness is written
  to its channel. At a frame to the harness, the replay blocks on the next line
  of stdin, so it never runs ahead of the live side. A test that triggers a
  mid-turn action (an interrupt, a steer) must trigger it on an event the
  recording emits before that action's frame.
- **Gating.** The live line must be the same move:
  - the same `type`;
  - for a `control_request`, the same `request.subtype`;
  - for a `control_response`, the same `response.subtype`;
  - when it answers a request the harness made, the same `request_id`, plus the
    same `behavior` for `can_use_tool` and the same `permissionDecision` for
    `hook_callback`.

  Answers to two open harness requests may arrive in either order, and each is
  still checked. So may a user message and the answer to an open harness
  request: a message steered into a running turn races the SDK answering the
  CLI's hook. Whatever arrived early is held back and checked in its recorded
  place, and anything still held back when the recording ends is a divergence.

- **Id rewriting.** The SDK's own request ids (`initialize`, `interrupt`,
  `set_model`, `set_permission_mode`, …) are random. Each recorded id is mapped
  to the live one when it arrives, and the recorded `control_response` to it is
  rewritten to carry the live id. The uuid each user message is stamped with
  is the session's own too, and the CLI names the message by it afterwards (its
  `command_lifecycle` receipts). Each recorded uuid is mapped to the live one
  when the message arrives, and every later harness frame carries the live
  uuid wherever the recorded one stood.
- **Divergence is loud.** A line the recording does not have, stdin closing
  while the recording still expects input, or input after the recording has
  ended prints both sides to stderr and exits **97**. With `divergenceLog` it
  also appends them to that file: a connector keeps its child's stderr to
  itself, so a test checks the file to know a green run played the recording
  out as recorded.
- **Ending.** After the last frame the replay waits for stdin to close, then
  exits the way the recorded run did, by code or by signal. With `pidDir` it
  drops a pid file, so `isProcessGone` checks a real child.

The tests of the tee and the replayer
(`sdkStreamRecording.test.ts`, `replaySdkStream.test.ts`) drive an ordinary
node program written into a temp directory (`stdioCounterpart.ts`). It is no
harness and needs no harness binary.

#### stdio-jsonrpc

A harness whose server mode speaks JSON-RPC over stdio, one message per line,
is recorded at the process boundary too, by the same tee: it frames lines
whatever they hold. On stdin travel the connector's requests and
notifications and its answers to the harness's own requests (approvals,
questions); on stdout the harness's responses, notifications and requests.

**Recording.** Point the connector's binary path at `makeTeeLauncher`, as for
`sdk-stream`.
`finalizeStdioJsonRpcRecording({ kind, scenario, rawDir, description, cliVersion, model, prompts, operatorNames? })`
(`packages/testkit/src/stdioJsonRpcRecording.ts`) runs the same finaliser
(`finalizeStdioRecording` in `sdkStreamRecording.ts`) with
`transport: "stdio-jsonrpc"`. The manifest names no SDK: it carries the common
fields plus `prompts` and `invocations[]`. A run is a launch whose argv holds
`app-server`. A probe tags its server-mode launch with
`STDIO_JSONRPC_PROBE_MARKER` (`--stdio`, the CLI's own flag for the transport
it uses anyway), and the scratch root is taken from the first run that is not a
probe's. `loadStdioJsonRpcRecording(kind, scenario)` reads a recording back
with its frames.

**Replaying.** `stdioJsonRpcReplayer(kind).config(scenario, { tmpDir, pidDir?, divergenceLog? })`
(`packages/testkit/src/replayStdioJsonRpc.ts`) returns `{ binaryPath }` and
refuses a manifest recorded over any other transport.
`bin/replay-stdio-jsonrpc.mjs` behind it follows the `sdk-stream` replayer's
rules, with JSON-RPC's moves:

- **Choosing an invocation.** The argv classes are `--version`,
  `login status`, a probe's server-mode handshake (`app-server` with the probe
  marker), a session's `app-server` run, or else the exact argv, counted in
  `tmpDir` across launches. A probe asked again hears the last recorded answer
  again; a session with no recorded run left is a divergence.
- **Gating.** A request or notification must have the same `method`, be a
  request where a request was recorded, and carry the same load-bearing params
  — `model`, `effort`, `approvalPolicy`, `sandbox`, `sandboxPolicy.type` and
  `collaborationMode.mode`, absent where the recording has them absent — so a
  connector that stops naming what a turn runs on diverges instead of passing
  on the harness's unchanged answers. An answer to a request the harness made
  must carry the same `id`, be a result or an error as recorded, and carry the
  same `result.decision` for an approval, the same `result.action` for an
  elicitation and the same answer keys (`result.answers`) for a question. Answers to two open harness requests may
  arrive in either order, and so may a connector message and the answer to an
  open harness request; each is held back and checked in its recorded place.
- **Id rewriting.** The connector's request ids are its own: each recorded id
  is mapped to the live one when the request arrives, and the recorded response
  to it carries the live id. The harness's own request ids come from the
  recording, so the live answers carry them unchanged. The two id spaces are
  kept apart: a response is told from a request by having no `method`. A
  connector sends no optional id of its own (a per-message client id, say)
  that the harness would echo back, so nothing else needs rewriting.
- **Divergence and ending** are as for `sdk-stream`: both sides printed and
  appended to `divergenceLog`, exit **97**; after the last frame the replay
  waits for stdin to close and exits as the recorded run did. `pidDir` works
  the same way.

`stdioJsonRpcRecording.test.ts` and `replayStdioJsonRpc.test.ts` drive the same
counterpart program, which speaks JSON-RPC when its argv holds `app-server`.

### Making one

Recording spends the operator's paid plan, so it is never run from CI:

```sh
node packages/testkit/scripts/record-cmd.mjs --list
node packages/testkit/scripts/record-cmd.mjs shell-allow
node packages/testkit/scripts/record-cmd.mjs plan --model poolside/laguna-s-2.1-free
node packages/testkit/scripts/record-probe.mjs      # no model turns at all
```

The Claude Code recorders are vitest files, skipped unless
`POSEIDON_RECORD_CLAUDE=1`. Scenarios that go through the server are recorded
by the end-to-end suite's record driver (see "The Claude Code end-to-end suite"
above); the connector-level ones are:

```sh
POSEIDON_RECORD_CLAUDE=1 pnpm -F @poseidon/connector-claude vitest run test/recordProbe.test.ts
POSEIDON_HOME=/tmp/poseidon-h1 POSEIDON_RECORD_CLAUDE=1 \
  pnpm -F @poseidon/connector-claude vitest run test/recordSession.test.ts
POSEIDON_RECORD_CLAUDE=1 pnpm -F @poseidon/connector-claude vitest run src/conformance.test.ts
```

Each points the connector's `binaryPath` at the testkit's stdio tee, drives the
real definition — the probe, or a session in a throwaway git repo under
`/tmp/poseidon-h1/scratch` — and finalises the capture into
`fixtures/claude/<scenario>/`. Sessions run on the CLI's default model, capped
at one turn and five cents. `probe` and `signed-out` spend nothing: the first
sends no message, and the second was recorded while the CLI was signed out, so
the CLI refused the turn without calling the API.

The Codex recorders are vitest files too, skipped unless
`POSEIDON_RECORD_CODEX=1`. They run the operator's own `codex` under their own
`CODEX_HOME` — the login lives there — with `POSEIDON_HOME=/tmp/poseidon-codex`:

```sh
POSEIDON_RECORD_CODEX=1 POSEIDON_HOME=/tmp/poseidon-codex \
  pnpm -F @poseidon/connector-codex vitest run test/recordProbe.test.ts
POSEIDON_RECORD_CODEX=1 POSEIDON_HOME=/tmp/poseidon-codex \
  pnpm -F @poseidon/connector-codex vitest run test/recordSession.test.ts -t plain-reply
POSEIDON_RECORD_CODEX=1 POSEIDON_HOME=/tmp/poseidon-codex \
  pnpm -F @poseidon/connector-codex vitest run test/recordInteractions.test.ts -t question
POSEIDON_RECORD_CODEX=1 POSEIDON_HOME=/tmp/poseidon-codex \
  pnpm -F @poseidon/connector-codex vitest run test/recordGenerateText.test.ts
POSEIDON_RECORD_CODEX=1 POSEIDON_HOME=/tmp/poseidon-codex \
  pnpm -F @poseidon/connector-codex vitest run src/conformance.test.ts
POSEIDON_RECORD_CODEX=1 POSEIDON_HOME=/tmp/poseidon-codex \
  pnpm -F @poseidon/connector-codex vitest run src/extensions/mcpServersRecorded.test.ts
```

The probe opens an app-server connection, reads the account and the model
list, and starts no thread, so it spends nothing. The session recorder
(`test/recordSession.test.ts`, one test per scenario, so `-t` picks one) runs
each scenario in a throwaway git repo under `/tmp/poseidon-codex/scratch`, on
the CLI's default model. The app-server has no turn or budget cap, so its
prompts are trivial and ask for one-word answers. The approval scenarios
(`edit-approval`, `deny`, `sensitive-full-access`, `approval-stop`) answer
every card they open the way their description says. The interaction
recorder (`test/recordInteractions.test.ts`: `plan-accept`, `question`,
`steering`, `compaction`) shares the scenario helpers of `test/scenario.ts`;
`question` answers the card with its first option, `steering` steers once the
command row shows, and `compaction` compacts a one-turn thread.
`test/recordGenerateText.test.ts` runs the instance's `generateText` once
(`generate-text`: a short title prompt with a JSON schema, effort `low`, in a
temporary directory). `src/conformance.test.ts`
records the connector-sdk suite itself, one app-server launch per case, and
replays it in the gate, approval case included. The finaliser is told the
names of the operator's MCP servers (`codex mcp list --json`) and skills
(`$CODEX_HOME/skills`), so each becomes a `user-skill-<n>` stand-in.
`src/extensions/mcpServersRecorded.test.ts` records the MCP servers
extension itself — every `codex mcp list --json`, `add` and `remove` it runs —
on a scratch `CODEX_HOME` (`/tmp/poseidon-codex/mcp-home`) seeded with one
hand-written server, so the operator's own config is never touched and no
model is called.

`record-cmd.mjs` gives each run a throwaway git repo under a scratch root
(`RECORD_SCRATCH`, default the system temp directory), spawns the CLI through
the same binary resolution `probe.ts` uses and with the same argv and
environment `packages/connector-cmd/src/spawn.ts` builds, and installs the
recording hook through the same `.commandcode/settings.local.json` mechanism
`config.ts` uses. A `--model` outside the authorised list stops the run before
anything is spawned. `record-probe.mjs` captures the free surfaces —
`status --json`, `--list-models`, `--version`, `--help`, and the error a bad
`--model` produces.

### agent-browser through the browser bridge

`packages/testkit/fixtures/agent-browser/` holds the real agent-browser CLI
driving real Electron webviews through the desktop's browser bridge, one
scenario per directory: a `manifest.json` (`transport: "cdp-websocket"`, the
CLI and Electron versions, the tabs the thread started with, and each CLI
command with its `--json` envelope) and `frames.jsonl`, every CDP message in
either direction as a `RecordedFrame` (`from-harness` is the CLI).
`readFrames(kind, scenario)` loads them. It spends no plan, but it launches
Electron and the operator's CLI, so it is run by hand:

```sh
node packages/testkit/scripts/record-agent-browser.mjs --list
node packages/testkit/scripts/record-agent-browser.mjs            # every scenario
node packages/testkit/scripts/record-agent-browser.mjs popup
```

The recorder serves the pages from a loopback site, bundles
`apps/desktop/scripts/bridge-recording-host.mjs` with the desktop's esbuild,
runs it under the desktop's Electron, and invokes the CLI with the thread's
bridge URL in `AGENT_BROWSER_CDP` and its own `AGENT_BROWSER_NAMESPACE`,
which it deletes afterwards. It scrubs the site and bridge ports to
`<SITE_PORT>` and `<BRIDGE_PORT>`, the launch key and capabilities to
`<REDACTED>`, and a screenshot's bytes to their length; the bridge's replay
(`apps/desktop/src/main/browser/test/replay.ts`) puts a port back. Re-record
on any agent-browser or Electron upgrade: `cdpPolicy.test.ts` fails when the
CLI starts sending a method the bridge refuses.

### The lsof capture behind dev-server discovery

`apps/server/src/browser/test/discovery/` is a real capture of the two `lsof`
commands discovery runs, taken on macOS with four servers started for it (an
HTML page and a redirect under a scratch project, a non-HTTP listener under
it, and an HTML page outside it) among whatever else was listening. Its
`manifest.json` names the commands, the four servers' pids and ports and what
each answered `curl`. The home and scratch directories are scrubbed to
`<HOME>` and `<SCRATCH>`. `discovery.test.ts` parses it and replays the
recorded answers through the cwd filter; the probe itself runs against real
local sockets, and one test runs the real `lsof` when the machine has it. To
re-capture: start servers like those four from their folders, run the two
commands from the manifest (the second with every pid the first printed),
scrub, and update the manifest's pids and ports.

### Scrubbing

Recordings are scrubbed on the way in: the scratch root becomes `<SCRATCH>`,
the home directory becomes `<HOME>`, the account name and the home directory's
basename become `user`, and anything token-shaped becomes `<REDACTED>`. Session
ids and trace ids are left alone — they are per-run identifiers with no meaning
off the machine, and the tests match on them. The replayers put `<HOME>` and
`<SCRATCH>` back from the running process's own directories.

The `sdk-stream` and `stdio-jsonrpc` finaliser adds more rules, because its
captures carry the account and the MCP bearer:

- The account's email, organisation name and ids, and account uuid are read out
  of the init, account and `auth status` payloads. They are replaced
  everywhere: emails become `user@example.com`, uuids the zero uuid, and names
  `<ACCOUNT>`. Any other email address becomes `user@example.com` too.
- A value under a credential key (`Authorization`, `x-api-key`, `*token`,
  `password`, …) becomes `<REDACTED>` whatever its shape.
- The MCP bearer the Claude connector hands the CLI travels inside
  `--mcp-config`'s JSON, which the argv carries as one string rather than an
  object, so the key rule cannot see it there; the token-shaped rule catches it
  as `Bearer <token>`, as long as the token is at least twelve characters. A
  real bearer is; the connector's tests use `poseidon-test-bearer-0000` so their
  recordings show the redaction too.
- The scratch root is taken as the parent of the first stream run's working
  directory, spelled with and without macOS's `/private`. A recorder whose
  first stream run is a probe's handshake in the temp directory names its
  scratch root itself.
- The system temp directory (`os.tmpdir()`, with and without macOS's
  `/private`) becomes `<TMP>`: the CLI's attachment directory and a probe's
  working directory live there. Paths are replaced longest spelling first and
  only as whole paths, so a scratch root under the temp directory stays
  `<SCRATCH>` and a temp directory spelled `/tmp` leaves `/var/tmp` alone. The
  replayers put `<TMP>` back as their own temp directory.
- The operator's own skills, commands and agents — every entry of the
  harness's config directory's `skills/`, `commands/` and `agents/`
  (`<home>/.claude` unless `configDir` says otherwise) — are listed by name in
  the CLI's handshake and `system/init`. Each becomes `user-skill-<n>`: as a
  list item, and as an object's `name`, whose `description` goes with it.
- Names the recorder passes in `operatorNames` — the operator's own MCP
  servers from their configuration, skills from a directory the rule above does
  not read — join those stand-ins, and are replaced in text and keys too,
  wherever they stand alone.
- The installation's id (`installationId`) is replaced like an account uuid,
  and the machine's name (`os.hostname()`, with and without `.local`) becomes
  `<HOST>`.

### When to re-record

Any CLI release that changes the frames. Three tests fail when it happens, and
they are the notice:

- `packages/connector-cmd/src/recordedFrames.test.ts` — replaying every
  recording must produce no `event.unmapped`. A new frame type fails here
  rather than arriving as an unreadable blob in the timeline. It also pins the
  facts a recording is cited for, such as `hookCount: 0` on all four plan
  recordings and `touchedFiles: []` on the two plan-guard ones.
- `packages/connector-cmd/src/recordedArgs.test.ts` — reads every manifest's
  `connectorArgs` back into a `buildArgs` input, rebuilds it, and demands the
  same list. The two allowed differences are written down in that file.
- the live end-to-end and conformance suites, which run the same assertions
  against the CLI you actually have.

For Claude Code the notice comes from
`packages/connector-claude/src/recordedFrames.test.ts` (a recorded message
left unmapped, or a manifest older than `OLDEST_TESTED_VERSION`), from any
replayed suite exiting 97 because the SDK now sends something the recording
was not sent — an SDK upgrade does this — and from the `POSEIDON_LIVE_CLAUDE=1`
suites. Re-record through the same test that made the recording
(`packages/testkit/fixtures/claude/README.md` names it for each scenario),
signed in, on the default model; when the recordings move to a newer CLI,
move `OLDEST_TESTED_VERSION` with them.

For Codex the notice comes from
`packages/connector-codex/src/recordedFrames.test.ts` (a recorded
notification left unmapped, or a manifest older than `OLDEST_TESTED_VERSION`),
from any replayed suite exiting 97 because the connector now sends a line the
recording was not sent — a change to the `initialize` handshake does this to
every recording at once — and from the `POSEIDON_LIVE_CODEX=1` suite, whose
schema check names any method the installed CLI no longer has. Re-record
through the test named for each scenario in
`packages/testkit/fixtures/codex/README.md`, signed in, on the default model;
move `OLDEST_TESTED_VERSION` and `PROTOCOL_CLI_VERSION` with a newer CLI.

Do not edit a recording. Re-record the scenario, or point the test at a
different one.

## Building and packaging

```sh
pnpm build
```

is `turbo run build --filter='!desktop'` followed by `turbo run build -F
desktop`. What lands where:

| Artifact                             | Produced by                      |
| ------------------------------------ | -------------------------------- |
| `apps/web/dist/`                     | `vite build`                     |
| `apps/server/out/main.cjs`           | esbuild, cjs, node22             |
| `apps/desktop/out/main/index.cjs`    | `apps/desktop/scripts/build.mjs` |
| `apps/desktop/out/preload/index.cjs` | the same                         |
| `apps/desktop/out/server/main.cjs`   | the server, bundled into the app |
| `apps/desktop/out/renderer/`         | a copy of `apps/web/dist`        |
| `apps/desktop/artifacts/<channel>/`  | electron-builder                 |

`pnpm build`'s desktop step runs `node scripts/package.mjs --dir`, which stops
at the unpacked directory. For real installers:

```sh
pnpm build:desktop          # channel stable
pnpm build:desktop:canary   # channel canary
```

macOS targets are `dmg` and `zip` for `arm64` and `x64`; Windows is `nsis`,
Linux is `AppImage` and `deb` (`apps/desktop/electron-builder.config.cjs`). The
channel reaches two places at once: electron-builder switches the app id
(`dev.poseidon.Poseidon.desktop[.canary]`), the product name and the output
directory, and `scripts/build.mjs` defines `process.env.POSEIDON_CHANNEL` into
the bundle so `src/platform/channel.ts` names the running app the same way. A
test asserts the two agree; otherwise the two channels would share userData.

The server is bundled into the app and spawned as a child under
`ELECTRON_RUN_AS_NODE`, so `out/server` is listed in `asarUnpack` — a child
process cannot spawn from inside the asar archive.

Both server bundles define `import.meta.url` — a banner derives it from
`__filename` — because CommonJS has none, and the Claude Agent SDK calls
`createRequire(import.meta.url)` when its module loads: without it the bundled
server throws before it starts. The banner restates `"use strict"` first, so
the bundle stays in strict mode. The preload does not get it; it runs
sandboxed, where `require("node:url")` does not exist.

The pty module is the one package the server bundle leaves external, in both
`apps/server`'s build and `apps/desktop/scripts/build.mjs`. The desktop build
copies it into `out/server/node_modules/@lydell/`, beside `main.cjs`, where the
bundle resolves it: the runtime package, plus one platform package per
architecture the app is packaged for, arm64 and x64 on macOS and Windows and
the host's on Linux (`apps/desktop/scripts/native-modules.mjs`). The copy
follows pnpm's symlinks and keeps file modes, so `spawn-helper` stays
executable, and `asarUnpack` keeps all of it as real files. The build fails if
a needed platform package is not installed. `npmRebuild` stays off: the binary
is N-API, so there is nothing to rebuild for Electron. A mac build for the
other architecture (`package.mjs --x64` on an arm64 Mac) carries its own binary
only because `supportedArchitectures` in `pnpm-workspace.yaml` installed it
([Install](#install)).

The build also patches one line of each copied `lib/unixTerminal.js`. node-pty
finds `spawn-helper` by rewriting `app.asar` in its own path to
`app.asar.unpacked`; the bundled server already runs from `app.asar.unpacked`,
so the stock rewrite would produce `app.asar.unpacked.unpacked` and every spawn
would fail with `posix_spawn failed`. The patched line rewrites only an
`app.asar` path segment. If an upgrade changes that line, the build stops and
says so instead of shipping a terminal that cannot start.

`apps/desktop` lists `@poseidon/contracts` and `@poseidon/shared` as
_devDependencies_ on purpose: esbuild inlines them into the bundle, and
electron-builder packs only `dependencies`, so declaring them as runtime
dependencies would ship a second copy of each.

The config names no code-signing identity, so a machine without a Developer ID
certificate produces an unsigned build. It runs locally; it is not something to
hand to anyone else.

## Where state lives on disk

Everything Poseidon owns hangs off `configDir()` — `~/.poseidon`, or
`POSEIDON_HOME` (`packages/shared/src/paths.ts`).

```
~/.poseidon/
├── state.sqlite            event log, projections, settings, permissions
├── attachments/            staged uploads
├── worktrees/<project>/<slug>/  threads' own git worktrees
├── plugins/<name>/         global Poseidon plugins (Claude Code plugin layout)
├── builtin-plugins/<name>/ built-in plugins, written at boot
├── bin/
│   ├── cmd-hook.mjs        generated PreToolUse hook script
│   └── tickets/<id>.ticket per-session bearer, mode 0600
└── dev/connection.json     dev handshake, mode 0600 (dev mode only)
```

`state.sqlite` is migrated on boot by `apps/server/src/persistence/Migrations.ts`;
migration ids are contiguous from 1 and a merged migration file is never
edited — new ones append.

The in-app browser's per-thread browsing data is the desktop's, not the
server's: Electron keeps each thread's `persist:thread-<id>` partition under
its own session data directory
(`~/Library/Application Support/Poseidon/Partitions/thread-<id>` on macOS),
which `POSEIDON_HOME` does not move. Deleting a thread in the app clears its
partition's storage and cache; a live check against a scratch
`POSEIDON_HOME` still writes there, so remove the `thread-<id>` directories it
created afterwards. The once-per-launch sweep of deleted threads' partitions
runs only against the default home, because a scratch home's server would
list none of the real threads; the next default-home launch clears what a
scratch home left.

A `desktop.json` left there by an older build is ignored: its one key,
`browserPane`, opened Chromium's remote-debugging port, which the shell no
longer does.

The hook script is regenerated only when its content hash changes, so starting
a session does not churn the file under a running `cmd`.

### The user's Command Code files

`POSEIDON_HOME` does not move these: they are the harness's, not ours.

| File                                                  | What Poseidon does to it                             |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `~/.commandcode/mcp.json`                             | user-scope MCP servers, from the settings page       |
| `<workspaceRoot>/.mcp.json`                           | project-scope MCP servers, the same                  |
| `<workspaceRoot>/.commandcode/settings.local.json`    | the PreToolUse hook block, while a session runs      |
| `~/.commandcode/skills`, `<root>/.commandcode/skills` | read only, for the skills list                       |
| `~/.commandcode/projects/<slug>/`                     | the CLI's own transcripts, which the connector reads |
| `~/.commandcode/plans/`                               | where a plan turn's markdown lands                   |

Both written files are edited per entry, not per file. Every MCP server Poseidon
writes carries an `_poseidon` marker and add/remove refuse to touch an entry
that lacks one; a file that exists but does not parse is never rewritten
(`packages/connector-cmd/src/mcpServers.ts`, the connector's MCP servers
extension). The hook block is installed on
session start and reverted on close, but only while the file still hashes to
the bytes the install wrote, and only once the last session in that project has
gone (`packages/connector-cmd/src/config.ts`).

The `boot()` option `commandCodeHome`, handed to
`makeCmdConnectorDefinition`, redirects the files the Customize page edits,
which is how tests avoid editing the real ones.

## Repository conventions

- **One commit per logical change**, conventional subject:
  `type(scope): what changed`, lowercase, in the imperative — `fix(connector):
spawn the binary the probe resolved`, `feat(web): rename, archive and delete
a thread`. Scopes name the area, not the workspace path.
- **No attribution trailers.** No `Co-Authored-By`, no "generated with" line,
  in commit messages or pull request descriptions.
- **Documentation lives in `docs/`**, five documents indexed by
  [docs/README.md](README.md). They are markdown that oxfmt formats like any
  other file, so `pnpm fmt` rewraps them and `pnpm fmt:check` fails on a
  document that was not rewrapped. Describe the software, not the history of
  building it.
- **Never `--no-verify`.** `pnpm check` is the gate; if it is red the change is
  not finished.

## Colour roles

The colour tokens live in `packages/ui/src/styles/globals.css`, one block for
light (`:root`) and one for dark (`.dark`). Components use them through Tailwind
utilities such as `bg-card` or `text-muted-foreground`, never through raw colour
values.

- **A purple-tinted neutral ladder** carries the canvas, cards, popovers,
  borders and text in both themes. The tint is faint: light is a barely tinted
  canvas under white cards and deep near-black text; dark is a black ladder
  (sidebar, canvas, cards, popovers, muted surfaces, each a step lighter) that
  shows its hue only on a close look, under softened off-white text.
- **One calm purple accent** — `primary`, `ring`, `sidebar-primary`,
  `sidebar-ring` and `chart-1`, all the same value — is kept for primary
  actions, focus rings, checked controls and status dots.
- **Hover and selected surfaces stay neutral.** `accent`, `sidebar-accent` and
  `--hover` sit on the ladder, so a selected sidebar row or a hovered menu item
  is never purple.
- **Semantic colours keep their own hues**: `destructive`, `--added` and
  `--removed` for diffs, `--permission`, and `--file` for file chips.

`apps/web/src/lib/theme-tokens.test.ts` parses both blocks and guards the roles:
text contrast of at least 4.5:1, a low-chroma purple hue on every ladder token,
neutral hover surfaces, one shared accent value, and the dark surfaces stepping
up in order. Change a value there and the test says which role it broke.

## Troubleshooting

**The window sits on "starting", or the shell reports the server failed.** The
supervisor gives the child 15 s to produce its fd 3 handshake, restarts it with
500 ms → 10 s backoff, and after five consecutive failures stops and reports
instead of spinning. The server's stdout and stderr are inherited, so the real
error is in the terminal running `pnpm dev`. Check that nothing else already
holds the same `POSEIDON_HOME` — two servers over one `state.sqlite` is the
usual cause after a force quit. On a normal quit the supervisor signals SIGINT
and waits for the child to exit, SIGKILLing it after 5 s.

**A browser renderer dials a dead server.** `~/.poseidon/dev/connection.json` is
written on every dev boot and is not deleted on shutdown, so a stale one points
at a port nobody is listening on. Delete it and restart `pnpm -F server dev`.
If you are running a scratch home, remember the Vite plugin resolves the file
through the same `POSEIDON_HOME` — start both sides with the same value or they
will never meet.

**Every pane tab vanished during `pnpm dev`.** Editing
`apps/web/src/state/browser-tabs.ts` hot-replaces the module that holds the
tabs atom, so the tabs start over empty and their webviews go with them —
which the agent sees as `tab_gone`. Its next call opens a fresh tab. A
packaged build never hot-replaces anything.

**`cmd` not found, or found by the probe and not by the turn.** Both the probe
and the spawn go through `resolveBinary`, so they agree; what differs is the
environment. A packaged `.app` launched from Finder inherits launchd's `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`), which is why the resolver also searches the
global bin directories. If your install is somewhere else, set `binaryPath` on
the connector instance in Settings. The npx fallback works but downloads
`command-code@latest` on first use.

**Insufficient credits.** Exit code 10, reported as
`insufficient credits — top up at https://commandcode.ai/billing and retry`.
The full exit-code table is `packages/connector-cmd/src/exitCodes.ts`: 3 is not
logged in, 4 is the CLI's own permission refusal, 5/6/7 are retryable transport
failures, 8 is `--max-turns`, 130 is an interrupt.

**The terminal says "terminal support failed to load".** `terminal.open`
failed `unavailable`: the server could not load `@lydell/node-pty` or its
platform package, and the drawer shows the reason with a Try again button. The
rest of the app is unaffected. Check that the platform package for this OS and
architecture is installed — `node_modules/.pnpm/@lydell+node-pty-<platform>-<arch>@*`
in a checkout, `out/server/node_modules/@lydell/` in a desktop build — and that
the install did not skip optional dependencies (`--no-optional`,
`--omit=optional`), since the binaries ship only as optional packages. In a
packaged app, also check that `spawn-helper` in that platform package is still
executable.

**An agent-browser daemon is still running, or a browser call hangs.** The
app's daemons live in their own namespace. Find it and look:

```sh
NS=poseidon-$(node -e 'console.log(require("crypto").createHash("sha256").update(require("path").resolve(process.env.POSEIDON_HOME ?? require("os").homedir() + "/.poseidon")).digest("hex").slice(0, 8))')
agent-browser --namespace "$NS" session list
agent-browser --namespace "$NS" --session <ade-…> session info   # pid, socket dir
agent-browser --namespace "$NS" close --all
```

The server reaps that namespace when it starts and closes every daemon when it
shuts down, so a leftover means it was SIGKILLed; the next start closes it. A
`session info` that hangs means the daemon is stuck — `close` hangs the same
way, which is when the server kills it by the pid in
`~/.agent-browser/namespaces/<ns>/run/<session>.pid`. Your own agent-browser
sessions, in the default namespace, are never touched.

**`pnpm knip` fails on a fresh tree** with an unresolved
`apps/web/src/routeTree.gen.ts`. That file is generated by `vite build` and
gitignored; run `pnpm typecheck` or `pnpm build` first. knip is a root script
and not a turbo task, so it does not build anything itself.

**A check passes locally and fails in CI, or the other way round.** Turbo
caches `build`, `test` and `check-types` in `.turbo`. Force a stage to rerun
with `pnpm exec turbo run check-types --force`. Note that `test` declares
`"inputs": ["$TURBO_DEFAULT$", "!README.md"]`, so editing a README does not
invalidate a test cache.

**An end-to-end test hangs instead of failing.** It should not: everything is
awaited through a receipt or a subscription. A hang means something is waiting
on an item that will never arrive — read the harness's `awaitItem` call rather
than raising a timeout. The replay driver already allows 120 s per test and the
live driver 600 s.
