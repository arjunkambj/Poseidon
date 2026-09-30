/**
 * One composer turn as the `input` of `turn/start`.
 *
 * The text goes first, then each mention as `@path` — the form the CLI's own
 * composer writes a file mention in — then one line per skill or plugin
 * reference, then one line per attachment named by path (`attachments.ts`),
 * all in one `text` input. Each image follows as a `localImage` input naming
 * its file. `text_elements` marks UI spans inside the text; Poseidon marks
 * none.
 *
 * The composer's text carries only its draft token for a reference, which the
 * CLI gives no meaning to, so each reference becomes one sentence naming it,
 * quoted — `Use the "<name>" skill.` or `Use the "<name>" plugin.`, the lines
 * the other connectors write. Skills come first, then plugins, and a name
 * referenced twice is named once. The CLI loads the user's own skills and
 * plugins, and the session's Poseidon plugins' skills (`plugins.ts`), so
 * either name is one the model can act on (`plugin-skill`).
 */

import type { TurnInput } from "@poseidon/connector-sdk/definition";
import type { TurnReference } from "@poseidon/contracts/runtime";

import type { StagedAttachments } from "./attachments";

const referenceLines = (references: ReadonlyArray<TurnReference>): Array<string> => {
  const skills = new Set<string>();
  const plugins = new Set<string>();
  for (const reference of references) {
    (reference.kind === "skill" ? skills : plugins).add(reference.name);
  }
  return [
    ...[...skills].map((name) => `Use the ${JSON.stringify(name)} skill.`),
    ...[...plugins].map((name) => `Use the ${JSON.stringify(name)} plugin.`),
  ];
};

export type UserInput =
  | { readonly type: "text"; readonly text: string; readonly text_elements: ReadonlyArray<never> }
  | { readonly type: "localImage"; readonly path: string };

const NONE: Pick<StagedAttachments, "images" | "promptLines"> = { images: [], promptLines: [] };

export const userInput = (
  turn: TurnInput,
  staged: Pick<StagedAttachments, "images" | "promptLines"> = NONE,
): ReadonlyArray<UserInput> => {
  const text = [
    turn.text,
    ...turn.mentions.map((mention) => `@${mention}`),
    ...referenceLines(turn.references ?? []),
    ...staged.promptLines,
  ]
    .filter((line) => line !== "")
    .join("\n");
  return [
    ...(text === "" ? [] : [{ type: "text" as const, text, text_elements: [] }]),
    ...staged.images.map((path) => ({ type: "localImage" as const, path })),
  ];
};
