/**
 * Claude Code's own skills, for the Customize page and the composer's `$`
 * menu. This is the `skills` extension.
 *
 * A session loads skills from the user and project settings sources
 * (`queryOptions.ts`), and those keep them in two roots:
 *
 * - project: `<workspaceRoot>/.claude/skills`;
 * - user: `<config>/skills`, where `<config>` is the instance's
 *   `CLAUDE_CONFIG_DIR`, else `~/.claude` — the account its sessions use.
 *
 * A skill is `<root>/<entry>/SKILL.md`, named and described by its
 * frontmatter, and the entry may be a symlink to a directory elsewhere. Dot
 * entries are skipped. Skills a plugin carries are the `plugins` extension's.
 *
 * Skills are read, never written — with one exception, as on Command Code: a
 * skill in the shared agents folder (`~/.agents/skills`), which the CLI does
 * not load, can be linked into the user root as a relative symlink, the same
 * shape the skills installer writes there. Nothing is copied, so the agents
 * folder stays the source.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ConnectorExtensionFailed,
  type ExtensionScope,
  type SkillsExtension,
} from "@poseidon/connector-sdk/extensions";
import {
  linkSkill,
  occupiedSkillEntries,
  parseSkillFrontmatter,
} from "@poseidon/connector-sdk/skills";
import type { AgentSkill, SkillSummary } from "@poseidon/contracts/connectors";
import * as Effect from "effect/Effect";
import type * as Semaphore from "effect/Semaphore";

import { claudeConfigDir } from "./plugins";

const isDirectory = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => stat(path)).pipe(
    Effect.map((info) => info.isDirectory()),
    Effect.orElseSucceed(() => false),
  );

/** A skill as found on disk, with the root entry it was found under. */
interface SkillEntry {
  readonly entry: string;
  readonly skill: SkillSummary;
}

/** One root's skills, in entry order; a missing or unreadable root has none. */
const readRoot = (root: string): Effect.Effect<ReadonlyArray<SkillEntry>> =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise(() => readdir(root)).pipe(
      Effect.orElseSucceed((): Array<string> => []),
    );
    const out: Array<SkillEntry> = [];
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
      out.push({
        entry,
        skill: {
          name:
            frontmatter.name !== undefined && frontmatter.name !== "" ? frontmatter.name : entry,
          path,
          ...(frontmatter.description === undefined
            ? {}
            : { description: frontmatter.description }),
          enabled: true,
        },
      });
    }
    return out;
  });

export interface ClaudeSkillsOptions {
  /** The environment the instance's sessions run with (`childEnv`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The shared agents skills folder — `~/.agents/skills` in production. */
  readonly agentsSkillsRoot: string;
  /** Serialises links, so two into one config never race. */
  readonly writeMutex: Semaphore.Semaphore;
}

/** The skill roots a scope reaches, the project's first. */
const skillRoots = (
  options: Pick<ClaudeSkillsOptions, "env">,
  scope: ExtensionScope,
): ReadonlyArray<string> => [
  ...(scope.workspaceRoot === null
    ? []
    : [NodePath.join(scope.workspaceRoot, ".claude", "skills")]),
  NodePath.join(claudeConfigDir(options.env), "skills"),
];

export const makeClaudeSkills = (options: ClaudeSkillsOptions): SkillsExtension => {
  const userSkillsRoot = NodePath.join(claudeConfigDir(options.env), "skills");
  const { agentsSkillsRoot } = options;

  const list = (scope: ExtensionScope) =>
    Effect.gen(function* () {
      // One row per name: the first root that has it — the project's before
      // the user's — is the one listed.
      const seen = new Set<string>();
      const out: Array<SkillSummary> = [];
      for (const root of skillRoots(options, scope)) {
        for (const { skill } of yield* readRoot(root)) {
          if (seen.has(skill.name)) continue;
          seen.add(skill.name);
          out.push(skill);
        }
      }
      return out;
    });

  /**
   * Agents-folder skills the CLI does not load yet. One is loaded when the
   * user root holds its entry (the usual symlink) or a skill of the same
   * name, which would shadow it anyway. An entry there that is not a skill
   * still takes the name, and a link whose target is gone does not.
   */
  const available = Effect.gen(function* () {
    const taken = yield* Effect.promise(() => occupiedSkillEntries(userSkillsRoot));
    const loadedNames = new Set((yield* readRoot(userSkillsRoot)).map((found) => found.skill.name));
    const out: Array<AgentSkill> = [];
    for (const { entry, skill } of yield* readRoot(agentsSkillsRoot)) {
      if (taken.has(entry) || loadedNames.has(skill.name)) continue;
      out.push({
        entry,
        name: skill.name,
        path: skill.path,
        ...(skill.description === undefined ? {} : { description: skill.description }),
      });
    }
    return out;
  });

  const link = (entry: string) =>
    options.writeMutex.withPermits(1)(
      Effect.gen(function* () {
        const candidates = yield* available;
        // Only a listed entry is linkable, which also keeps `entry` a bare
        // name — no separators, no `..` — before it reaches the filesystem.
        if (!candidates.some((skill) => skill.entry === entry)) {
          return yield* new ConnectorExtensionFailed({
            code: "not-found",
            message: `no unlinked skill "${entry}" in ${agentsSkillsRoot}; it may already be linked`,
          });
        }
        const linkPath = NodePath.join(userSkillsRoot, entry);
        yield* Effect.tryPromise({
          try: () => linkSkill(userSkillsRoot, agentsSkillsRoot, entry),
          catch: (error) =>
            new ConnectorExtensionFailed({
              code: "internal",
              message: `could not link ${linkPath}: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });
        return yield* available;
      }),
    );

  return { list, available, link };
};
