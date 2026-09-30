# Poseidon

Poseidon is a desktop application for Claude Code, Codex and Command Code that
gives an agentic coding CLI a real interface. It does not contain an agent: it
spawns the CLI you already have installed, watches everything that run does,
and turns it into a sidebar of projects and threads, a streaming timeline,
approval cards you answer before a tool runs, a diff pane, a browser the agent
can drive and you can take over, and settings that edit real files. Claude Code
is the default; when it is not installed or not signed in, new threads run on
Codex. Nothing above the connector boundary knows which CLI is running, so
another harness is a package rather than a rewrite.

## Requirements

| Thing            | Version                     |
| ---------------- | --------------------------- |
| Node             | `>=22.16`                   |
| pnpm             | `11.21.0`, via `corepack`   |
| Claude Code CLI  | whatever you have installed |
| Codex CLI        | whatever you have installed |
| Command Code CLI | whatever you have installed |
| git              | any, for checkpoints        |

`agent-browser` is optional: without it the browser pane shows an install
prompt and everything else works.

## Install and run

```sh
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` starts the Vite dev server, bundles the Electron main and preload
processes in watch mode, and opens the desktop app; the app spawns and
supervises the server itself. Sign in to each CLI you use once — setup probes
every harness and shows the command that installs or signs in the ones that
cannot run.

To run the renderer in a browser tab instead, start the server on its own with
`pnpm -F server dev` and the web app with `pnpm dev:web`.

## The gate

```sh
pnpm check
```

Lint, format, types, tests, package boundaries, file sizes and dead code, in
that order — the same command CI runs on Linux and macOS. `pnpm build` produces
the server bundle, the web assets and a packaged desktop app.

## A tour

- **Sidebar** — projects, their threads, status and an unread dot.
- **Timeline** — the answer as it streams, with a row per tool call: commands,
  file changes with inline diffs, searches, skills, subagent tasks. Finished
  work folds into one "Worked for Ns · N tools" line.
- **Composer** — `/` for model, effort, mode, plan and the project's skills,
  `#` to mention a file, `@` for the harness's plugins and skills, `$` for its
  skills alone, images by paste or drop, `Cmd+Enter` to queue a message while a
  turn is running.
- **Cards** — an approval card before a gated tool call (allow once, for the
  session, always with an editable pattern, or deny), a question card when the
  model asks something, a plan card to accept or revise.
- **Right dock** — changes (diffs per turn, with checkpoint restore), browser
  (the page the agent is driving, which you can take over mid-call), files.
- **Settings** — connectors, MCP servers, skills, keybindings, appearance,
  written to the CLI's own config files with our entries marked as ours.

## Documentation

| Document                                                         | What it answers                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                     | What the pieces are and how they connect                 |
| [docs/how-it-works.md](docs/how-it-works.md)                     | What happens at runtime, from boot to shutdown           |
| [docs/philosophy.md](docs/philosophy.md)                         | The rules the code keeps, and where each one is enforced |
| [docs/development.md](docs/development.md)                       | Running, testing, checking and packaging it              |
| [docs/claude-code-connector.md](docs/claude-code-connector.md)   | What the `claude` CLI actually does, as recorded         |
| [docs/codex-connector.md](docs/codex-connector.md)               | What the `codex` CLI actually does, as recorded          |
| [docs/command-code-connector.md](docs/command-code-connector.md) | What the `cmd` CLI actually does, as recorded            |

[docs/README.md](docs/README.md) is the same index, one line per document.
