/**
 * Reads one plugin directory into what the registry lists and what a session
 * loads.
 *
 * The layout is Claude Code's, so an existing Claude Code plugin works
 * unchanged:
 *
 * - `.claude-plugin/plugin.json` is optional. When present it must be JSON
 *   with a kebab-case `name`; when absent the directory's name is used.
 * - `skills/<name>/SKILL.md` are the skills, named and described by their
 *   frontmatter. A manifest `skills` entry (a path or a list of paths) adds to
 *   that folder, as Claude Code does.
 * - `commands/*.md` and `agents/*.md` are counted, and `hooks/hooks.json`
 *   noted; a manifest `commands` or `agents` entry replaces its folder.
 * - MCP servers come from `.mcp.json` and the manifest's `mcpServers` (an
 *   inline map, or a path or list of paths to such a file).
 *
 * Every path a manifest names must stay inside the plugin's directory.
 * Nothing here throws: a failure becomes the listed plugin's `error`, and a
 * problem that does not stop the plugin loading becomes one of its warnings.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import * as NodePath from "node:path";

import type { SessionMcpServer, SessionPlugin } from "@poseidon/connector-sdk/plugins";
import type { PluginSkill, PluginSource, PoseidonPlugin } from "@poseidon/contracts/plugins";

import { parseSkillFrontmatter } from "./frontmatter";
import { readMcpServers } from "./mcpConfig";

/** What one plugin directory is: its listing, and what a session loads when it is valid. */
export interface LoadedPlugin {
  /** `enabled` is the plugin's default: on unless it failed validation. */
  readonly plugin: PoseidonPlugin;
  /** Null when the plugin failed validation. */
  readonly session: SessionPlugin | null;
}

const MANIFEST_PATH = NodePath.join(".claude-plugin", "plugin.json");

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Deeper than any real plugin nests its commands or agents. */
const MAX_DEPTH = 4;

/** Stops the read with the plugin's error; caught in `readPlugin`. */
class PluginInvalid {
  constructor(readonly message: string) {}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const statSafe = (path: string) => stat(path).catch(() => null);

const isFile = async (path: string) => (await statSafe(path))?.isFile() ?? false;

const isDirectory = async (path: string) => (await statSafe(path))?.isDirectory() ?? false;

/** Entries of a directory, sorted, without dotfiles; none when it cannot be read. */
const listDir = async (path: string): Promise<ReadonlyArray<string>> =>
  (await readdir(path).catch(() => [] as Array<string>))
    .filter((entry) => !entry.startsWith("."))
    .sort();

/** Resolves a manifest path against the root, refusing one that leaves it. */
const inside = (root: string, relative: string): string => {
  const resolved = NodePath.resolve(root, relative);
  const fromRoot = NodePath.relative(root, resolved);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(fromRoot)
  ) {
    throw new PluginInvalid(`path "${relative}" leaves the plugin folder`);
  }
  return resolved;
};

/** A manifest entry that is a path or a list of paths. */
const pathList = (
  manifest: Record<string, unknown> | null,
  key: string,
): ReadonlyArray<string> | undefined => {
  const value = manifest?.[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value as ReadonlyArray<string>;
  }
  throw new PluginInvalid(`invalid plugin.json: ${key} must be a path or a list of paths`);
};

/** `.md` files at `path` (a file or a folder, searched a few levels deep). */
const countMarkdown = async (path: string, depth = 0): Promise<number> => {
  const info = await statSafe(path);
  if (info === null) {
    return 0;
  }
  if (info.isFile()) {
    return path.endsWith(".md") ? 1 : 0;
  }
  if (!info.isDirectory() || depth > MAX_DEPTH) {
    return 0;
  }
  let count = 0;
  for (const entry of await listDir(path)) {
    count += await countMarkdown(NodePath.join(path, entry), depth + 1);
  }
  return count;
};

const readJson = async (path: string, label: string): Promise<unknown> => {
  const text = await readFile(path, "utf8").catch((cause: unknown) => {
    throw new PluginInvalid(`invalid ${label}: ${messageOf(cause)}`);
  });
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new PluginInvalid(`invalid ${label}: ${messageOf(cause)}`);
  }
};

