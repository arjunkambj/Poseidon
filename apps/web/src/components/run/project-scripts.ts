/**
 * The pure half of the Run control: which saved script the main half runs,
 * what a draft of the list saves as, and whether running a script opens a
 * terminal or brings its running one to the front.
 *
 * `settings.update` replaces each key it carries, so the scripts are saved by
 * writing the whole `projectSettings` record — built here from the latest one,
 * keeping the project's setup script and every other project's settings, the
 * way `withSetupScript` (`@/components/Settings/git-settings`) keeps the
 * scripts.
 */

import type { TerminalId } from "@poseidon/contracts/ids";
import type { DetectedScript, ProjectScript } from "@poseidon/contracts/scripts";
import type { ProjectSettings } from "@poseidon/contracts/settings";
import {
  TERMINAL_SCRIPT_COMMAND_MAX_CHARS,
  type TerminalScriptLaunch,
} from "@poseidon/contracts/terminal";

import type { TerminalTab } from "@/components/terminal/drawer-state";

type ProjectSettingsRecord = { readonly [projectId: string]: ProjectSettings };

/** What the Run control launches: a saved script, or a detected one. */
export type RunnableScript = TerminalScriptLaunch;

/** One row of the Edit scripts dialog, as typed. */
export interface ScriptDraft {
  /** The saved id, or null for a row added in this dialog. */
  readonly id: string | null;
  readonly name: string;
  readonly command: string;
  readonly primary: boolean;
}

const sameScripts = (a: ReadonlyArray<ProjectScript>, b: ReadonlyArray<ProjectScript>): boolean =>
  a.length === b.length &&
  a.every(
    (script, index) =>
      script.id === b[index]!.id &&
      script.name === b[index]!.name &&
      script.command === b[index]!.command &&
      (script.primary === true) === (b[index]!.primary === true),
  );

/**
 * The `projectSettings` record with `projectId`'s scripts set to `scripts`, or
 * null when they are already that. An empty list removes the key, and a
 * project left with no settings leaves the record entirely.
 */
export const withScripts = (
  current: ProjectSettingsRecord,
  projectId: string,
  scripts: ReadonlyArray<ProjectScript>,
): ProjectSettingsRecord | null => {
  const own = current[projectId];
  if (sameScripts(own?.scripts ?? [], scripts)) {
    return null;
  }
  const { scripts: _dropped, ...rest } = own ?? {};
  const next: ProjectSettings = scripts.length === 0 ? rest : { ...rest, scripts };
  const { [projectId]: _old, ...others } = current;
  return Object.keys(next).length === 0 ? others : { ...others, [projectId]: next };
};

/** The script the Run button starts: the one marked primary, else the first. */
export const primaryScript = (saved: ReadonlyArray<ProjectScript>): ProjectScript | null =>
  saved.find((script) => script.primary === true) ?? saved[0] ?? null;

/** Why a draft cannot be saved, per row, or null when every row is fine. */
export type ScriptProblems = ReadonlyArray<string | null>;

/**
 * Each row's problem: a blank name or command, a command too long to run, or
 * a name another row has. At
 * most one row can be primary, which the dialog's exclusive checkbox keeps,
 * so a second one is reported on the row that has it.
 */
export const validateScripts = (drafts: ReadonlyArray<ScriptDraft>): ScriptProblems | null => {
  let primarySeen = false;
  const problems = drafts.map((draft, index) => {
    const name = draft.name.trim();
    if (name === "") return "Give the script a name.";
    const command = draft.command.trim();
    if (command === "") return "Give the script a command.";
    if (command.length > TERMINAL_SCRIPT_COMMAND_MAX_CHARS) {
      return `A command can be at most ${TERMINAL_SCRIPT_COMMAND_MAX_CHARS} characters.`;
    }
    const clash = drafts.findIndex((other) => other.name.trim() === name);
    if (clash !== index) return `Another script is already named “${name}”.`;
    if (draft.primary) {
      if (primarySeen) return "Only one script can be the primary one.";
      primarySeen = true;
    }
    return null;
  });
  return problems.every((problem) => problem === null) ? null : problems;
};

/** A saved script's id: its name as a slug, numbered when another has it. */
export const nextScriptId = (name: string, taken: ReadonlySet<string>): string => {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "script";
  let id = slug;
  for (let n = 2; taken.has(id); n += 1) {
    id = `${slug}-${n}`;
  }
  return id;
};

/**
 * The scripts a valid draft saves as: trimmed, a new row given a fresh id,
 * and `primary` kept only where it is set.
 */
export const scriptsFromDrafts = (drafts: ReadonlyArray<ScriptDraft>): ProjectScript[] => {
  const taken = new Set(drafts.flatMap((draft) => (draft.id === null ? [] : [draft.id])));
  return drafts.map((draft) => {
    const name = draft.name.trim();
    let id = draft.id;
    if (id === null) {
      id = nextScriptId(name, taken);
      taken.add(id);
    }
    return {
      id,
      name,
      command: draft.command.trim(),
      ...(draft.primary ? { primary: true } : {}),
    };
  });
};

/** A saved script as the dialog's rows start. */
export const draftOf = (script: ProjectScript): ScriptDraft => ({
  id: script.id,
  name: script.name,
  command: script.command,
  primary: script.primary === true,
});

/** A detected package.json script, named with its package's directory when nested. */
export const runnableFromDetected = (detected: DetectedScript): RunnableScript => ({
  id: detected.id,
  name: detected.packageDir === "" ? detected.name : `${detected.name} (${detected.packageDir})`,
  command: detected.command,
});

/** A saved script, as `terminal.open` launches it. */
export const runnableFromSaved = (script: ProjectScript): RunnableScript => ({
  id: script.id,
  name: script.name,
  command: script.command,
});

export type RunPlan =
  | { readonly kind: "focus"; readonly terminalId: TerminalId }
  | { readonly kind: "open"; readonly replace: TerminalId | null };

/**
 * Running a script whose tab is still running brings that tab to the front;
 * otherwise a fresh terminal opens, and a tab of the same script that has
 * exited (`replace`) is closed, so the strip keeps one tab per script.
 */
export const planRun = (
  tabs: ReadonlyArray<TerminalTab>,
  script: Pick<RunnableScript, "id">,
): RunPlan => {
  const own = tabs.filter((tab) => tab.script?.id === script.id);
  const running = own.find((tab) => tab.status === "running");
  if (running !== undefined) {
    return { kind: "focus", terminalId: running.terminalId };
  }
  return { kind: "open", replace: own[0]?.terminalId ?? null };
};

/** The terminal running `scriptId`, or null. */
export const runningTerminalOf = (
  tabs: ReadonlyArray<TerminalTab>,
  scriptId: string,
): TerminalId | null =>
  tabs.find((tab) => tab.script?.id === scriptId && tab.status === "running")?.terminalId ?? null;
