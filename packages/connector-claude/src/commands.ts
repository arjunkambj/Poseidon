/**
 * Claude Code's own slash commands, as the composer's `/` menu lists them.
 *
 * The list is the `commands` of the SDK's initialization result — the same
 * handshake the model list comes from (`probe.ts`), so it costs nothing. That
 * handshake runs with `settingSources: []`: no user or project settings, hooks
 * or command files are loaded for a listing, so only the CLI's built-in and
 * bundled commands come back. A user's own `.claude/commands` are not listed,
 * though the CLI still runs them when a message names one.
 *
 * The list does not depend on the project for the same reason, so the
 * extension ignores its scope and every project shares the instance's one list.
 */

import type { HarnessCommand } from "@poseidon/contracts/harnessCommands";

/** The fields of the SDK's `SlashCommand` this reads. */
export interface ClaudeSlashCommand {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
  /** Claude Code's own command, as opposed to a user, project, plugin or MCP one. */
  readonly builtin?: boolean;
}

const present = (text: string | undefined): string | undefined => {
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/**
 * The SDK's rows as harness commands: the leading `/` stripped, an empty
 * description or argument hint left out, a nameless row dropped. Rows can
 * share a name; the CLI runs the built-in one when one is marked, so that row
 * is the one kept, and otherwise the first.
 */
export const toHarnessCommands = (
  commands: ReadonlyArray<ClaudeSlashCommand>,
): ReadonlyArray<HarnessCommand> => {
  const byName = new Map<string, { readonly row: HarnessCommand; readonly builtin: boolean }>();
  for (const command of commands) {
    const name = command.name.trim().replace(/^\/+/, "");
    if (name === "") continue;
    const builtin = command.builtin === true;
    const kept = byName.get(name);
    if (kept !== undefined && (kept.builtin || !builtin)) continue;
    const description = present(command.description);
    const argumentHint = present(command.argumentHint);
    byName.set(name, {
      builtin,
      row: {
        name,
        ...(description === undefined ? {} : { description }),
        ...(argumentHint === undefined ? {} : { argumentHint }),
      },
    });
  }
  return [...byName.values()].map((entry) => entry.row);
};
