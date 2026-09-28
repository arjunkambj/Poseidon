/**
 * One composer turn as the `input` of `turn/start`.
 *
 * The text goes first, then each mention as `@path` — the form the CLI's own
 * composer writes a file mention in — then one line per attachment named by
 * path (`attachments.ts`), all in one `text` input. Each image follows as a
 * `localImage` input naming its file. `text_elements` marks UI spans inside
 * the text; Poseidon marks none.
 */

import type { TurnInput } from "@poseidon/connector-sdk/definition";

import type { StagedAttachments } from "./attachments";

export type UserInput =
  | { readonly type: "text"; readonly text: string; readonly text_elements: ReadonlyArray<never> }
  | { readonly type: "localImage"; readonly path: string };

const NONE: Pick<StagedAttachments, "images" | "promptLines"> = { images: [], promptLines: [] };

export const userInput = (
  turn: TurnInput,
  staged: Pick<StagedAttachments, "images" | "promptLines"> = NONE,
): ReadonlyArray<UserInput> => {
  const text = [turn.text, ...turn.mentions.map((mention) => `@${mention}`), ...staged.promptLines]
    .filter((line) => line !== "")
    .join("\n");
  return [
    ...(text === "" ? [] : [{ type: "text" as const, text, text_elements: [] }]),
    ...staged.images.map((path) => ({ type: "localImage" as const, path })),
  ];
};
