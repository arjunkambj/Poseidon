/**
 * Command Code's skills, found for the Customize page and the composer's `/`
 * menu: the user root `<home>/skills` and the project root
 * `<workspaceRoot>/.commandcode/skills`. This is the `skills` extension.
 *
 * Skills are discovered, never written — with one exception: a skill in the
 * shared agents folder (`~/.agents/skills`) can be linked into the user root
 * as a relative symlink, the same shape the skills installer writes. Nothing
 * is copied, so the agents folder stays the source.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import * as NodePath from "node:path";
import { ConnectorExtensionFailed } from "@poseidon/connector-sdk/extensions";
import type { ExtensionScope, SkillsExtension } from "@poseidon/connector-sdk/extensions";
import { linkSkill, occupiedSkillEntries } from "@poseidon/connector-sdk/skills";
import type { AgentSkill, SkillSummary } from "@poseidon/contracts/connectors";
import * as Effect from "effect/Effect";
import type * as Semaphore from "effect/Semaphore";

/**
 * Minimal `---` frontmatter: `name` and `description` only, like the skills
 * dirs use. A value may be a YAML block scalar (`>`, `|`, with `-`/`+`), whose
 * indented lines follow the key — long descriptions are written that way.
 */
const parseFrontmatter = (content: string): { name?: string; description?: string } => {
  if (!content.startsWith("---")) {
    return {};
  }
  const end = content.indexOf("\n---", 3);
  if (end < 0) {
    return {};
  }
  const out: { name?: string; description?: string } = {};
  const lines = content.slice(3, end).split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]!.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (match === null) {
      continue;
    }
    let value = match[2]!.trim();
    const block = value.match(/^([>|])[-+]?$/);
    if (block !== null) {
      const body: Array<string> = [];
      while (index + 1 < lines.length && /^(\s|$)/.test(lines[index + 1]!)) {
        index++;
        body.push(lines[index]!.trim());
      }
      value = body.join(block[1] === ">" ? " " : "\n").trim();
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (match[1]!.toLowerCase() === "name") {
      out.name = value;
    } else if (match[1]!.toLowerCase() === "description") {
      out.description = value;
    }
  }
  return out;
};

const fileStem = (path: string): string => {
  const base = NodePath.basename(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};

const readSafe = (path: string): Effect.Effect<string | null> =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(Effect.orElseSucceed(() => null));

const listDirSafe = (path: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.tryPromise(() => readdir(path)).pipe(Effect.orElseSucceed(() => []));

const statSafe = (path: string) =>
  Effect.tryPromise(() => stat(path)).pipe(Effect.orElseSucceed(() => null));

const isDirSafe = (path: string): Effect.Effect<boolean> =>
  Effect.map(statSafe(path), (info) => info?.isDirectory() ?? false);

const existsSafe = (path: string): Effect.Effect<boolean> =>
  Effect.map(statSafe(path), (info) => info !== null);

/** A skill as found on disk, with the root entry it was found under. */
interface SkillEntry {
  readonly entry: string;
  readonly skill: SkillSummary;
}

/**
 * One skills root, walked tolerantly. Both `<root>/<name>/SKILL.md` and
 * `<root>/<name>.md` appear in the wild; either is a skill.
 */
const readSkillEntries = (root: string): Effect.Effect<ReadonlyArray<SkillEntry>> =>
  Effect.gen(function* () {
    const entries = yield* listDirSafe(root);
    const out: Array<SkillEntry> = [];
    for (const entry of entries) {
      if (entry.startsWith(".")) {
        continue;
      }
      const absolute = NodePath.join(root, entry);
      let filePath: string | null = null;
      let name = fileStem(entry);
      if (yield* isDirSafe(absolute)) {
        name = entry;
        for (const candidate of ["SKILL.md", "skill.md", `${entry}.md`]) {
          const file = NodePath.join(absolute, candidate);
          if (yield* existsSafe(file)) {
            filePath = file;
            break;
          }
        }
      } else if (entry.endsWith(".md")) {
        filePath = absolute;
      }
      if (filePath === null) {
        continue;
      }
      const content = yield* readSafe(filePath);
      if (content === null) {
        continue;
      }
      const frontmatter = parseFrontmatter(content);
      out.push({
        entry,
        skill: {
          name: frontmatter.name ?? name,
          path: filePath,
          ...(frontmatter.description === undefined
            ? {}
            : { description: frontmatter.description }),
          enabled: true,
        },
      });
    }
    return out;
  });

export interface CmdSkillsOptions {
  /** Command Code's home directory — `~/.commandcode` in production. */
  readonly home: string;
  /** The shared agents skills folder — `~/.agents/skills` in production. */
  readonly agentsSkillsRoot: string;
  /** Serialises links with the other writers of the same home. */
  readonly writeMutex: Semaphore.Semaphore;
}

export const makeCmdSkills = (options: CmdSkillsOptions): SkillsExtension => {
  const userSkillsRoot = NodePath.join(options.home, "skills");
  const { agentsSkillsRoot } = options;

  const list = (scope: ExtensionScope) =>
    Effect.gen(function* () {
      const roots: Array<string> = [];
      if (scope.workspaceRoot !== null) {
        roots.push(NodePath.join(scope.workspaceRoot, ".commandcode", "skills"));
      }
      roots.push(userSkillsRoot);
      // Project skills win name collisions, matching harness precedence.
      const seen = new Set<string>();
      const out: Array<SkillSummary> = [];
      for (const skillsRoot of roots) {
        for (const { skill } of yield* readSkillEntries(skillsRoot)) {
          if (seen.has(skill.name)) {
            continue;
          }
          seen.add(skill.name);
          out.push(skill);
        }
      }
      return out;
    });

  /**
   * Agents-folder skills the connector does not load yet. One is loaded
   * when the user root holds its entry (the usual symlink) or a skill of
   * the same name, which would shadow it anyway. An entry there that is not
   * a skill still takes the name, and a link whose target is gone does not.
   */
  const available = Effect.gen(function* () {
    const taken = yield* Effect.promise(() => occupiedSkillEntries(userSkillsRoot));
    const loadedNames = new Set(
      (yield* readSkillEntries(userSkillsRoot)).map((found) => found.skill.name),
    );
    const out: Array<AgentSkill> = [];
    for (const { entry, skill } of yield* readSkillEntries(agentsSkillsRoot)) {
      if (taken.has(entry) || loadedNames.has(skill.name)) {
        continue;
      }
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
