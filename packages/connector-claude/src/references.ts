/**
 * A turn's skill and plugin references, as prompt lines.
 *
 * The composer's text carries only its draft token for a reference, which the
 * CLI gives no meaning to, so each reference becomes one sentence naming it,
 * quoted: `Use the "<name>" skill.` or `Use the "<name>" plugin.`. Skills come
 * first, then plugins, and a name referenced twice is named once. The CLI loads
 * the user's own skills and plugins and Poseidon's enabled ones
 * (`pluginOptions.ts`), so either name is one the model can act on.
 */

import type { TurnReference } from "@poseidon/contracts/orchestration";

export const referenceLines = (references: ReadonlyArray<TurnReference>): Array<string> => {
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
