import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { childEnv, expandHome } from "./env";
import { makeProcessGroup } from "./spawn";

/**
 * What Poseidon inherits when it is started from inside another agent's
 * session — a Codex one and a Claude Code one. The names are the kind such a
 * process carries; the values are ours.
 */
const PARENT_SESSION: Readonly<Record<string, string>> = {
  CODEX_HOME: "/parent/codex-home",
  CODEX_SANDBOX: "seatbelt",
  CODEX_SANDBOX_NETWORK_DISABLED: "1",
  CODEX_THREAD_ID: "parent-thread-id",
  OPENAI_API_KEY: "parent-api-key",
  OPENAI_BASE_URL: "https://parent.invalid",
  CLAUDECODE: "1",
  CLAUDE_CODE_SESSION_ID: "parent-session-id",
  CLAUDE_CONFIG_DIR: "/parent/config",
  ANTHROPIC_API_KEY: "parent-anthropic-key",
  POSEIDON_SERVER_TOKEN: "server-token",
};

const INHERITED: Readonly<Record<string, string>> = {
  HOME: "/Users/me",
  PATH: "/usr/bin:/bin",
  USER: "me",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TMPDIR: "/tmp",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  HTTPS_PROXY: "http://proxy:8080",
  GH_TOKEN: "unrelated-token",
  NODE_OPTIONS: "--inspect",
  ...PARENT_SESSION,
};

describe("childEnv", () => {
  it("keeps only the allowlisted names", () => {
    expect(childEnv(INHERITED, {})).toEqual({
      HOME: "/Users/me",
      PATH: "/usr/bin:/bin",
      USER: "me",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TMPDIR: "/tmp",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      HTTPS_PROXY: "http://proxy:8080",
    });
  });

  it("strips every variable of a parent Codex or Claude Code session", () => {
    const env = childEnv(INHERITED, {});
    for (const name of Object.keys(env)) {
      expect(name).not.toMatch(/^(CODEX_|OPENAI_|CLAUDECODE|CLAUDE_|ANTHROPIC_|POSEIDON_)/);
    }
  });

  it("takes CODEX_HOME from the instance only, and never moves HOME", () => {
    const env = childEnv(INHERITED, { codexHome: "/Users/me/.codex-work" });
    expect(env.CODEX_HOME).toBe("/Users/me/.codex-work");
    expect(env.HOME).toBe("/Users/me");
    expect(childEnv(INHERITED, { codexHome: "" }).CODEX_HOME).toBeUndefined();
  });

  it("expands a codex home under ~ against the inherited HOME", () => {
    expect(childEnv(INHERITED, { codexHome: "~/.codex-work" }).CODEX_HOME).toBe(
      "/Users/me/.codex-work",
    );
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("relative/dir", "/h")).toBe(NodePath.resolve("relative/dir"));
  });

  it.effect("is the whole environment a spawned child sees", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-env-"));
      const env = childEnv(
        { ...INHERITED, HOME: NodeOS.homedir(), PATH: process.env.PATH ?? "" },
        { codexHome: dir },
      );
      const group = makeProcessGroup();
      const child = group.spawn({
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        env,
      });
      let printed = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        printed += chunk;
      });
      yield* Effect.promise(() => child.exited);
      yield* group.stop;
      const seen = JSON.parse(printed) as Record<string, string>;
      // macOS's CoreFoundation gives every process its text encoding; nothing else is added.
      for (const name of Object.keys(seen)) {
        if (name === "__CF_USER_TEXT_ENCODING") continue;
        expect(env, name).toHaveProperty(name);
      }
      const parentValues = new Set(Object.values(PARENT_SESSION));
      for (const [name, value] of Object.entries(seen)) {
        expect(parentValues.has(value), name).toBe(false);
      }
      expect(seen.CODEX_HOME).toBe(dir);
      expect(seen.HOME).toBe(NodeOS.homedir());
    }),
  );
});