/** The manifest, or null when the plugin has none. */
const readManifest = async (root: string): Promise<Record<string, unknown> | null> => {
  const path = NodePath.join(root, MANIFEST_PATH);
  if (!(await isFile(path))) {
    return null;
  }
  const manifest = await readJson(path, "plugin.json");
  if (!isRecord(manifest)) {
    throw new PluginInvalid("invalid plugin.json: it must be a JSON object");
  }
  if (typeof manifest.name !== "string" || manifest.name === "") {
    throw new PluginInvalid("invalid plugin.json: name is required");
  }
  if (!KEBAB_CASE.test(manifest.name)) {
    throw new PluginInvalid(`invalid plugin.json: name "${manifest.name}" must be kebab-case`);
  }
  for (const key of ["description", "version"] as const) {
    if (manifest[key] !== undefined && typeof manifest[key] !== "string") {
      throw new PluginInvalid(`invalid plugin.json: ${key} must be a string`);
    }
  }
  return manifest;
};

interface SkillsRead {
  readonly skills: Array<SessionPlugin["skills"][number]>;
  readonly skillsDirs: Array<string>;
  readonly warnings: Array<string>;
}

/** One `<dir>/SKILL.md`, named by its folder. */
const readSkill = async (dir: string, into: SkillsRead) => {
  const folder = NodePath.basename(dir);
  const content = await readFile(NodePath.join(dir, "SKILL.md"), "utf8").catch(() => null);
  if (content === null) {
    into.warnings.push(`skill "${folder}" could not be read`);
    return;
  }
  if (into.skills.some((skill) => skill.name === folder)) {
    into.warnings.push(`skill "${folder}" is defined twice; the first one is used`);
    return;
  }
  const frontmatter = parseSkillFrontmatter(content);
  if (frontmatter.name !== undefined && frontmatter.name !== folder) {
    into.warnings.push(`skill "${folder}" is named "${frontmatter.name}" in its SKILL.md`);
  }
  if (frontmatter.description === undefined) {
    into.warnings.push(`skill "${folder}" has no description`);
  }
  into.skills.push({
    name: folder,
    path: dir,
    ...(frontmatter.description === undefined ? {} : { description: frontmatter.description }),
  });
};

/**
 * A skill folder itself, or a folder of skill folders. Either one is a
 * skills directory: a harness that takes directories (Command Code's
 * `--skill`) accepts a single skill folder as readily as a folder of them.
 */
const scanSkills = async (path: string, into: SkillsRead) => {
  if (await isFile(NodePath.join(path, "SKILL.md"))) {
    const before = into.skills.length;
    await readSkill(path, into);
    if (into.skills.length > before && !into.skillsDirs.includes(path)) {
      into.skillsDirs.push(path);
    }
    return;
  }
  let found = false;
  for (const entry of await listDir(path)) {
    const dir = NodePath.join(path, entry);
    if (await isFile(NodePath.join(dir, "SKILL.md"))) {
      found = true;
      await readSkill(dir, into);
    }
  }
  if (found && !into.skillsDirs.includes(path)) {
    into.skillsDirs.push(path);
  }
};

interface McpRead {
  readonly servers: Array<SessionMcpServer>;
  readonly warnings: Array<string>;
  file: boolean;
}

const addMcpConfig = (config: unknown, root: string, origin: string, into: McpRead) => {
  const read = readMcpServers(config, root, origin);
  if ("error" in read) {
    throw new PluginInvalid(`invalid ${origin}: ${read.error}`);
  }
  into.warnings.push(...read.warnings);
  for (const server of read.servers) {
    if (into.servers.some((known) => known.name === server.name)) {
      into.warnings.push(`MCP server "${server.name}" is defined twice; the first one is used`);
    } else {
      into.servers.push(server);
    }
  }
};

const readMcp = async (
  root: string,
  manifest: Record<string, unknown> | null,
): Promise<McpRead> => {
  const into: McpRead = { servers: [], warnings: [], file: false };
  const defaultFile = NodePath.join(root, ".mcp.json");
  if (await isFile(defaultFile)) {
    into.file = true;
    addMcpConfig(await readJson(defaultFile, ".mcp.json"), root, ".mcp.json", into);
  }
  const declared = manifest?.mcpServers;
  if (declared === undefined) {
    return into;
  }
  if (isRecord(declared)) {
    addMcpConfig(declared, root, "plugin.json mcpServers", into);
    return into;
  }
  for (const relative of pathList(manifest, "mcpServers") ?? []) {
    const path = inside(root, relative);
    if (path === defaultFile) {
      continue;
    }
    into.file = true;
    addMcpConfig(await readJson(path, relative), root, relative, into);
  }
  return into;
};

