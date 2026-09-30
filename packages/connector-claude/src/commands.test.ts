/**
 * The SDK's `SlashCommand` rows as the composer's `/` menu reads them. The
 * recorded handshake scrubs its command list down to one entry
 * (`definition.test.ts` replays it), so the shapes here are the SDK's
 * declared fields.
 */

import { describe, expect, it } from "@effect/vitest";

import { toHarnessCommands } from "./commands";

describe("toHarnessCommands", () => {
  it("keeps the name, description and argument hint", () => {
    expect(
      toHarnessCommands([
        { name: "review", description: "Review a pull request", argumentHint: "[pr]" },
      ]),
    ).toEqual([{ name: "review", description: "Review a pull request", argumentHint: "[pr]" }]);
  });

  it("strips a leading slash and drops a nameless row", () => {
    expect(
      toHarnessCommands([
        { name: "/cost", description: "Show the session's cost", argumentHint: "" },
        { name: "  ", description: "nothing to run" },
        { name: "/", description: "nothing to run" },
      ]).map((command) => command.name),
    ).toEqual(["cost"]);
  });

  it("leaves out an empty description or argument hint", () => {
    expect(toHarnessCommands([{ name: "clear", description: " ", argumentHint: "" }])).toEqual([
      { name: "clear" },
    ]);
  });

  it("keeps one row per name, the built-in one when a row is marked", () => {
    expect(
      toHarnessCommands([
        { name: "init", description: "a project's own init", argumentHint: "" },
        { name: "review", description: "first", argumentHint: "" },
        { name: "init", description: "Initialize CLAUDE.md", argumentHint: "", builtin: true },
        { name: "review", description: "second", argumentHint: "" },
        { name: "init", description: "a plugin's init", argumentHint: "" },
      ]),
    ).toEqual([
      { name: "init", description: "Initialize CLAUDE.md" },
      { name: "review", description: "first" },
    ]);
  });

  it("drops the cli's internal and retired rows, keeping the ones a user runs", () => {
    // The shape CLI 2.1.280 returns from a handshake with no settings loaded:
    // every row built in, plumbing listed beside the user's commands.
    expect(
      toHarnessCommands([
        {
          name: "context",
          description: "Show current context usage",
          argumentHint: "",
          builtin: true,
        },
        {
          name: "__remote-workflow",
          description: "Run the workflow script delivered in this session environment",
          argumentHint: "",
          builtin: true,
        },
        {
          name: "workflow-launch-exec",
          description: "Execute a server-launched workflow handoff",
          argumentHint: "",
          builtin: true,
        },
        {
          name: "heapdump",
          description: "Dump the JS heap to the Desktop",
          argumentHint: "",
          builtin: true,
        },
        {
          name: "agents",
          description: "(removed) Ask Claude to create/manage subagents",
          argumentHint: "",
          builtin: true,
        },
        {
          // 2.1.286, signed in: an old name kept as a pointer to the new one.
          name: "extra-usage",
          description: "Renamed to /usage-credits",
          argumentHint: "",
          builtin: true,
        },
        {
          name: "rename",
          description: "Rename the current conversation",
          argumentHint: "[name]",
          builtin: true,
        },
      ]).map((command) => command.name),
    ).toEqual(["context", "rename"]);
  });
});
