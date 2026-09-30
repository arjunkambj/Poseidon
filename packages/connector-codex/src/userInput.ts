/**
 * One composer turn as the `input` of `turn/start`.
 *
 * The text goes first, then each mention as `@path` — the form the CLI's own
 * composer writes a file mention in — then one line per plugin reference and
 * per skill reference the CLI could not place, then one line per attachment
 * named by path (`attachments.ts`), all in one `text` input. Each skill the
 * CLI knows follows as a `skill` input, then each image as a `localImage`
 * input naming its file. `text_elements` marks UI spans inside the text;
 * Poseidon marks none.
 *
 * The composer's text carries only its draft token for a reference, which the
 * CLI gives no meaning to. A skill reference goes as the CLI's own composer
 * attaches one: a `skill` input naming the skill and its `SKILL.md`, found in
 * the app-server's `skills/list` (`skillPathsFrom`), which lists the user's
 * skills and the session's Poseidon plugins' (`plugins.ts`) alike. The CLI
 * then adds the skill's instructions to the turn itself, so the model has no
 * file to read, and no approval to ask for reading it (`plugin-skill`,
 * checked on 0.159.2). A skill `skills/list` does not name, and every plugin
 * reference, becomes one sentence naming it, quoted — `Use the "<name>"
 * skill.` or `Use the "<name>" plugin.`, the lines the other connectors write.
 * Skills come first, then plugins, and a name referenced twice is named once.
 * The protocol's `mention` input would attach a plugin the same way; what
 * path it takes for one is not recorded, so plugins keep the sentence.
 */

import type { TurnInput } from "@poseidon/connector-sdk/definition";
import type { TurnReference } from "@poseidon/contracts/runtime";

import type { StagedAttachments } from "./attachments";
import type { SkillsListResponse } from "./protocol";

/** The skills a turn references, once each, in order. */
const skillNames = (references: ReadonlyArray<TurnReference>): ReadonlyArray<string> => [
  ...new Set(
    references.flatMap((reference) => (reference.kind === "skill" ? [reference.name] : [])),
  ),
];

const referenceLines = (
  references: ReadonlyArray<TurnReference>,
  skillPaths: ReadonlyMap<string, string>,
): Array<string> => {
  const plugins = new Set<string>();
  for (const reference of references) {
    if (reference.kind === "plugin") plugins.add(reference.name);
  }
  return [
    ...skillNames(references)
      .filter((name) => !skillPaths.has(name))
      .map((name) => `Use the ${JSON.stringify(name)} skill.`),
    ...[...plugins].map((name) => `Use the ${JSON.stringify(name)} plugin.`),
  ];
};

/** Whether a turn references any skill, so its `SKILL.md` paths are worth asking for. */
export const referencesSkills = (turn: TurnInput): boolean =>
  (turn.references ?? []).some((reference) => reference.kind === "skill");

/**
 * Each enabled skill's `SKILL.md` by name, from `skills/list`; the first of a
 * name wins, as the CLI lists the workspace's before the user's.
 */
export const skillPathsFrom = (response: SkillsListResponse): ReadonlyMap<string, string> => {
  const paths = new Map<string, string>();
  for (const entry of response.data) {
    for (const skill of entry.skills) {
      if (skill.enabled && !paths.has(skill.name)) paths.set(skill.name, skill.path);
    }
  }
  return paths;
};

export type UserInput =
  | { readonly type: "text"; readonly text: string; readonly text_elements: ReadonlyArray<never> }
  | { readonly type: "skill"; readonly name: string; readonly path: string }
  | { readonly type: "localImage"; readonly path: string };

const NONE: Pick<StagedAttachments, "images" | "promptLines"> = { images: [], promptLines: [] };

export const userInput = (
  turn: TurnInput,
  staged: Pick<StagedAttachments, "images" | "promptLines"> = NONE,
  skillPaths: ReadonlyMap<string, string> = new Map(),
): ReadonlyArray<UserInput> => {
  const references = turn.references ?? [];
  const text = [
    turn.text,
    ...turn.mentions.map((mention) => `@${mention}`),
    ...referenceLines(references, skillPaths),
    ...staged.promptLines,
  ]
    .filter((line) => line !== "")
    .join("\n");
  return [
    ...(text === "" ? [] : [{ type: "text" as const, text, text_elements: [] }]),
    ...skillNames(references).flatMap((name) => {
      const path = skillPaths.get(name);
      return path === undefined ? [] : [{ type: "skill" as const, name, path }];
    }),
    ...staged.images.map((path) => ({ type: "localImage" as const, path })),
  ];
};
