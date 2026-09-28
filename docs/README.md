# Documentation

Seven documents, each written against the code rather than a plan. Start with
whichever question you have.

- [architecture.md](architecture.md) — the processes, the workspaces and their
  boundaries, the data model, the orchestration loop, the connector contract,
  the RPC surface, the hook bridge, the browser and permissions.
- [how-it-works.md](how-it-works.md) — the runtime traced in order: boot,
  connect, first run, a turn end to end, approvals, plan mode, stop and the
  queue, checkpoints, attachments, the browser pane, the terminal, settings,
  recovery, shutdown.
- [philosophy.md](philosophy.md) — thirteen rules the code keeps, what each one
  means concretely here, and the check that enforces it.
- [development.md](development.md) — prerequisites, the dev loop, the gate and
  each of its stages, the test conventions, the end-to-end suite, the
  recordings of the real CLI, building and packaging, and where state lives on
  disk.
- [plugins.md](plugins.md) — the Poseidon plugin standard: the Claude Code
  compatible layout, built-in and global plugins, validation, turning them on
  and off, what each harness loads, the built-in Browser plugin, and a
  harness's own plugins.
- [command-code-connector.md](command-code-connector.md) — the Command Code
  CLI as observed: binary resolution, the argv and environment of a turn, the
  NDJSON frame catalogue, the transcript, the PreToolUse hook, plan mode,
  questions, subagents, resume, attachments, and what to check after a new
  release.
- [claude-code-connector.md](claude-code-connector.md) — the Claude Code CLI
  as observed through the Agent SDK: binary resolution, the probe, the child
  environment and launch options, the message catalogue, the tool vocabulary
  and the approval gate, runtime modes, plan mode, questions, subagents,
  resume, model switching, compaction, attachments, steering, capabilities,
  and what to check after a new release.
- [codex-connector.md](codex-connector.md) — the Codex CLI as observed through
  its app-server: binary resolution, the probe, the child environment, the
  launch and the MCP injection, the notification catalogue, the tool
  vocabulary, the approval gate and runtime modes, plan mode, questions,
  steering, compaction, attachments, resume, capabilities, the skills and MCP
  server extensions, and what to check after a new release.

They cross-link rather than repeat: a flow belongs in how-it-works, a component
in architecture, a rule in philosophy, a command in development, and a fact
about a CLI in that CLI's connector reference.
