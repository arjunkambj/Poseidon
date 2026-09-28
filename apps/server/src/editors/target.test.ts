/**
 * `resolveTarget` over real directories in tmp: the root and anything under
 * it resolve, `..`, absolute paths elsewhere and symlinks out never do.
 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";

import { resolveTarget } from "./target";

const tempDir = (prefix: string) => realpathSync(mkdtempSync(nodePath.join(tmpdir(), prefix)));

const makeWorkspace = () => {
  const root = tempDir("poseidon-editor-root-");
  const outside = tempDir("poseidon-editor-outside-");
  writeFileSync(nodePath.join(outside, "secret.txt"), "not yours\n");
  mkdirSync(nodePath.join(root, "src", "lib"), { recursive: true });
  writeFileSync(nodePath.join(root, "src", "lib", "a.ts"), "export const a = 1\n");
  symlinkSync("src/lib/a.ts", nodePath.join(root, "alias.ts"));
  symlinkSync(nodePath.join(outside, "secret.txt"), nodePath.join(root, "leak.txt"));
  symlinkSync(outside, nodePath.join(root, "linked"));
  return { root, outside };
};

describe("resolveTarget", () => {
  it("resolves the root itself when no path, or an empty one, is given", async () => {
    const { root } = makeWorkspace();
    const expected = { ok: true, path: root, isDirectory: true };
    expect(await resolveTarget(root)).toEqual(expected);
    expect(await resolveTarget(root, "")).toEqual(expected);
    expect(await resolveTarget(root, ".")).toEqual(expected);
  });

  it("resolves a nested file and folder to absolute paths", async () => {
    const { root } = makeWorkspace();
    expect(await resolveTarget(root, "src/lib/a.ts")).toEqual({
      ok: true,
      path: nodePath.join(root, "src", "lib", "a.ts"),
      isDirectory: false,
    });
    expect(await resolveTarget(root, "src/lib")).toEqual({
      ok: true,
      path: nodePath.join(root, "src", "lib"),
      isDirectory: true,
    });
    expect(await resolveTarget(root, nodePath.join(root, "src"))).toMatchObject({ ok: true });
  });

  it("follows a symlink that stays inside the root", async () => {
    const { root } = makeWorkspace();
    expect(await resolveTarget(root, "alias.ts")).toEqual({
      ok: true,
      path: nodePath.join(root, "src", "lib", "a.ts"),
      isDirectory: false,
    });
  });

  it("refuses .., an absolute path outside, and symlinks out", async () => {
    const { root, outside } = makeWorkspace();
    const invalid = { ok: false, reason: "invalid" };
    expect(await resolveTarget(root, "../x")).toEqual(invalid);
    expect(await resolveTarget(root, "src/../../x")).toEqual(invalid);
    expect(await resolveTarget(root, "..")).toEqual(invalid);
    expect(await resolveTarget(root, nodePath.join(outside, "secret.txt"))).toEqual(invalid);
    expect(await resolveTarget(root, "/etc")).toEqual(invalid);
    expect(await resolveTarget(root, "leak.txt")).toEqual(invalid);
    expect(await resolveTarget(root, "linked")).toEqual(invalid);
    expect(await resolveTarget(root, "linked/secret.txt")).toEqual(invalid);
    expect(await resolveTarget(root, "src\0/a.ts")).toEqual(invalid);
  });

  it("answers not-found for a missing path or a missing root", async () => {
    const { root } = makeWorkspace();
    const notFound = { ok: false, reason: "not-found" };
    expect(await resolveTarget(root, "src/nope.ts")).toEqual(notFound);
    expect(await resolveTarget(root, "src/lib/a.ts/deeper")).toEqual(notFound);
    expect(await resolveTarget(nodePath.join(root, "gone"))).toEqual(notFound);
  });
});
