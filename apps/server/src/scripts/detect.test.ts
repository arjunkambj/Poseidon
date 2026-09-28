/**
 * The pure half of script detection over described workspaces: the
 * pnpm-workspace.yaml line parser, package.json `workspaces`, pattern
 * expansion against a listing held in memory, the package manager, the
 * command quoting and the caps.
 */
import { describe, expect, it } from "vitest";

import {
  detectedScripts,
  expandPatterns,
  MAX_PACKAGES,
  MAX_SCRIPTS,
  packageManagerOf,
  scriptRunCommand,
  workspacePatterns,
} from "./detect";

describe("workspacePatterns", () => {
  it("reads the packages list of a pnpm-workspace.yaml with quotes, comments and negation", () => {
    const yaml = [
      "# the workspace",
      "packages:",
      "  - 'apps/*'   # the apps",
      '  - "packages/**"',
      "  - tools/cli",
      "  # - disabled/*",
      "  - '!**/test/**'",
      "",
      "catalog:",
      "  effect: ^4.0.0",
      "  - not-a-package",
    ].join("\n");
    expect(workspacePatterns(yaml, null)).toEqual([
      "apps/*",
      "packages/**",
      "tools/cli",
      "!**/test/**",
    ]);
  });

  it("reads a flow list and keeps a # inside quotes", () => {
    expect(workspacePatterns("packages: ['apps/*', \"odd#dir\"] # tail\n", null)).toEqual([
      "apps/*",
      "odd#dir",
    ]);
  });

  it("reads package.json workspaces in both forms and merges them once", () => {
    expect(workspacePatterns(null, { workspaces: ["apps/*", "packages/*"] })).toEqual([
      "apps/*",
      "packages/*",
    ]);
    expect(workspacePatterns(null, { workspaces: { packages: ["libs/*", 3] } })).toEqual([
      "libs/*",
    ]);
    expect(workspacePatterns("packages:\n  - apps/*\n", { workspaces: ["apps/*", "x"] })).toEqual([
      "apps/*",
      "x",
    ]);
    expect(workspacePatterns(null, { workspaces: "apps/*" })).toEqual([]);
    expect(workspacePatterns(null, "not an object")).toEqual([]);
  });
});

describe("expandPatterns", () => {
  const tree: Record<string, ReadonlyArray<string>> = {
    "": ["apps", "packages", "node_modules", ".git"],
    apps: ["web", "desktop", "test", ".cache", "node_modules"],
    packages: ["ui", "contracts"],
  };
  const listDir = async (dir: string) => tree[dir] ?? [];

  it("expands * and ** one level, keeps literals and applies negations", async () => {
    expect(
      await expandPatterns(["apps/*", "packages/**", "tools/cli", "!apps/test"], listDir),
    ).toEqual(["apps/desktop", "apps/web", "packages/contracts", "packages/ui", "tools/cli"]);
  });

  it("matches a wildcard inside a segment and a ** negation across segments", async () => {
    expect(await expandPatterns(["./packages/c*", "apps/*", "!**/web"], listDir)).toEqual([
      "apps/desktop",
      "apps/test",
      "packages/contracts",
    ]);
  });

  it("skips node_modules, dot dirs, the root and patterns that climb out", async () => {
    expect(await expandPatterns(["*", ".", "../elsewhere/*", "node_modules"], listDir)).toEqual([
      "apps",
      "packages",
    ]);
  });
});

describe("packageManagerOf", () => {
  it("prefers the packageManager field, then the lockfile, then npm", () => {
    expect(packageManagerOf("pnpm@10.1.0", new Set(["yarn.lock"]))).toBe("pnpm");
    expect(packageManagerOf("yarn@4.0.0+sha256.abc", new Set())).toBe("yarn");
    expect(packageManagerOf("deno@2", new Set(["bun.lockb"]))).toBe("bun");
    expect(packageManagerOf(undefined, new Set(["pnpm-lock.yaml"]))).toBe("pnpm");
    expect(packageManagerOf(undefined, new Set(["yarn.lock"]))).toBe("yarn");
    expect(packageManagerOf(undefined, new Set(["bun.lock"]))).toBe("bun");
    expect(packageManagerOf(42, new Set())).toBe("npm");
  });
});

describe("scriptRunCommand", () => {
  it("runs a root script plainly and cds into a nested package, POSIX-quoted", () => {
    expect(scriptRunCommand("pnpm", "", "dev")).toBe("pnpm run dev");
    expect(scriptRunCommand("npm", "", "build:web")).toBe("npm run build:web");
    expect(scriptRunCommand("yarn", "apps/web", "dev")).toBe("cd 'apps/web' && yarn run dev");
    expect(scriptRunCommand("bun", "it's here", "a b")).toBe("cd 'it'\\''s here' && bun run 'a b'");
    expect(scriptRunCommand("pnpm", "", "x;rm -rf /")).toBe("pnpm run 'x;rm -rf /'");
  });
});

describe("detectedScripts", () => {
  it("lists the root first, then by dir, skipping malformed entries", () => {
    const scripts = detectedScripts("pnpm", [
      { dir: "packages/ui", packageJson: { name: "@acme/ui", scripts: { build: "tsc" } } },
      { dir: "apps/web", packageJson: { scripts: { dev: "vite", bad: 3, empty: " " } } },
      { dir: "broken", packageJson: "not json" },
      { dir: "", packageJson: { name: "acme", scripts: { dev: "turbo dev" } } },
      { dir: "apps/desktop", packageJson: { name: "", scripts: ["dev"] } },
    ]);
    expect(scripts).toEqual([
      {
        id: "pkg::dev",
        name: "dev",
        packageName: "acme",
        packageDir: "",
        command: "pnpm run dev",
        packageManager: "pnpm",
      },
      {
        id: "pkg:apps/web:dev",
        name: "dev",
        packageName: null,
        packageDir: "apps/web",
        command: "cd 'apps/web' && pnpm run dev",
        packageManager: "pnpm",
      },
      {
        id: "pkg:packages/ui:build",
        name: "build",
        packageName: "@acme/ui",
        packageDir: "packages/ui",
        command: "cd 'packages/ui' && pnpm run build",
        packageManager: "pnpm",
      },
    ]);
  });

  it("caps the packages and the scripts", () => {
    const many = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`s${i}`, "echo"]));
    const packages = Array.from({ length: MAX_PACKAGES + 10 }, (_, i) => ({
      dir: `p/${String(i).padStart(3, "0")}`,
      packageJson: { scripts: many(1) },
    }));
    const byPackage = detectedScripts("npm", packages);
    expect(byPackage).toHaveLength(MAX_PACKAGES);
    expect(byPackage.at(-1)?.packageDir).toBe(`p/${String(MAX_PACKAGES - 1).padStart(3, "0")}`);
    const byScript = detectedScripts("npm", [
      { dir: "", packageJson: { scripts: many(MAX_SCRIPTS + 50) } },
    ]);
    expect(byScript).toHaveLength(MAX_SCRIPTS);
  });
});
