# Plugins

A Poseidon plugin is a folder that adds skills, MCP servers and, on harnesses
that can load them, commands, agents and hooks to every agent session. The
folder layout is the one Claude Code plugins already use, so an existing Claude
Code plugin works as a Poseidon plugin without changes, and a plugin written
for Poseidon also works in Claude Code.

This page is the standard: the layout, where plugins live, how they are
validated and switched on and off, and what each harness gets from them. The
code is in `apps/server/src/plugins/` (the registry), `packages/contracts/src/plugins.ts`
(the wire shapes and RPCs), `packages/connector-sdk/src/plugins.ts` (what a
connector receives), and `apps/web/src/components/customize/plugins-tab.tsx`
(the page).

## The layout

```text
my-plugin/
├── .claude-plugin/
│   └── plugin.json        optional manifest
├── skills/
│   └── <skill>/SKILL.md   Agent Skills format
├── commands/*.md          slash commands
├── agents/*.md            subagent definitions
├── hooks/hooks.json       lifecycle hooks
└── .mcp.json              MCP servers
```

**`plugin.json`** is optional. When it is present it must be valid JSON with a
kebab-case `name`; `description` and `version` are shown when given.
Without a manifest, the folder's name is the plugin's name. The manifest can
also point at other paths:

- `skills`: a path or list of paths **added to** `skills/`.
- `commands`, `agents`: a path or list of paths that **replace** the default
  folder.
- `hooks`: a path or an inline object; either one marks the plugin as having
  hooks.
- `mcpServers`: an inline map of servers, or a path or list of paths to files
  shaped like `.mcp.json`.

Every path must stay inside the plugin's folder.

**Skills** follow the open Agent Skills format: a folder holding a `SKILL.md`
whose YAML frontmatter has a `name` (matching the folder) and a `description`,
followed by the instructions. Scripts and reference files can sit beside it.
A malformed skill becomes a warning on the plugin, and the plugin's other
skills still load.

**MCP servers** are read from `.mcp.json`, either flat (`{ "server": {…} }`)
or wrapped (`{ "mcpServers": { … } }`), and from the manifest's
`mcpServers`. A server is `stdio` (`command`, `args`, `env`) or `http` (`url`,
`headers`). `${CLAUDE_PLUGIN_ROOT}` and `${POSEIDON_PLUGIN_ROOT}` in any of
those fields expand to the plugin's absolute folder. An `sse` server, an
unknown transport, or an entry with neither a command nor a url is skipped
with a warning. A `.mcp.json` that is not JSON makes the plugin invalid.

## Where plugins live

| Kind     | Folder                                  | Id                |
| -------- | --------------------------------------- | ----------------- |
| Built-in | `POSEIDON_HOME/builtin-plugins/<name>/` | `builtin:<name>`  |
| Global   | `POSEIDON_HOME/plugins/<folder>/`       | `global:<folder>` |

