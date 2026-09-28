/**
 * The `/` popover. Level one lists the built-in commands plus the connector's
 * skills; `model`, `effort` and `mode` open a second level whose pick becomes
 * a `thread.settings.update` patch. Everything the menu can do is expressed as
 * a `SlashAction` so the composer keeps one `onSelect` path. `/effort` and
 * `/mode` offer what the header pickers offer: the model's rungs in the
 * contract's order, and the modes the connector can honour.
 *
 * `/compact` is listed only when the thread's bound session declared
 * `capabilities.compaction` (`canCompact`, passed in rather than read from
 * `capabilities`, which are the instance's): picking it starts the same
 * `/compact` turn a typed one would, so the harness runs its own command.
 *
 * There is deliberately no `/clear`: in the harnesses this menu stands in for
 * that name clears the session context, and no command in the union does that
 * yet. Offering it as a name for "empty the textarea" would silently drop the
 * draft while keeping the context the user meant to drop.
 *
 * Last comes the Harness group: the harness's own commands as the connector
 * lists them (`connectors.commands.list`). Picking one inserts `/name ` like a
 * skill does, and the harness runs it when the message is sent. Names Poseidon
 * already offers above (every built-in, even `/compact` while it is hidden,
 * and an enabled skill's name) are left out so nothing is listed twice, and so
 * is the harness's `/clear`, which would reset the conversation behind the
 * timeline's back. The group goes last because `TriggerMenu` draws a heading
 * where `group` changes, and a heading above the skills would claim them too.
 */

import type { Effort, InteractionMode, RuntimeMode } from "@poseidon/contracts/enums";
import type { ModelOption, SkillSummary } from "@poseidon/contracts/connectors";
import type { HarnessCommand } from "@poseidon/contracts/harnessCommands";
import type { ConnectorCapabilities } from "@poseidon/contracts/runtime";

import {
  TriggerMenu,
  matchesQuery as match,
  type TriggerMenuItem,
} from "@/components/composer/trigger-menu";
import { orderEfforts } from "@/lib/efforts";
import { RUNTIME_MODE_LABELS, runtimeModeOptions } from "@/lib/runtime-modes";
import {
  Brain,
  Eraser,
  Lightning,
  ListChecks,
  Lock,
  Minimize,
  Play,
  Sparkles,
  Terminal,
} from "@honeyicons/react";

export type SlashLevel = "root" | "model" | "effort" | "mode";

/** The level-2 slash query: everything after the command word. */
const subQuery = (query: string): string => {
  const space = query.search(/\s/u);
  return space === -1 ? "" : query.slice(space + 1);
};

/** What picking an item means — the composer turns it into a dispatch or a text edit. */
export type SlashAction =
  | { readonly type: "settings"; readonly patch: SlashPatch }
  | { readonly type: "insert"; readonly text: string }
  | { readonly type: "clear-draft" }
  | { readonly type: "compact" }
  | { readonly type: "level"; readonly level: SlashLevel };

export interface SlashPatch {
  readonly model?: string;
  readonly effort?: Effort;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: InteractionMode;
}

export interface SlashMenuItem extends TriggerMenuItem {
  readonly action: SlashAction;
}

/** Harness command names never offered: `/clear` would reset the session behind the timeline. */
const HARNESS_SKIPPED: ReadonlySet<string> = new Set(["clear"]);

/** The harness's words for a command, with its argument hint after them. */
const harnessDescription = (command: HarnessCommand): string | undefined =>
  [command.description, command.argumentHint]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ") || undefined;

const RUNTIME_MODE_DESCRIPTIONS: Readonly<Record<RuntimeMode, string>> = {
  "approval-required": "Prompt for everything that mutates or reaches out",
  "auto-accept-edits": "Edits inside the project run free, shell and web still ask",
  "full-access": "Everything except sensitive paths and deny rules",
};

/**
 * The items for one menu level, filtered by the trigger query. `efforts` is
 * the ladder the current model states, if it states one; `capabilities` are
 * the thread's connector's, `null` while unknown.
 */
