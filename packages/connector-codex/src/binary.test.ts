import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";

import { resolveBinary, terminalCommand } from "./binary";

const dirWith = (files: Readonly<Record<string, number>>): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-bin-"));
  for (const [name, mode] of Object.entries(files)) {
    const file = NodePath.join(dir, name);
    NodeFS.writeFileSync(file, "#!/bin/sh\n", "utf8");
    NodeFS.chmodSync(file, mode);
  }
  return dir;
};

describe("resolveBinary", () => {
  it("takes a configured path as given", () => {
    expect(resolveBinary({ binaryPath: "/opt/custom/codex" }, { PATH: "" }, [])).toEqual({
      command: "/opt/custom/codex",
      display: "/opt/custom/codex",
    });
  });

  it("finds codex on PATH before the extra directories", () => {
    const onPath = dirWith({ codex: 0o755 });
    const extra = dirWith({ codex: 0o755 });
    expect(resolveBinary({}, { PATH: onPath }, [extra])?.command).toBe(
      NodePath.join(onPath, "codex"),
    );
  });

  it("falls back to the install directories a GUI process never inherits", () => {
    const extra = dirWith({ codex: 0o755 });
    expect(resolveBinary({}, { PATH: "/nonexistent" }, [extra])?.command).toBe(
      NodePath.join(extra, "codex"),
    );
  });

  it("skips a file that is not executable, and a directory", () => {
    const plain = dirWith({ codex: 0o644 });
    const holder = dirWith({});
    NodeFS.mkdirSync(NodePath.join(holder, "codex"));
    expect(resolveBinary({}, { PATH: `${plain}:${holder}` }, [])).toBeNull();
  });

  it("is null when nothing is found, with no runner to fall back on", () => {
    expect(resolveBinary({ binaryPath: "" }, { PATH: "" }, [])).toBeNull();
  });
});

describe("terminalCommand", () => {
  const binary = { command: "/opt/homebrew/bin/codex", display: "/opt/homebrew/bin/codex" };

  it("spells the call against the binary that was found", () => {
    expect(terminalCommand(binary, ["login"])).toBe("/opt/homebrew/bin/codex login");
  });

  it("quotes a path that needs it", () => {
    expect(terminalCommand({ command: "/Users/me/My Tools/codex", display: "" }, ["login"])).toBe(
      "'/Users/me/My Tools/codex' login",
    );
  });

  it("names the instance's own account directory first", () => {
    expect(terminalCommand(binary, ["login"], "/Users/me/.codex-work")).toBe(
      "CODEX_HOME=/Users/me/.codex-work /opt/homebrew/bin/codex login",
    );
  });
});
