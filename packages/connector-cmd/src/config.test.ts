/**
 * The project-local config Poseidon owns: the PreToolUse hook block in
 * `.commandcode/settings.local.json` and the `poseidon` entry in `.mcp.json`.
 * Both merge into files the user may already have, so the tests run against
 * real files in a temp project root — merge, idempotency and removal are the
 * whole contract.
 */

import { spawnSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { makeThreadId } from "@poseidon/contracts/ids";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import {
  HOOK_EXCLUDE_PATTERN,
  installProjectHooks,
  POSEIDON_MCP_NAME,
  removeMcpEntry,
  uninstallProjectHooks,
  upsertMcpEntry,
  type InstalledFile,
} from "./config";
import { ensureHookScript, hookScriptPath, hookScriptSource } from "./hookScript";
import { pluginMcpName, registerSessionMcp } from "./sessionMcp";

const tempDir = (): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-config-test-"))),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>;

const settingsLocal = (root: string): string =>
  NodePath.join(root, ".commandcode", "settings.local.json");

/** The install, asserted to have gone through — most files here are writable. */
const install = (root: string, hookPath: string): Effect.Effect<InstalledFile> =>
  installProjectHooks(root, hookPath).pipe(
    Effect.map((installed) => {
      expect(installed, "the install stood down on a writable file").not.toBeNull();
      return installed as InstalledFile;
    }),
  );

describe("installProjectHooks", () => {
  it.effect("writes the PreToolUse block into a fresh settings.local.json", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const { path, created } = yield* install(root, "/home/u/.poseidon/bin/cmd-hook.mjs");
      expect(created).toBe(true);

      const settings = readJson(path);
      const hooks = settings.hooks as Record<string, unknown>;
      const preToolUse = hooks.PreToolUse as Array<Record<string, unknown>>;
      expect(preToolUse).toHaveLength(1);
      expect(preToolUse[0]?.matcher).toBe(".*");
      const commands = preToolUse[0]?.hooks as Array<Record<string, unknown>>;
      expect(commands[0]).toEqual({
        type: "command",
        command: "/home/u/.poseidon/bin/cmd-hook.mjs",
        timeout: 590,
      });

      // The write is temp-file + rename: no scratch file survives.
      expect(
        NodeFS.readdirSync(NodePath.dirname(path)).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
    }),
  );

  it.effect("preserves other keys and other hook entries, and is idempotent", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      NodeFS.mkdirSync(NodePath.join(root, ".commandcode"), { recursive: true });
      NodeFS.writeFileSync(
        settingsLocal(root),
        JSON.stringify({
          permissions: { defaultMode: "default", allow: ["Shell(git status:*)"] },
          hooks: {
            PreToolUse: [
              {
                matcher: "shell",
                hooks: [{ type: "command", command: "/usr/bin/theirs", timeout: 30 }],
              },
            ],
            PostToolUse: [{ matcher: "", hooks: [] }],
          },
        }),
      );

      const { path, created } = yield* install(root, "/h/cmd-hook.mjs");
      expect(created).toBe(false);
      let settings = readJson(path);
      let preToolUse = (settings.hooks as Record<string, unknown>).PreToolUse as Array<unknown>;
      expect(preToolUse).toHaveLength(2); // theirs, then ours
      expect((preToolUse[0] as Record<string, unknown>).matcher).toBe("shell");
      expect((settings.permissions as Record<string, unknown>).defaultMode).toBe("default");
      expect((settings.hooks as Record<string, unknown>).PostToolUse).toBeDefined();

      // Installing again replaces our entry rather than appending a second.
      yield* install(root, "/h/cmd-hook.mjs");
      settings = readJson(path);
      preToolUse = (settings.hooks as Record<string, unknown>).PreToolUse as Array<unknown>;
      expect(preToolUse).toHaveLength(2);
    }),
  );

  it.effect("uninstall removes only our entries and cleans empty husks", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      yield* install(root, "/h/cmd-hook.mjs");
      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs");

      let settings = readJson(settingsLocal(root));
      expect(settings.hooks).toBeUndefined();

      // A user entry next to ours survives; ours leaves.
      NodeFS.writeFileSync(
        settingsLocal(root),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "", hooks: [{ type: "command", command: "/h/cmd-hook.mjs" }] },
              { matcher: "x", hooks: [{ type: "command", command: "/theirs" }] },
            ],
          },
        }),
      );
      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs");
      settings = readJson(settingsLocal(root));
      const preToolUse = (settings.hooks as Record<string, unknown>).PreToolUse as Array<unknown>;
      expect(preToolUse).toHaveLength(1);
      expect((preToolUse[0] as Record<string, unknown>).matcher).toBe("x");

      // Uninstall on a file without hooks is a no-op, not an error.
      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs");
    }),
  );

  it.effect("a user hook sharing our entry survives install and uninstall", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      NodeFS.mkdirSync(NodePath.join(root, ".commandcode"), { recursive: true });
      NodeFS.writeFileSync(
        settingsLocal(root),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: ".*",
                hooks: [
                  { type: "command", command: "/usr/bin/theirs" },
                  { type: "command", command: "/h/cmd-hook.mjs" },
                ],
              },
            ],
          },
        }),
      );

      const installed = yield* install(root, "/h/cmd-hook.mjs");
      const entries = (readJson(installed.path).hooks as Record<string, unknown>)
        .PreToolUse as Array<{ hooks: Array<{ command: string }> }>;
      // Their command is kept where it was; ours moved into its own entry.
      expect(entries[0]?.hooks.map((hook) => hook.command)).toEqual(["/usr/bin/theirs"]);
      expect(entries[1]?.hooks.map((hook) => hook.command)).toEqual(["/h/cmd-hook.mjs"]);

      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs", installed);
      const after = (readJson(installed.path).hooks as Record<string, unknown>)
        .PreToolUse as Array<{ hooks: Array<{ command: string }> }>;
      expect(after).toHaveLength(1);
      expect(after[0]?.hooks.map((hook) => hook.command)).toEqual(["/usr/bin/theirs"]);
    }),
  );

  it.effect("a hash-guarded uninstall deletes the file it created, or stands down", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const installed = yield* install(root, "/h/cmd-hook.mjs");
      expect(NodeFS.existsSync(installed.path)).toBe(true);
      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs", installed);
      // Nothing of ours was left to keep, and the file was ours to begin with.
      expect(NodeFS.existsSync(installed.path)).toBe(false);

      // Edited since we wrote it → the newer content stays untouched.
      const second = yield* install(root, "/h/cmd-hook.mjs");
      NodeFS.writeFileSync(second.path, JSON.stringify({ permissions: { deny: ["Shell(*)"] } }));
      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs", second);
      expect(readJson(second.path).permissions).toEqual({ deny: ["Shell(*)"] });
    }),
  );

  it.effect("a second session's hold keeps the block in place until it closes too", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const first = yield* install(root, "/h/cmd-hook.mjs");
      const second = yield* install(root, "/h/cmd-hook.mjs");

      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs", first);
      expect(readJson(first.path).hooks).toBeDefined();

      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs", second);
      expect(NodeFS.existsSync(second.path)).toBe(false);
    }),
  );

  it.effect("stands down on a settings.local.json that is not strict JSON", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      NodeFS.mkdirSync(NodePath.join(root, ".commandcode"), { recursive: true });
      // A comment and a trailing comma: `cmd` may read this, JSON.parse does
      // not. Merging onto the `{}` a failed parse yields would take the
      // permissions with it, and the hash-guarded revert would then write
      // that `{}` back for good.
      const original = [
        "{",
        "  // the allow list I curated",
        '  "permissions": { "allow": ["Shell(git status:*)"], },',
        "}",
        "",
      ].join("\n");
      NodeFS.writeFileSync(settingsLocal(root), original);

      const installed = yield* installProjectHooks(root, "/h/cmd-hook.mjs");
      expect(installed).toBeNull();
      expect(NodeFS.readFileSync(settingsLocal(root), "utf8")).toBe(original);

      // And the unguarded teardown leaves it alone too.
      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs");
      expect(NodeFS.readFileSync(settingsLocal(root), "utf8")).toBe(original);
    }),
  );

  it.effect("merges into an empty settings.local.json rather than standing down", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      NodeFS.mkdirSync(NodePath.join(root, ".commandcode"), { recursive: true });
      NodeFS.writeFileSync(settingsLocal(root), "\n");

      const installed = yield* install(root, "/h/cmd-hook.mjs");
      // The file was there, so teardown puts an empty object back instead of
      // deleting a file we did not create.
      expect(installed.created).toBe(false);
      expect(readJson(installed.path).hooks).toBeDefined();
    }),
  );
});