export const slashMenuItems = (input: {
  readonly level: SlashLevel;
  /** The whole trigger query; a second level filters on what follows the command word. */
  readonly query: string;
  readonly skills: ReadonlyArray<SkillSummary>;
  /** The harness's own commands, listed last under a Harness heading. */
  readonly harnessCommands: ReadonlyArray<HarnessCommand>;
  readonly models: ReadonlyArray<ModelOption>;
  readonly efforts: ReadonlyArray<Effort> | undefined;
  readonly capabilities: ConnectorCapabilities | null;
  /** The thread's bound session can compact on demand (`canCompact`). */
  readonly canCompact: boolean;
}): ReadonlyArray<SlashMenuItem> => {
  const { level, skills, harnessCommands, models, efforts, capabilities, canCompact } = input;
  const query = level === "root" ? input.query : subQuery(input.query);

  if (level === "model") {
    return models
      .filter((model) => match(query, model.id, model.label, model.family))
      .map((model) => ({
        id: `model:${model.id}`,
        label: model.label,
        description: model.family,
        icon: Brain,
        action: { type: "settings", patch: { model: model.id } },
      }));
  }

  if (level === "effort") {
    return orderEfforts(efforts)
      .filter((effort) => match(query, effort))
      .map((effort) => ({
        id: `effort:${effort}`,
        label: effort,
        icon: Lightning,
        action: { type: "settings", patch: { effort } },
      }));
  }

  if (level === "mode") {
    return runtimeModeOptions(capabilities)
      .filter((mode) => match(query, RUNTIME_MODE_LABELS[mode], mode))
      .map((mode) => ({
        id: `mode:${mode}`,
        label: RUNTIME_MODE_LABELS[mode],
        description: RUNTIME_MODE_DESCRIPTIONS[mode],
        icon: Lock,
        action: { type: "settings", patch: { runtimeMode: mode } },
      }));
  }

  const builtinList: ReadonlyArray<SlashMenuItem> = [
    {
      id: "builtin:model",
      label: "/model",
      description: "Switch the response model",
      icon: Brain,
      action: { type: "level", level: "model" },
    },
    {
      id: "builtin:effort",
      label: "/effort",
      description: "Switch reasoning effort",
      icon: Lightning,
      action: { type: "level", level: "effort" },
    },
    {
      id: "builtin:mode",
      label: "/mode",
      description: "Switch the runtime permission mode",
      icon: Lock,
      action: { type: "level", level: "mode" },
    },
    {
      id: "builtin:plan",
      label: "/plan",
      description: "Plan first — propose instead of executing",
      icon: ListChecks,
      action: { type: "settings", patch: { interactionMode: "plan" } },
    },
    {
      id: "builtin:default",
      label: "/default",
      description: "Back to normal execution",
      icon: Play,
      action: { type: "settings", patch: { interactionMode: "default" } },
    },
    ...(canCompact
      ? [
          {
            id: "builtin:compact",
            label: "/compact",
            description: "Summarise the conversation to free context",
            icon: Minimize,
            action: { type: "compact" },
          } satisfies SlashMenuItem,
        ]
      : []),
    {
      id: "builtin:clear-draft",
      label: "/clear-draft",
      description: "Empty the message you are writing",
      icon: Eraser,
      action: { type: "clear-draft" },
    },
  ];

  const builtins = builtinList.filter((item) => match(query, item.label, item.description ?? ""));

  const skillItems: ReadonlyArray<SlashMenuItem> = skills
    .filter((skill) => skill.enabled && match(query, skill.name, skill.description ?? ""))
    .map((skill) => ({
      id: `skill:${skill.name}`,
      label: `/${skill.name}`,
      description: skill.description,
      icon: Sparkles,
      action: { type: "insert", text: `/${skill.name} ` },
    }));

  // Every built-in name, listed or not, and every enabled skill's name.
  const taken = new Set([
    ...HARNESS_SKIPPED,
    ...builtinList.map((item) => item.label.slice(1)),
    "compact",
    ...skills.filter((skill) => skill.enabled).map((skill) => skill.name),
  ]);
  const harnessItems: ReadonlyArray<SlashMenuItem> = harnessCommands
    .filter((command) => !taken.has(command.name))
    .filter((command) =>
      match(query, command.name, command.description ?? "", command.argumentHint ?? ""),
    )
    .map((command) => ({
      id: `harness:${command.name}`,
      label: `/${command.name}`,
      description: harnessDescription(command),
      group: "Harness",
      icon: Terminal,
      action: { type: "insert", text: `/${command.name} ` },
    }));

  return [...builtins, ...skillItems, ...harnessItems];
};

export function SlashMenu({
  items,
  activeIndex,
  onSelect,
  onHover,
  level,
}: {
  readonly items: ReadonlyArray<SlashMenuItem>;
  readonly activeIndex: number;
  readonly onSelect: (item: SlashMenuItem) => void;
  readonly onHover: (index: number) => void;
  readonly level: SlashLevel;
}) {
  return (
    <TriggerMenu
      items={items}
      activeIndex={activeIndex}
      onSelect={onSelect}
      onHover={onHover}
      emptyLabel={level === "root" ? "No matching commands" : "No options"}
      label={level === "root" ? "Slash commands" : `Pick a ${level}`}
    />
  );
}
