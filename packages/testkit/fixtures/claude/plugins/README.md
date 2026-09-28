# Claude Code's plugin config

Not a recording: the config files the real Claude Code CLI (**2.1.280**, signed
out) wrote when it installed two plugins on 2026-09-28. The connector's plugins
extension reads these (`packages/connector-claude/src/plugins.test.ts`).

How they were made, with a scratch `HOME` and `CLAUDE_CONFIG_DIR` and the
operator's `~/.claude` only read:

1. A local marketplace named `poseidon-fixtures` holding copies of the
   `agent-sdk-dev` and `commit-commands` plugins from the official marketplace
   the CLI had already downloaded (the official name is reserved for its GitHub
   source, so the copy needs a name of its own).
2. `claude plugin marketplace add <market>`, then in a scratch project
   `claude plugin install agent-sdk-dev@poseidon-fixtures` (user scope),
   `claude plugin install commit-commands@poseidon-fixtures --scope project` and
   `claude plugin disable agent-sdk-dev@poseidon-fixtures`.
3. The CLI's `installed_plugins.json`, `settings.json`, the project's
   `.claude/settings.json` and each installed plugin's `plugin.json` were copied
   here, with the scratch paths replaced by `<config>`, `<project>` and
   `<market>`. A test puts real paths back in a temporary copy.

`claude plugin list --json` on that config answered `agent-sdk-dev` (user,
disabled) and `commit-commands` (project, enabled, for the scratch project).