/** Markdown files under the default folder, or under the manifest's paths instead. */
const countComponent = async (
  root: string,
  manifest: Record<string, unknown> | null,
  key: "commands" | "agents",
): Promise<number> => {
  const paths = pathList(manifest, key)?.map((relative) => inside(root, relative)) ?? [
    NodePath.join(root, key),
  ];
  let count = 0;
  for (const path of paths) {
    count += await countMarkdown(path);
  }
  return count;
};

const hasHooks = async (root: string, manifest: Record<string, unknown> | null) => {
  const declared = manifest?.hooks;
  if (typeof declared === "string") {
    inside(root, declared);
  }
  return declared !== undefined || (await isFile(NodePath.join(root, "hooks", "hooks.json")));
};

const readValid = async (
  root: string,
  base: Pick<PoseidonPlugin, "pluginId" | "source" | "path">,
): Promise<LoadedPlugin> => {
  const manifest = await readManifest(root);
  const skillsRead: SkillsRead = { skills: [], skillsDirs: [], warnings: [] };
  const skillPaths = new Set([
    NodePath.join(root, "skills"),
    ...(pathList(manifest, "skills") ?? []).map((relative) => inside(root, relative)),
  ]);
  for (const path of skillPaths) {
    if (await isDirectory(path)) {
      await scanSkills(path, skillsRead);
    }
  }
  const commands = await countComponent(root, manifest, "commands");
  const agents = await countComponent(root, manifest, "agents");
  const hooks = await hasHooks(root, manifest);
  const mcp = await readMcp(root, manifest);

  const empty =
    skillsRead.skills.length === 0 && commands === 0 && agents === 0 && !hooks && !mcp.file;
  if (manifest === null && empty) {
    throw new PluginInvalid("not a plugin");
  }

  const name = typeof manifest?.name === "string" ? manifest.name : NodePath.basename(root);
  const description =
    typeof manifest?.description === "string" && manifest.description.trim() !== ""
      ? manifest.description
      : undefined;
  const version = typeof manifest?.version === "string" ? manifest.version : undefined;
  const warnings = [...skillsRead.warnings, ...mcp.warnings];
  const skills: ReadonlyArray<PluginSkill> = skillsRead.skills.map((skill) => ({
    name: skill.name,
    ...(skill.description === undefined ? {} : { description: skill.description }),
  }));

  return {
    plugin: {
      ...base,
      name,
      ...(description === undefined ? {} : { description }),
      ...(version === undefined ? {} : { version }),
      enabled: true,
      contents: {
        skills,
        mcpServers: mcp.servers.map((server) => server.name),
        commands,
        agents,
        hooks,
      },
      ...(warnings.length === 0 ? {} : { warnings }),
    },
    session: {
      name,
      root,
      builtin: base.source === "builtin",
      skills: skillsRead.skills,
      skillsDirs: skillsRead.skillsDirs,
      mcpServers: mcp.servers,
    },
  };
};

/**
 * Reads the plugin in `dir`. Its id is `<source>:<directory name>`, so a
 * plugin whose manifest cannot be read still has one to list its error under.
 */
export const readPlugin = async (dir: string, source: PluginSource): Promise<LoadedPlugin> => {
  const root = NodePath.resolve(dir);
  const folder = NodePath.basename(root);
  const base = { pluginId: `${source}:${folder}`, source, path: root } as const;
  try {
    return await readValid(root, base);
  } catch (cause) {
    const error =
      cause instanceof PluginInvalid ? cause.message : `could not read plugin: ${messageOf(cause)}`;
    return {
      plugin: {
        ...base,
        name: folder,
        enabled: false,
        contents: { skills: [], mcpServers: [], commands: 0, agents: 0, hooks: false },
        error,
      },
      session: null,
    };
  }
};
