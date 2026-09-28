import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";

import {
  binDir,
  builtinPluginsDir,
  configDir,
  configPath,
  databasePath,
  devConnectionPath,
  pluginsDir,
  worktreesDir,
} from "./paths";

describe("configDir", () => {
  it("defaults to ~/.poseidon", () => {
    expect(configDir({})).toBe(NodePath.join(NodeOS.homedir(), ".poseidon"));
  });

  it("honours POSEIDON_HOME and resolves it to an absolute path", () => {
    const home = NodePath.join(NodeOS.tmpdir(), "poseidon-test-home");
    expect(configDir({ POSEIDON_HOME: home })).toBe(home);
    expect(NodePath.isAbsolute(configDir({ POSEIDON_HOME: "relative/home" }))).toBe(true);
  });

  it("ignores a blank override", () => {
    expect(configDir({ POSEIDON_HOME: "   " })).toBe(configDir({}));
  });
});

describe("well-known paths", () => {
  const env = { POSEIDON_HOME: NodePath.join(NodeOS.tmpdir(), "poseidon-test-home") };

  it("hang off the configuration directory", () => {
    expect(configPath(["a", "b"], env)).toBe(NodePath.join(configDir(env), "a", "b"));
    expect(databasePath(env)).toBe(NodePath.join(configDir(env), "state.sqlite"));
    expect(binDir(env)).toBe(NodePath.join(configDir(env), "bin"));
    expect(worktreesDir(env)).toBe(NodePath.join(configDir(env), "worktrees"));
    expect(devConnectionPath(env)).toBe(NodePath.join(configDir(env), "dev", "connection.json"));
    expect(pluginsDir(env)).toBe(NodePath.join(configDir(env), "plugins"));
    expect(builtinPluginsDir(env)).toBe(NodePath.join(configDir(env), "builtin-plugins"));
  });
});
