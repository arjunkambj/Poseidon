/**
 * Codex's skills, found for the Customize page and the composer's `/` menu.
 * This is the `skills` extension; it reads, and never writes.
 *
 * The roots are the ones codex-cli 0.156.1 itself loads, checked against its
 * app-server's `skills/list` on a scratch `CODEX_HOME` and a scratch repo:
 *
 * - project: `<workspaceRoot>/.codex/skills` and `<workspaceRoot>/.agents/skills`
 *   (the CLI's `repo` scope);
 * - user: `<CODEX_HOME>/skills` and the shared `~/.agents/skills` (its `user`
 *   scope).
 *
 * A skill is `<root>/<entry>/SKILL.md`, named and described by its
 * frontmatter. Dot entries are skipped: `<CODEX_HOME>/skills/.system` holds the
 * skills the CLI ships with, which are the CLI's rather than the user's.
 *
 * There is no `available`/`link` half. Its point is offering skills from the
 * shared agents folder that the harness does not load yet, and Codex already
 * loads every one of them, so there would never be anything to offer.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import * as NodePath from "node:path";
import type { ExtensionScope, SkillsExtension } from "@poseidon/connector-sdk/extensions";
import { parseSkillFrontmatter } from "@poseidon/connector-sdk/skills";
import type { SkillSummary } from "@poseidon/contracts/connectors";
import * as Effect from "effect/Effect";

const isDirectory = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => stat(path)).pipe(
    Effect.map((info) => info.isDirectory()),
    Effect.orElseSucceed(() => false),
  );

/** One root's skills, in name order; a missing or unreadable root has none. */
const readRoot = (root: string): Effect.Effect<ReadonlyArray<SkillSummary>> =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise(() => readdir(root)).pipe(
      Effect.orElseSucceed((): Array<string> => []),
    );
    const out: Array<SkillSummary> = [];
    for (const entry of entries.toSorted()) {
      if (entry.startsWith(".")) continue;
      const dir = NodePath.join(root, entry);
      if (!(yield* isDirectory(dir))) continue;
      const path = NodePath.join(dir, "SKILL.md");
      const content = yield* Effect.tryPromise(() => readFile(path, "utf8")).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (content === null) continue;
      const frontmatter = parseSkillFrontmatter(content);
      const name =
        frontmatter.name !== undefined && frontmatter.name !== "" ? frontmatter.name : entry;
      out.push({
        name,
        path,
        ...(frontmatter.description === undefined ? {} : { description: frontmatter.description }),
        enabled: true,
      });
    }
    return out;
  });

export interface CodexSkillsOptions {
  /** The instance's `CODEX_HOME` — `~/.codex` unless the instance names one. */
  readonly codexHome: string;
  /** The shared agents skills folder — `~/.agents/skills` in production. */
  readonly agentsSkillsRoot: string;
}

/** The skill roots a scope reaches, project roots first. */
export const skillRoots = (
  options: CodexSkillsOptions,
  scope: ExtensionScope,
): ReadonlyArray<string> => [
  ...(scope.workspaceRoot === null
    ? []
    : [
        NodePath.join(scope.workspaceRoot, ".codex", "skills"),
        NodePath.join(scope.workspaceRoot, ".agents", "skills"),
      ]),
  NodePath.join(options.codexHome, "skills"),
  options.agentsSkillsRoot,
];

export const makeCodexSkills = (options: CodexSkillsOptions): SkillsExtension => ({
  list: (scope) =>
    Effect.gen(function* () {
      // One row per name: the first root that has it — the project's before
      // the user's — is the one listed.
      const seen = new Set<string>();
      const out: Array<SkillSummary> = [];
      for (const root of skillRoots(options, scope)) {
        for (const skill of yield* readRoot(root)) {
          if (seen.has(skill.name)) continue;
          seen.add(skill.name);
          out.push(skill);
        }
      }
      return out;
    }),
});
