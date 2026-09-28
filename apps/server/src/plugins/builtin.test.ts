/**
 * The built-in plugins as the server writes them at boot: written once, left
 * alone on a restart, repaired when a file drifts, and valid by the same rules
 * as any global plugin.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BROWSER_TOOLS } from "../browser/tools";
import { BROWSER_PLUGIN_FILES } from "./builtin/browser";
import { materializeBuiltins } from "./builtin/materialize";
import { readPlugin } from "./manifest";

describe("materializeBuiltins", () => {
  it("writes the Browser plugin once and leaves it alone afterwards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poseidon-builtins-"));

    const first = await materializeBuiltins(dir);
    expect(first.toSorted()).toEqual([
      join(dir, "browser", ".claude-plugin", "plugin.json"),
      join(dir, "browser", "skills", "browser", "SKILL.md"),
    ]);
    expect(await materializeBuiltins(dir)).toEqual([]);

    // A file that drifted is put back, and only that one.
    const skillPath = join(dir, "browser", "skills", "browser", "SKILL.md");
    writeFileSync(skillPath, "edited");
    expect(await materializeBuiltins(dir)).toEqual([skillPath]);
    expect(readFileSync(skillPath, "utf8")).toBe(BROWSER_PLUGIN_FILES["skills/browser/SKILL.md"]);
  });

  it("writes a Browser plugin the registry reads as valid, with its skill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poseidon-builtins-"));
    await materializeBuiltins(dir);

    const { plugin, session } = await readPlugin(join(dir, "browser"), "builtin");

    expect(plugin.error).toBeUndefined();
    expect(plugin.warnings).toBeUndefined();
    expect(plugin.pluginId).toBe("builtin:browser");
    expect(plugin.name).toBe("browser");
    expect(plugin.description).toMatch(/in-app browser/);
    expect(plugin.contents.skills.map((skill) => skill.name)).toEqual(["browser"]);
    expect(plugin.contents.mcpServers).toEqual([]);
    expect(session?.skillsDirs).toEqual([join(dir, "browser", "skills")]);
  });

  it("names every browser tool the gateway serves in the skill", () => {
    const skill = BROWSER_PLUGIN_FILES["skills/browser/SKILL.md"]!;
    for (const tool of BROWSER_TOOLS) {
      expect(skill).toContain(`\`${tool.name}\``);
    }
    expect(skill).toContain("interrupted_by_human");
  });
});