`POSEIDON_HOME` is `~/.poseidon` unless it is set
([development.md](development.md#poseidon_home)).

**Built-in plugins** ship inside the server as TypeScript constants
(`apps/server/src/plugins/builtin/`). `boot` writes them into
`builtin-plugins/` just before connectors are installed, rewriting only files
whose content changed. They are never written when a layer is built, because
tests build layers and would otherwise write into the real home.

**Global plugins** are folders the user puts in `POSEIDON_HOME/plugins`. The
registry reads both folders again on every request, so a plugin dropped in
shows up without a restart. Dotfiles and plain files are skipped. The
Customize → Plugins page names the folder and has **Copy path** and **Open
folder** buttons; Open folder creates it first when it is missing.

A global plugin's id comes from its folder, not its manifest, so a plugin whose
manifest cannot be parsed still has an id to list its error under.

## Validation

The registry never crashes on a bad plugin; it lists it with an `error`:

- `plugin.json` is not JSON, or its `name` is missing or not kebab-case.
- A path in the manifest leaves the plugin's folder.
- `.mcp.json` (or a file the manifest points at) cannot be parsed.
- The folder has no manifest and none of the component folders or files
  ("not a plugin").

An invalid plugin is always off, cannot be switched on (`plugins.setEnabled`
fails `invalid`), and is never handed to a session. Problems that do not stop
a plugin loading, such as one bad skill or a skipped MCP server, are listed as
`warnings`.

## Turning plugins on and off

Every valid plugin is on by default. The settings document's `plugins` record
holds only the overrides, keyed by plugin id (`{ "builtin:browser": false }`);
it defaults to `{}`, so a stored settings row from before plugins still
decodes. The Customize → Plugins page (and the `plugins.setEnabled` RPC)
writes it.

A switch changes **sessions started after it**. A running session keeps the
plugins, tools and skills it started with. When two enabled plugins share a
name, the built-in one wins, and among global plugins the first folder in
sorted order wins.

The RPCs, all in `packages/contracts/src/plugins.ts`:

| Method               | What it does                                                                 |
| -------------------- | ---------------------------------------------------------------------------- |
| `plugins.list`       | Rescans and answers `{ globalDir, plugins }`, invalid ones included          |
| `plugins.setEnabled` | Turns one plugin on or off; fails `not-found` or `invalid`                   |
| `plugins.openFolder` | Creates the global plugins folder if needed and opens it in the file manager |

## What each harness gets

The registry hands a connector the enabled, valid plugins through
`ConnectorServices.sessionPlugins(threadId)`, each a `SessionPlugin`: its
`name`, absolute `root`, whether it is built in, its skills (name,
description, folder), the folders that hold its skills (`skillsDirs`), and its
MCP servers with the plugin root already expanded. `loadSessionPlugins` in
`@poseidon/connector-sdk/plugins` calls it once at session start and turns a
missing or failing registry into no plugins with a logged warning.

The hook is optional, so a connector that has not adopted plugins still
compiles and runs; it just loads none.

| Harness      | Skills                     | MCP servers                                      | Commands, agents, hooks |
| ------------ | -------------------------- | ------------------------------------------------ | ----------------------- |
| Claude Code  | loaded by the CLI          | added by Poseidon to the SDK's `mcpServers`      | loaded by the CLI       |
| Command Code | `--skill <dir>` per folder | registered with `cmd mcp add-json --scope local` | counted, not loaded     |

**Claude Code** gets each plugin as an SDK `plugins` entry
(`{ type: "local", path, skipMcpDiscovery: true }`), which reaches the CLI as
`--plugin-dir`, so it loads the plugin's skills, commands, agents and hooks
the way it loads any of its own plugins. Poseidon adds the plugin's MCP
servers itself, as `plugin-<plugin>-<server>`, so both harnesses read them the
same way ([claude-code-connector.md](claude-code-connector.md)).

**Command Code** gets one `--skill <dir>` per plugin skills folder, at the end
of the argv, and each plugin MCP server registered for the project as
`poseidon-plugin-<plugin>-<server>`, reference-counted per project and removed
when the last session using it ends. Command Code has no plugin loader, so
commands, agents and hooks are only counted on the Plugins page
([command-code-connector.md](command-code-connector.md)).

With no plugin enabled, both connectors send exactly what they sent before
plugins existed, which is why the recorded tests of the real CLIs still
replay unchanged.

**Codex** reads skills in the same Agent Skills format (from `.agents/skills`
in the repository and the user's home) and MCP servers from its
`config.toml` (`[mcp_servers.<name>]`, stdio or streamable HTTP). It also has
its own plugin format, with the manifest in `.codex-plugin/plugin.json`,
bundling skills and a `.mcp.json`. A Codex connector adopts Poseidon plugins
the same way the others do: read `sessionPlugins` at session start, point the
CLI at each plugin's `skillsDirs`, and register each `SessionMcpServer` in the
form the CLI takes, for example a `-c mcp_servers.<name>…` override per
session, which leaves the user's `config.toml` untouched.

**A new connector** does the same: call `loadSessionPlugins(services,
threadId)` once when the session starts, give the harness the skills folders
and MCP servers in whatever form it accepts, load commands, agents and hooks
only if the harness has a native loader for the Claude Code layout, add
nothing to its launch when the list is empty, and say in its connector doc
which parts it loads.

## References in the prompt

The composer's `@` menu lists the enabled Poseidon plugins first, on every
harness, then the thread instance's own plugins. Picking one sends a
`TurnReference { kind: "plugin", name }` with the turn. Both connectors write
it into the prompt as `Use the "<name>" plugin.`; Command Code does that only
for one of the session's Poseidon plugins and reports any other plugin
reference as a session warning.

## The Browser plugin

`builtin:browser` is the one built-in plugin, and it is on by default. It
carries:

- the **browser tools** (`browser_open`, `browser_snapshot`, `browser_click`
  and the rest), which every session reaches through Poseidon's own MCP
  gateway (`apps/server/src/mcp/McpGateway.ts`), not through a `.mcp.json`;
- a **`browser` skill** that teaches an agent to prefer the in-app browser,
  to work in a snapshot, act, snapshot again loop, to check visuals with
  screenshots, to find the project's dev server, and to stop when the user
  takes over.

Turning it off removes both from new sessions: the skill is not loaded, and a
gateway bearer minted while the plugin is off lists no browser tools and
refuses a browser call with a message pointing at Customize → Plugins. The
state is read once, when the session's bearer is minted, so a running session
keeps its tools. The browser's security model does not change with the plugin:
the scoped CDP bridge, the per-session capability tokens and the kill switch
work exactly as described in [architecture.md](architecture.md) and
[how-it-works.md](how-it-works.md#10-the-browser-pane).

## A harness's own plugins

Some harnesses install plugins of their own. Claude Code keeps them in its
config folder (`plugins/installed_plugins.json` plus `enabledPlugins` in its
settings). The Claude connector's `plugins` extension reads those files
without starting the CLI, so the Customize page and the `@` menu can list them
next to Poseidon's plugins ([claude-code-connector.md](claude-code-connector.md#claude-codes-own-plugins)).

They are **read-only** in Poseidon: the Plugins page shows each one under its
instance with a Claude Code badge and a disabled switch ("Managed by Claude
Code"). Install, remove and switch them with the CLI (`claude plugin`).
Poseidon never writes to the harness's config folder.

## The Plugins page

Customize → Plugins (`/customize/plugins`, also in the command palette as
**Plugins**, with no default chord) shows:

- **Poseidon**: a card per built-in and global plugin, with its name, source
  badge (Built-in or Global), one-line description, contents ("2 skills · 1 MCP
  server · 3 commands", zero parts left out) and an on/off switch. An invalid
  plugin has an Invalid badge, its error in place of the contents, and a
  disabled switch. With no global plugins, an empty state names the global
  folder with Copy path and Open folder.
- One section per connector instance with its own plugins, read-only as above.

The tab's count adds up Poseidon's plugins and every instance's own.