/** Runs git in `cwd` as a throwaway identity; stdout, trimmed. */
const git = (cwd: string, ...args: ReadonlyArray<string>): string => {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { cwd, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};

/** A repository with one commit, so worktrees can be added to it. */
const tempRepo = (): Effect.Effect<string, never, Scope.Scope> =>
  Effect.map(tempDir(), (root) => {
    git(root, "init", "-q", "-b", "main");
    NodeFS.writeFileSync(NodePath.join(root, "README.md"), "hello\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    return root;
  });

const excludeFile = (root: string): string =>
  NodePath.resolve(NodeFS.realpathSync(root), git(root, "rev-parse", "--git-path", "info/exclude"));

const excludeHasHookLine = (root: string): boolean =>
  NodeFS.readFileSync(excludeFile(root), "utf8").split("\n").includes(HOOK_EXCLUDE_PATTERN);

describe("the hook file and the user's commits", () => {
  it.effect("keeps the hook file out of a stage-everything commit while it is installed", () =>
    Effect.gen(function* () {
      const root = yield* tempRepo();
      const before = NodeFS.readFileSync(excludeFile(root), "utf8");
      const installed = yield* install(root, "/h/cmd-hook.mjs");
      expect(installed.gitExclude).toBe(excludeFile(root));

      // The file is on disk, yet `git add -A` — what the commit dialog runs
      // with everything checked — neither lists nor stages it.
      expect(NodeFS.existsSync(installed.path)).toBe(true);
      expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");
      NodeFS.writeFileSync(NodePath.join(root, "work.txt"), "work\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "work");
      expect(git(root, "show", "--name-only", "--format=", "HEAD")).toBe("work.txt");

      // Teardown deletes the untracked file and takes the line back out, so the
      // tree is clean and the exclude file is what it was.
      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs", installed);
      expect(NodeFS.existsSync(installed.path)).toBe(false);
      expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");
      expect(NodeFS.readFileSync(excludeFile(root), "utf8")).toBe(before);
    }),
  );

  it.effect("holds one line for every worktree of the repository until the last closes", () =>
    Effect.gen(function* () {
      const root = yield* tempRepo();
      const parent = yield* tempDir();
      const linked = NodePath.join(parent, "linked");
      git(root, "worktree", "add", "-q", "-b", "side", linked);

      const first = yield* install(root, "/h/cmd-hook.mjs");
      const second = yield* install(linked, "/h/cmd-hook.mjs");
      // `info/exclude` lives in the common git dir, shared by both checkouts.
      expect(second.gitExclude).toBe(first.gitExclude);
      expect(git(linked, "status", "--porcelain", "--untracked-files=all")).toBe("");
      const lines = NodeFS.readFileSync(excludeFile(root), "utf8").split("\n");
      expect(lines.filter((line) => line === HOOK_EXCLUDE_PATTERN)).toHaveLength(1);

      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs", first);
      expect(excludeHasHookLine(root)).toBe(true);
      yield* uninstallProjectHooks(linked, "/h/cmd-hook.mjs", second);
      expect(excludeHasHookLine(root)).toBe(false);
    }),
  );

  it.effect("adds no line when the repository already ignores the file", () =>
    Effect.gen(function* () {
      const root = yield* tempRepo();
      NodeFS.writeFileSync(NodePath.join(root, ".gitignore"), ".commandcode/\n");
      const installed = yield* install(root, "/h/cmd-hook.mjs");
      expect(excludeHasHookLine(root)).toBe(false);
      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs", installed);
      expect(excludeHasHookLine(root)).toBe(false);
    }),
  );

  it.effect("leaves a directory outside any repository alone", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const installed = yield* install(root, "/h/cmd-hook.mjs");
      expect(installed.gitExclude).toBeUndefined();
      yield* uninstallProjectHooks(root, "/h/cmd-hook.mjs", installed);
    }),
  );
});

describe("mcp entry", () => {
  /**
   * A stand-in `cmd` that records the argv it was called with.
   *
   * The file this registers lives under a slug of the workspace path that only
   * the CLI knows how to spell — that is the whole reason the CLI writes it —
   * so what is testable here is the request, not the result. That the entry
   * really lands where the harness reads it is asserted against the real CLI
   * in `apps/server/test/e2e/mcp.test.ts`.
   */
  /** The stub runs under `#!/usr/bin/env node`, so it needs a PATH with node on it. */
  const stubEnv = { PATH: process.env.PATH ?? "" };

  const stubCmd = (root: string, exitCode = 0): { binary: string; calls: () => string[][] } => {
    const binary = NodePath.join(root, "stub-cmd.mjs");
    const log = NodePath.join(root, "stub-cmd.log");
    NodeFS.writeFileSync(
      binary,
      [
        "#!/usr/bin/env node",
        'import * as fs from "node:fs";',
        `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        `process.exit(${exitCode});`,
      ].join("\n"),
      { mode: 0o755 },
    );
    return {
      binary,
      calls: () =>
        NodeFS.readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as string[]),
    };
  };

  it.effect("asks the CLI to register the poseidon server in the local scope", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const stub = stubCmd(root);
      const registration = {
        binaryPath: stub.binary,
        projectRoot: root,
        env: stubEnv,
      };

      expect(yield* upsertMcpEntry(registration, { url: "http://127.0.0.1:4321/mcp" })).toBe(true);

      const [argv] = stub.calls();
      expect(argv?.slice(0, 2)).toEqual(["mcp", "add-json"]);
      expect(argv?.[2]).toBe(POSEIDON_MCP_NAME);
      // The local scope, not a `.mcp.json` inside the user's repo.
      expect(argv).toContain("--scope");
      expect(argv?.[argv.indexOf("--scope") + 1]).toBe("local");
      // Registering must never take the CLI up a version on the user.
      expect(argv).toContain("--no-auto-update");
      expect(NodeFS.existsSync(NodePath.join(root, ".mcp.json"))).toBe(false);

      // The bearer is an env reference, never the token itself: the harness
      // resolves it at launch and a real token would outlive the session.
      const payload = JSON.parse(argv![3]!) as Record<string, unknown>;
      expect(payload).toEqual({
        transport: "http",
        enabled: true,
        url: "http://127.0.0.1:4321/mcp",
        headers: { Authorization: "Bearer ${POSEIDON_MCP_TOKEN}" },
      });
    }),
  );

  it.effect("asks the CLI to remove it again, by name", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const stub = stubCmd(root);
      const registration = {
        binaryPath: stub.binary,
        projectRoot: root,
        env: stubEnv,
      };

      yield* removeMcpEntry(registration);

      // The name is the ownership marker: a server the user added under any
      // other name is not ours to remove.
      const [argv] = stub.calls();
      expect(argv?.slice(0, 3)).toEqual(["mcp", "remove", POSEIDON_MCP_NAME]);
      expect(argv?.[argv.indexOf("--scope") + 1]).toBe("local");
    }),
  );

  /**
   * `~/.commandcode/projects/<slug>/mcp.json` is keyed by the workspace, and
   * every thread of a project shares that workspace. Without a hold, the first
   * thread to close ran `cmd mcp remove` under a second thread that was still
   * running turns — and from its next turn on the model was offered none of
   * Poseidon's browser tools, with no warning, because the removal succeeded.
   */
  it.effect("keeps the entry while a second session in the same project holds it", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const stub = stubCmd(root);
      const registration = { binaryPath: stub.binary, projectRoot: root, env: stubEnv };

      yield* upsertMcpEntry(registration, { url: "http://127.0.0.1:4321/mcp" });
      yield* upsertMcpEntry(registration, { url: "http://127.0.0.1:4321/mcp" });

      // First thread closes: the second is still running turns through it.
      yield* removeMcpEntry(registration);
      expect(stub.calls().filter((argv) => argv[1] === "remove")).toEqual([]);

      // Last one out removes it.
      yield* removeMcpEntry(registration);
      expect(stub.calls().filter((argv) => argv[1] === "remove")).toHaveLength(1);
    }),
  );

  it.effect("holds per project, so another project's entry is untouched", () =>
    Effect.gen(function* () {
      const one = yield* tempDir();
      const two = yield* tempDir();
      const stub = stubCmd(one);
      const first = { binaryPath: stub.binary, projectRoot: one, env: stubEnv };
      const second = { binaryPath: stub.binary, projectRoot: two, env: stubEnv };

      yield* upsertMcpEntry(first, { url: "http://127.0.0.1:4321/mcp" });
      yield* upsertMcpEntry(second, { url: "http://127.0.0.1:4321/mcp" });
      yield* removeMcpEntry(first);
      expect(stub.calls().filter((argv) => argv[1] === "remove")).toHaveLength(1);
      yield* removeMcpEntry(second);
      expect(stub.calls().filter((argv) => argv[1] === "remove")).toHaveLength(2);
    }),
  );

  it.effect("takes no hold for a registration the harness refused", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const refusing = stubCmd(root, 1);
      const registration = { binaryPath: refusing.binary, projectRoot: root, env: stubEnv };
      expect(yield* upsertMcpEntry(registration, { url: "http://127.0.0.1:1/mcp" })).toBe(false);
      // Nothing of ours is in the file, so nothing of ours is holding it: a
      // later session's removal must not be blocked by a failed registration.
      yield* upsertMcpEntry(registration, { url: "http://127.0.0.1:1/mcp" });
      yield* removeMcpEntry(registration);
      expect(refusing.calls().filter((argv) => argv[1] === "remove")).toHaveLength(1);
    }),
  );

  /**
   * `cmd mcp` used to run through `spawnSync`, with no timeout and no kill
   * signal — which blocks the Node event loop, not just one fiber. It is on
   * two hot paths (the first turn of every thread, and every session close
   * including the manager's shutdown finalizer), so while it ran the WebSocket
   * did not drain, `POST /hooks/pretooluse` was not read and no timer fired.
   *
   * The stub here waits for a file that only another fiber can write, so the
   * assertion is exactly that: the loop kept turning while the child ran. A
   * blocking implementation never lets the gate be written and hangs until the
   * timeout — which is the second half of the fix, and is what the short
   * `timeoutMs` keeps bounded.
   */
  it.effect("lets the rest of the server run while the CLI works", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const gate = NodePath.join(root, "gate");
      const binary = NodePath.join(root, "gated-cmd.mjs");
      NodeFS.writeFileSync(
        binary,
        [
          "#!/usr/bin/env node",
          'import * as fs from "node:fs";',
          `const gate = ${JSON.stringify(gate)};`,
          "const wait = () => (fs.existsSync(gate) ? process.exit(0) : setTimeout(wait, 5));",
          "wait();",
        ].join("\n"),
        { mode: 0o755 },
      );
      const registration = {
        binaryPath: binary,
        projectRoot: root,
        env: stubEnv,
        timeoutMs: 2_000,
      };

      const [registered] = yield* Effect.all(
        [
          upsertMcpEntry(registration, { url: "http://127.0.0.1:4321/mcp" }),
          Effect.sync(() => NodeFS.writeFileSync(gate, "go")),
        ],
        { concurrency: "unbounded" },
      );
      expect(registered).toBe(true);
      yield* removeMcpEntry(registration);
    }),
  );

  it.effect("gives up on a cmd mcp that never returns", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const binary = NodePath.join(root, "hanging-cmd.mjs");
      // A wrapper that blocks — a config lock, a slow filesystem, a build
      // waiting on stdin. Without a bound the server never recovers.
      NodeFS.writeFileSync(
        binary,
        ["#!/usr/bin/env node", "setInterval(() => {}, 1000);"].join("\n"),
        { mode: 0o755 },
      );
      expect(
        yield* upsertMcpEntry(
          { binaryPath: binary, projectRoot: root, env: stubEnv, timeoutMs: 250 },
          { url: "http://127.0.0.1:4321/mcp" },
        ),
      ).toBe(false);
    }),
  );

  it.effect("reports a refusal instead of assuming the tools are there", () =>
    Effect.gen(function* () {
      // A harness that would not take the entry — an unparseable config of the
      // user's, a scope it does not support. The session says the tools are
      // unavailable rather than offering the model something it cannot reach.
      const root = yield* tempDir();
      const stub = stubCmd(root, 1);
      expect(
        yield* upsertMcpEntry(
          { binaryPath: stub.binary, projectRoot: root, env: stubEnv },
          { url: "http://127.0.0.1:1/mcp" },
        ),
      ).toBe(false);
    }),
  );

  it.effect("answers false rather than throwing when there is no binary", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      expect(
        yield* upsertMcpEntry(
          { binaryPath: NodePath.join(root, "nope"), projectRoot: root, env: {} },
          { url: "http://127.0.0.1:1/mcp" },
        ),
      ).toBe(false);
    }),
  );

  it.effect("registers a named entry as given and removes it by that name", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const stub = stubCmd(root);
      const registration = { binaryPath: stub.binary, projectRoot: root, env: stubEnv };
      const entry = {
        transport: "stdio" as const,
        command: "/plugins/tools/bin/server",
        args: ["--fast"],
        env: { MODE: "x" },
      };

      expect(yield* upsertMcpEntry(registration, entry, "poseidon-plugin-tools-local")).toBe(true);
      yield* removeMcpEntry(registration, "poseidon-plugin-tools-local");

      const [add, remove] = stub.calls();
      expect(add?.slice(0, 3)).toEqual(["mcp", "add-json", "poseidon-plugin-tools-local"]);
      expect(JSON.parse(add![3]!)).toEqual({ ...entry, enabled: true });
      expect(add?.[add.indexOf("--scope") + 1]).toBe("local");
      expect(remove?.slice(0, 3)).toEqual(["mcp", "remove", "poseidon-plugin-tools-local"]);
    }),
  );

  it.effect("holds each name on its own, so a plugin entry never keeps poseidon's", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const stub = stubCmd(root);
      const registration = { binaryPath: stub.binary, projectRoot: root, env: stubEnv };
      const plugin = { transport: "http" as const, url: "https://search.example/mcp" };

      yield* upsertMcpEntry(registration, { url: "http://127.0.0.1:4321/mcp" });
      yield* upsertMcpEntry(registration, plugin, "poseidon-plugin-tools-search");
      yield* upsertMcpEntry(registration, plugin, "poseidon-plugin-tools-search");

      yield* removeMcpEntry(registration);
      yield* removeMcpEntry(registration, "poseidon-plugin-tools-search");
      const removed = () =>
        stub
          .calls()
          .filter((argv) => argv[1] === "remove")
          .map((argv) => argv[2]);
      expect(removed()).toEqual([POSEIDON_MCP_NAME]);

      yield* removeMcpEntry(registration, "poseidon-plugin-tools-search");
      expect(removed()).toEqual([POSEIDON_MCP_NAME, "poseidon-plugin-tools-search"]);
    }),
  );

  it.effect("registers a session's plugin servers beside poseidon and releases them once", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const stub = stubCmd(root);
      const registration = { binaryPath: stub.binary, projectRoot: root, env: stubEnv };
      const warnings: Array<string> = [];
      const session = yield* registerSessionMcp({
        registration,
        services: {
          mcpEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:4321/mcp", bearer: "b" }),
        },
        threadId: makeThreadId(),
        plugins: [
          {
            name: "tools",
            root: "/plugins/tools",
            builtin: false,
            skills: [],
            skillsDirs: [],
            mcpServers: [
              { name: "search", transport: "http", url: "https://search.example/mcp" },
              { name: "local.v2", transport: "stdio", command: "/plugins/tools/bin/server" },
              // Nothing to reach it by: skipped, not registered broken.
              { name: "broken", transport: "stdio" },
            ],
          },
        ],
        warn: (message) => Effect.sync(() => void warnings.push(message)),
      });
      expect(session.endpoint).toEqual({ url: "http://127.0.0.1:4321/mcp", bearer: "b" });
      expect(stub.calls().map((argv) => argv[2])).toEqual([
        POSEIDON_MCP_NAME,
        "poseidon-plugin-tools-search",
        pluginMcpName("tools", "local.v2"),
      ]);
      expect(pluginMcpName("tools", "local.v2")).toBe("poseidon-plugin-tools-local-v2");
      expect(warnings).toEqual([]);

      yield* session.release;
      yield* session.release;
      expect(
        stub
          .calls()
          .filter((argv) => argv[1] === "remove")
          .map((argv) => argv[2]),
      ).toEqual([
        POSEIDON_MCP_NAME,
        "poseidon-plugin-tools-search",
        "poseidon-plugin-tools-local-v2",
      ]);
    }),
  );

  it.effect("warns about a plugin server the harness refused and holds nothing for it", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const refusing = stubCmd(root, 1);
      const registration = { binaryPath: refusing.binary, projectRoot: root, env: stubEnv };
      const warnings: Array<string> = [];
      const session = yield* registerSessionMcp({
        registration,
        services: { mcpEndpoint: () => Effect.succeed({ url: "", bearer: "" }) },
        threadId: makeThreadId(),
        plugins: [
          {
            name: "tools",
            root: "/plugins/tools",
            builtin: false,
            skills: [],
            skillsDirs: [],
            mcpServers: [{ name: "search", transport: "http", url: "https://search.example/mcp" }],
          },
        ],
        warn: (message) => Effect.sync(() => void warnings.push(message)),
      });
      expect(warnings).toEqual([
        'the harness refused to register the MCP server "search" of the plugin "tools", so its tools are unavailable this session',
      ]);
      yield* session.release;
      expect(refusing.calls().filter((argv) => argv[1] === "remove")).toEqual([]);
    }),
  );
});

/**
 * The harness runs a hook's `command` through `/bin/bash` — `runSyncHook` in
 * the 1.56.0 bundle calls `shell.run({command, shell: hookShell(runtime)})`
 * and `hookShell` answers `/bin/bash` off Windows. So an unquoted path with a
 * space in it is two words, the hook never runs, it produces no decision, and
 * under `--yolo` every shell command and file write in that session runs
 * without ever raising a card: the gate's failure mode is to open, silently.
 */
describe("the hook command a shell has to read", () => {
  it.effect("is one word even when the home directory has a space in it", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const hookPath = NodePath.join(root, "First Last", "bin", "cmd-hook.mjs");
      yield* installProjectHooks(root, hookPath);
      const written = JSON.parse(
        NodeFS.readFileSync(NodePath.join(root, ".commandcode", "settings.local.json"), "utf8"),
      ) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
      const command = written.hooks.PreToolUse[0]!.hooks[0]!.command;

      // Ask a real bash what it makes of it: one argument, spelled correctly.
      const seen = spawnSync("/bin/bash", ["-c", `printf '%s\\n' ${command}`, "--"], {
        encoding: "utf8",
      });
      expect(seen.stdout.trimEnd().split("\n")).toEqual([hookPath]);
    }),
  );

  it.effect("recognises its own quoted command again when it removes it", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const hookPath = NodePath.join(root, "First Last", "bin", "cmd-hook.mjs");
      const installed = (yield* installProjectHooks(root, hookPath))!;
      yield* uninstallProjectHooks(root, hookPath, installed);
      expect(NodeFS.existsSync(installed.path)).toBe(false);
    }),
  );

  it.effect("leaves an ordinary path exactly as it always wrote it", () =>
    Effect.gen(function* () {
      // No churn in the settings file of every user whose home has no space.
      const root = yield* tempDir();
      const hookPath = NodePath.join(root, "bin", "cmd-hook.mjs");
      yield* installProjectHooks(root, hookPath);
      const written = NodeFS.readFileSync(
        NodePath.join(root, ".commandcode", "settings.local.json"),
        "utf8",
      );
      expect(written).toContain(`"command": ${JSON.stringify(hookPath)}`);
    }),
  );
});

describe("ensureHookScript", () => {
  it.effect("writes the script once, executable, and rewrites only on drift", () =>
    Effect.gen(function* () {
      const home = yield* tempDir();
      const env = { POSEIDON_HOME: home };

      const path = yield* ensureHookScript(env);
      expect(path).toBe(hookScriptPath(env));
      expect(path.endsWith(`bin${NodePath.sep}cmd-hook.mjs`)).toBe(true);
      expect(NodeFS.readFileSync(path, "utf8")).toBe(hookScriptSource());
      // 0700 — the shell executes it directly.
      expect(NodeFS.statSync(path).mode & 0o777).toBe(0o700);

      // Same content → no rewrite. Proof: make the file read-only; a rewrite
      // would fail the effect, a stat-only pass restores the exec bit.
      NodeFS.chmodSync(path, 0o400);
      yield* ensureHookScript(env);
      expect(NodeFS.statSync(path).mode & 0o777).toBe(0o700);

      NodeFS.writeFileSync(path, "// tampered\n");
      yield* ensureHookScript(env);
      expect(NodeFS.readFileSync(path, "utf8")).toBe(hookScriptSource());

      // Temp-file + rename leaves no scratch files behind.
      expect(NodeFS.readdirSync(NodePath.dirname(path))).toEqual(["cmd-hook.mjs"]);
    }),
  );
});
