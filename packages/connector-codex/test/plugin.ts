/**
 * The Poseidon plugin `plugin-skill` was recorded with: one skill that names
 * a word nothing else in the scratch repo does, and one HTTP MCP server
 * pointed at the discard port, so the thread's config shows it tried and
 * failed. The files live beside the scenario's scratch repo, under the root
 * the finaliser scrubs to `<SCRATCH>`; a replay needs none of them, since the
 * session is handed the plugin as the server's registry would resolve it.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { SessionPlugin } from "@poseidon/connector-sdk/plugins";

const ROOT = "/tmp/poseidon-codex/scratch/plugin-skill-plugin";

export const SCRATCH_SKILL = {
  name: "scratch-word",
  description: "Names the scratch word. Use it whenever the scratch word is asked for.",
  word: "marmalade",
} as const;

export const SCRATCH_PLUGIN: SessionPlugin = {
  name: "scratch",
  root: ROOT,
  builtin: false,
  skills: [
    {
      name: SCRATCH_SKILL.name,
      description: SCRATCH_SKILL.description,
      path: NodePath.join(ROOT, "skills", SCRATCH_SKILL.name),
    },
  ],
  skillsDirs: [NodePath.join(ROOT, "skills")],
  mcpServers: [{ name: "words", transport: "http", url: "http://127.0.0.1:9/mcp" }],
};

/** Writes the plugin's skill where `SCRATCH_PLUGIN` says it is. */
export const writeScratchPlugin = (): void => {
  const dir = NodePath.join(ROOT, "skills", SCRATCH_SKILL.name);
  NodeFS.rmSync(ROOT, { recursive: true, force: true });
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, "SKILL.md"),
    `---\nname: ${SCRATCH_SKILL.name}\ndescription: ${SCRATCH_SKILL.description}\n---\n\nThe scratch word is ${SCRATCH_SKILL.word}. Reply with it, and nothing else.\n`,
    "utf8",
  );
};
