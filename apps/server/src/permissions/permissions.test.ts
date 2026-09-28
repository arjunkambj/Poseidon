import { describe, expect, it } from "vitest";

import { makeRequestId } from "@poseidon/contracts/ids";
import type { ApprovalKind } from "@poseidon/contracts/enums";
import type { ApprovalRequest } from "@poseidon/contracts/runtime";

import { parsePattern, patternMatches, requestPath } from "./patterns";
import { commandTouchesSensitivePath, isSensitivePath } from "./sensitivePaths";
import { decidePermission, type PermissionDecision } from "./PermissionService";

const request = (kind: ApprovalKind, input: unknown, toolName = "tool"): ApprovalRequest => ({
  requestId: makeRequestId(),
  kind,
  toolName,
  input,
  description: `${kind} request`,
});

describe("patterns", () => {
  it("parses the Command Code call form", () => {
    expect(parsePattern("Shell(npm run *)")).toMatchObject({
      family: "shell",
      arg: "npm run *",
    });
    expect(parsePattern("Edit(/src/**)")).toMatchObject({
      family: "edit",
      arg: "/src/**",
    });
    expect(parsePattern("mcp__github__create_issue")).toMatchObject({
      family: "mcp-name",
      arg: "mcp__github__create_issue",
    });
    expect(parsePattern("shell_command")).toMatchObject({
      family: "tool",
      arg: "shell_command",
    });
    expect(parsePattern("Shell(unclosed")).toMatchObject({ family: "tool" });
    expect(parsePattern("Unknown(x)")).toBeNull();
    expect(parsePattern("  ")).toBeNull();
  });

  it("matches Shell patterns against commands", () => {
    const run = (pattern: string, command: string) =>
      patternMatches(pattern, request("command", { command }, "shell_command"));
    expect(run("Shell(npm run *)", "npm run build")).toBe(true);
    expect(run("Shell(npm run *)", "npm install")).toBe(false);
    expect(run("Shell(git status)", "git status")).toBe(true);
    expect(run("Shell(git status)", "git status --short")).toBe(false);
    expect(run("Shell(rm -rf *)", "rm -rf /")).toBe(true);
  });

  it("matches Edit/Write patterns against write paths", () => {
    const edit = (pattern: string, path: string) =>
      patternMatches(pattern, request("file_write", { path }, "file_write"));
    expect(edit("Edit(/src/**)", "/src/components/app.tsx")).toBe(true);
    expect(edit("Edit(/src/**)", "/README.md")).toBe(false);
    expect(edit("Edit(/src/*)", "/src/deep/nested.ts")).toBe(false);
    expect(edit("Write(/tmp/**)", "/tmp/out.txt")).toBe(true);
    // Write patterns do not reach reads, and vice versa.
    expect(patternMatches("Write(/src/**)", request("file_read", { path: "/src/x" }))).toBe(false);
    expect(patternMatches("Read(/src/**)", request("file_read", { path: "/src/a/b" }))).toBe(true);
  });

  it("matches mcp__ patterns and bare tool names against toolName", () => {
    const mcp = request("mcp_tool", {}, "mcp__github__create_issue");
    expect(patternMatches("mcp__github__create_issue", mcp)).toBe(true);
    expect(patternMatches("mcp__github__*", mcp)).toBe(true);
    expect(patternMatches("mcp__other__*", mcp)).toBe(false);
    expect(patternMatches("shell_command", request("command", {}, "shell_command"))).toBe(true);
  });

  it("extracts the subject path across input key spellings", () => {
    expect(requestPath(request("file_read", { path: "/a" }))).toBe("/a");
    expect(requestPath(request("file_read", { file_path: "/b" }))).toBe("/b");
    expect(requestPath(request("file_read", { filePath: "/c" }))).toBe("/c");
    expect(requestPath(request("file_read", {}))).toBeNull();
  });
});

describe("sensitive paths", () => {
  it.each([
    ".env",
    ".env.local",
    "project/.env.production",
    ".envrc",
    "project/.envrc",
    "/home/user/.ssh/id_ed25519",
    ".aws/credentials",
    "creds/server.pem",
    "tls/site.key",
    "store.p12",
    ".netrc",
    ".pgpass",
    ".gnupg/secring.gpg",
    ".config/gh/hosts.yml",
    ".git/HEAD",
    ".git/config",
    "project/.git/hooks/pre-commit",
    ".commandcode/settings.json",
    ".commandcode/settings.local.json",
    "project/.commandcode/settings.json",
    ".claude/settings.local.json",
    "/home/user/.claude/.credentials.json",
    "project/.claude/settings.json",
    ".codex/auth.json",
    "/home/user/.codex/config.toml",
    "/home/user/.agent-browser/config.json",
    ".config/opencode/opencode.json",
    "/home/user/.config/opencode/auth.json",
  ])("flags %s", (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each([
    "src/app.ts",
    "README.md",
    "env.example",
    "src/environment.ts",
    "keys.txt",
    "public/id_rsa_backup.txt",
    ".gitignore",
    ".gitmodules",
    "config/settings.json",
    // Near misses: only the exact directory names count.
    "docs/claude.md",
    "src/codex/index.ts",
    ".config/opencode-notes.txt",
    "opencode/config.json",
  ])("allows %s", (path) => {
    expect(isSensitivePath(path)).toBe(false);
  });

  describe("inside a workspace that lives under a config directory", () => {
    const root = "/home/user/code/app/.claude/worktrees/feature";

    it("does not count the directories above the workspace root", () => {
      expect(isSensitivePath(`${root}/package.json`, root)).toBe(false);
      expect(isSensitivePath(`${root}/src/app.ts`, root)).toBe(false);
      expect(isSensitivePath(root, root)).toBe(false);
      expect(commandTouchesSensitivePath(`cd ${root} && pnpm test`, root)).toBe(false);
    });

    it("still counts what lies inside the workspace", () => {
      expect(isSensitivePath(`${root}/.claude/settings.json`, root)).toBe(true);
      expect(isSensitivePath(`${root}/.git/config`, root)).toBe(true);
      expect(isSensitivePath(`${root}/.env`, root)).toBe(true);
    });

    it("still counts the same path outside the workspace, or climbing out of it", () => {
      expect(isSensitivePath("/home/user/code/app/.claude/settings.json", root)).toBe(true);
      expect(isSensitivePath(`${root}/../../settings.json`, root)).toBe(true);
      expect(isSensitivePath(`${root}/package.json`)).toBe(true);
    });

    it("still counts a config home opened as the project itself", () => {
      expect(isSensitivePath("/home/user/.claude/settings.json", "/home/user/.claude")).toBe(true);
    });
  });
});

// ── The decision table ───────────────────────────────────────

type Mode = "approval-required" | "auto-accept-edits" | "full-access";
type Interaction = "default" | "plan";

interface Row {
  readonly kind: ApprovalKind;
  readonly toolName?: string;
  readonly input?: unknown;
  readonly mode: Mode;
  readonly interaction?: Interaction;
  readonly rules?: ReadonlyArray<{ pattern: string; decision: "allow" | "deny" }>;
  readonly want: PermissionDecision;
}

const shell = (command: string) => ({ command });
const write = (path: string) => ({ path });

const rows: ReadonlyArray<Row> = [
  // No rules: mode ladder over every kind.
  { kind: "file_read", input: write("/src/a.ts"), mode: "approval-required", want: "allow" },
  { kind: "file_read", input: write("/src/a.ts"), mode: "auto-accept-edits", want: "allow" },
  { kind: "file_read", input: write("/src/a.ts"), mode: "full-access", want: "allow" },
  { kind: "file_write", input: write("/src/a.ts"), mode: "approval-required", want: "prompt" },
  { kind: "file_write", input: write("/src/a.ts"), mode: "auto-accept-edits", want: "allow" },
  { kind: "file_write", input: write("/src/a.ts"), mode: "full-access", want: "allow" },
  { kind: "command", input: shell("ls"), mode: "approval-required", want: "prompt" },
  { kind: "command", input: shell("ls"), mode: "auto-accept-edits", want: "prompt" },
  { kind: "command", input: shell("ls"), mode: "full-access", want: "allow" },
  { kind: "command", input: shell("rm -rf build"), mode: "approval-required", want: "prompt" },
  { kind: "command", input: shell("rm -rf build"), mode: "auto-accept-edits", want: "prompt" },
  { kind: "command", input: shell("rm -rf build"), mode: "full-access", want: "allow" },
  { kind: "mcp_tool", toolName: "mcp__s__t", mode: "approval-required", want: "prompt" },
  { kind: "mcp_tool", toolName: "mcp__s__t", mode: "auto-accept-edits", want: "prompt" },
  { kind: "mcp_tool", toolName: "mcp__s__t", mode: "full-access", want: "allow" },
  { kind: "web", input: { url: "https://example.com" }, mode: "approval-required", want: "prompt" },
  { kind: "web", input: { url: "https://example.com" }, mode: "auto-accept-edits", want: "prompt" },
  { kind: "web", input: { url: "https://example.com" }, mode: "full-access", want: "allow" },
  { kind: "other", mode: "approval-required", want: "prompt" },
  { kind: "other", mode: "auto-accept-edits", want: "prompt" },
  { kind: "other", mode: "full-access", want: "allow" },

  // Sensitive paths prompt under every mode — even full-access.
  { kind: "file_read", input: write(".env"), mode: "full-access", want: "prompt" },
  {
    kind: "file_read",
    input: write("/home/u/.ssh/id_rsa"),
    mode: "approval-required",
    want: "prompt",
  },
  { kind: "file_read", input: write("keys/site.pem"), mode: "auto-accept-edits", want: "prompt" },
  { kind: "file_write", input: write(".env"), mode: "auto-accept-edits", want: "prompt" },
  { kind: "file_write", input: write("keys/site.key"), mode: "full-access", want: "prompt" },
  { kind: "file_write", input: write(".env"), mode: "approval-required", want: "prompt" },
  // A harness's own config home is sensitive whichever harness runs the thread.
  {
    kind: "file_write",
    input: write(".claude/settings.local.json"),
    mode: "full-access",
    want: "prompt",
  },
  { kind: "command", input: shell("cat ~/.codex/auth.json"), mode: "full-access", want: "prompt" },
  // ... and a shell command that names one is no different from a read.
  { kind: "command", input: shell("cat ~/.ssh/id_rsa"), mode: "full-access", want: "prompt" },
  { kind: "command", input: shell("cp .env /tmp"), mode: "full-access", want: "prompt" },
  { kind: "command", input: shell("cat 'keys/site.pem'"), mode: "full-access", want: "prompt" },
  {
    kind: "command",
    input: shell("ls && cat .aws/credentials"),
    mode: "full-access",
    want: "prompt",
  },
  {
    kind: "command",
    input: shell("cat .env"),
    mode: "full-access",
    rules: [{ pattern: "Shell(cat *)", decision: "allow" }],
    want: "prompt",
  },
  // Ordinary commands still pass: the check is about secrets, not caution.
  { kind: "command", input: shell("git status"), mode: "full-access", want: "allow" },
  { kind: "command", input: shell("cat .gitignore"), mode: "full-access", want: "allow" },
  {
    kind: "command",
    input: shell("npm run build --key=value"),
    mode: "full-access",
    want: "allow",
  },

  // Plan mode denies anything that is not a read, in any runtime mode.
  {
    kind: "file_write",
    input: write("/src/a.ts"),
    mode: "full-access",
    interaction: "plan",
    want: "deny",
  },
  {
    kind: "file_write",
    input: write("/src/a.ts"),
    mode: "auto-accept-edits",
    interaction: "plan",
    want: "deny",
  },
  { kind: "command", input: shell("ls"), mode: "full-access", interaction: "plan", want: "deny" },
  {
    kind: "mcp_tool",
    toolName: "mcp__s__t",
    mode: "full-access",
    interaction: "plan",
    want: "deny",
  },
  {
    kind: "web",
    input: { url: "https://x.test" },
    mode: "full-access",
    interaction: "plan",
    want: "deny",
  },
  { kind: "other", mode: "full-access", interaction: "plan", want: "deny" },
  {
    kind: "file_read",
    input: write("/src/a.ts"),
    mode: "approval-required",
    interaction: "plan",
    want: "allow",
  },
  {
    kind: "file_read",
    input: write("/src/a.ts"),
    mode: "full-access",
    interaction: "plan",
    want: "allow",
  },
  // ...but sensitive reads still ask in plan mode.
  {
    kind: "file_read",
    input: write(".env"),
    mode: "approval-required",
    interaction: "plan",
    want: "prompt",
  },

  // A tool that names a path in a `file:` URL reads it just as surely as
  // `read_file` does, and the contract's promise about full-access — "allows
  // everything except sensitive paths and deny rules" — has to hold there too.
  // The ladder used to skip the check for every kind but the file and command
  // ones, so `browser_open file:///…/.ssh/id_ed25519` never showed a card.
  {
    kind: "mcp_tool",
    toolName: "mcp__poseidon__browser_open",
    input: { url: "file:///Users/someone/.ssh/id_ed25519" },
    mode: "full-access",
    want: "prompt",
  },
  {
    kind: "mcp_tool",
    toolName: "mcp__poseidon__browser_open",
    input: { url: "file:///Users/someone/project/.env" },
    mode: "full-access",
    rules: [{ pattern: "mcp__poseidon__browser_*", decision: "allow" }],
    want: "prompt",
  },
  {
    kind: "mcp_tool",
    toolName: "mcp__poseidon__browser_open",
    input: { url: "https://example.com/.env" },
    mode: "full-access",
    want: "allow",
  },
  {
    kind: "other",
    toolName: "some_reader",
    input: { path: "/home/user/.aws/credentials" },
    mode: "full-access",
    want: "prompt",
  },

  // Deny rules beat everything, including full-access and allow rules.
  {
    kind: "command",
    input: shell("rm -rf /"),
    mode: "full-access",
    rules: [{ pattern: "Shell(rm -rf *)", decision: "deny" }],
    want: "deny",
  },
  {
    kind: "command",
    input: shell("rm -rf /"),
    mode: "approval-required",
    rules: [
      { pattern: "Shell(rm -rf *)", decision: "deny" },
      { pattern: "Shell(rm *)", decision: "allow" },
    ],
    want: "deny",
  },
  {
    kind: "file_write",
    input: write("/prod/config.yaml"),
    mode: "auto-accept-edits",
    rules: [{ pattern: "Write(/prod/**)", decision: "deny" }],
    want: "deny",
  },
  {
    kind: "file_read",
    input: write("/src/a.ts"),
    mode: "approval-required",
    rules: [{ pattern: "Read(/src/**)", decision: "deny" }],
    want: "deny",
  },
  {
    kind: "mcp_tool",
    toolName: "mcp__github__delete_repo",
    mode: "full-access",
    rules: [{ pattern: "mcp__github__delete_*", decision: "deny" }],
    want: "deny",
  },
  {
    kind: "web",
    input: { url: "https://api.example.com/users" },
    mode: "full-access",
    rules: [{ pattern: "WebFetch(https://*.example.com/*)", decision: "deny" }],
    want: "deny",
  },
  // A deny rule for something else does not decide this request.
  {
    kind: "command",
    input: shell("ls"),
    mode: "full-access",
    rules: [{ pattern: "Shell(rm *)", decision: "deny" }],
    want: "allow",
  },

  // Allow rules short-circuit the mode ladder.
  {
    kind: "command",
    input: shell("npm run build"),
    mode: "approval-required",
    rules: [{ pattern: "Shell(npm run *)", decision: "allow" }],
    want: "allow",
  },
  {
    kind: "command",
    input: shell("npm run test"),
    mode: "auto-accept-edits",
    rules: [{ pattern: "Shell(npm run *)", decision: "allow" }],
    want: "allow",
  },
  {
    kind: "file_write",
    input: write("/src/gen/out.ts"),
    mode: "approval-required",
    rules: [{ pattern: "Edit(/src/gen/**)", decision: "allow" }],
    want: "allow",
  },
  {
    kind: "mcp_tool",
    toolName: "mcp__github__create_issue",
    mode: "approval-required",
    rules: [{ pattern: "mcp__github__create_*", decision: "allow" }],
    want: "allow",
  },
  {
    kind: "web",
    input: { url: "https://docs.example.com/api" },
    mode: "approval-required",
    rules: [{ pattern: "WebFetch(https://docs.example.com/*)", decision: "allow" }],
    want: "allow",
  },
  // ...but an allow rule never overrides a sensitive path.
  {
    kind: "file_read",
    input: write(".env"),
    mode: "approval-required",
    rules: [{ pattern: "Read(.env)", decision: "allow" }],
    want: "prompt",
  },
  {
    kind: "file_write",
    input: write(".env"),
    mode: "approval-required",
    rules: [{ pattern: "Write(.env)", decision: "allow" }],
    want: "prompt",
  },
  // ...and an allow rule does not rescue a plan-mode deny.
  {
    kind: "file_write",
    input: write("/src/a.ts"),
    mode: "approval-required",
    interaction: "plan",
    rules: [{ pattern: "Edit(/src/**)", decision: "allow" }],
    want: "deny",
  },
  // An allow rule for a different subject does not apply.
  {
    kind: "command",
    input: shell("git push"),
    mode: "approval-required",
    rules: [{ pattern: "Shell(git status)", decision: "allow" }],
    want: "prompt",
  },
  {
    kind: "file_write",
    input: write("/etc/hosts"),
    mode: "approval-required",
    rules: [{ pattern: "Edit(/src/**)", decision: "allow" }],
    want: "prompt",
  },
];

describe("decidePermission", () => {
  it("covers the decision table", () => {
    expect(rows.length).toBeGreaterThanOrEqual(50);
    for (const [index, row] of rows.entries()) {
      const req = request(row.kind, row.input ?? {}, row.toolName ?? "tool");
      const got = decidePermission({
        request: req,
        runtimeMode: row.mode,
        interactionMode: row.interaction ?? "default",
        rules: row.rules ?? [],
      });
      expect(got, `row ${index}: ${JSON.stringify(row)}`).toBe(row.want);
    }
  });
});

// Generate the remaining rows to hit 100+: every kind × mode × a matching
// allow rule and a matching deny rule, asserting precedence in both orders.
const generated: ReadonlyArray<Row> = (() => {
  const cases: ReadonlyArray<{
    kind: ApprovalKind;
    toolName: string;
    input: unknown;
    pattern: string;
  }> = [
    {
      kind: "command",
      toolName: "shell_command",
      input: shell("make build"),
      pattern: "Shell(make *)",
    },
    {
      kind: "file_write",
      toolName: "file_write",
      input: write("/gen/x.ts"),
      pattern: "Write(/gen/**)",
    },
    {
      kind: "file_read",
      toolName: "file_read",
      input: write("/data/x.json"),
      pattern: "Read(/data/**)",
    },
    { kind: "mcp_tool", toolName: "mcp__svc__call", input: {}, pattern: "mcp__svc__*" },
    {
      kind: "web",
      toolName: "web_fetch",
      input: { url: "https://svc.test/a" },
      pattern: "WebFetch(https://svc.test/*)",
    },
  ];
  const modes: ReadonlyArray<Mode> = ["approval-required", "auto-accept-edits", "full-access"];
  const out: Array<Row> = [];
  for (const c of cases) {
    for (const mode of modes) {
      out.push(
        {
          kind: c.kind,
          toolName: c.toolName,
          input: c.input,
          mode,
          rules: [{ pattern: c.pattern, decision: "allow" }],
          want: "allow",
        },
        {
          kind: c.kind,
          toolName: c.toolName,
          input: c.input,
          mode,
          rules: [{ pattern: c.pattern, decision: "deny" }],
          want: "deny",
        },
        {
          kind: c.kind,
          toolName: c.toolName,
          input: c.input,
          mode,
          rules: [
            { pattern: c.pattern, decision: "allow" },
            { pattern: c.pattern, decision: "deny" },
          ],
          want: "deny",
        },
        {
          kind: c.kind,
          toolName: c.toolName,
          input: c.input,
          mode,
          rules: [
            { pattern: c.pattern, decision: "deny" },
            { pattern: c.pattern, decision: "allow" },
          ],
          want: "deny",
        },
      );
    }
  }
  return out;
})();

describe("a workspace under .claude/worktrees", () => {
  const root = "/home/user/code/app/.claude/worktrees/feature";

  it("reads and edits its own files as any other project does", () => {
    const decide = (kind: ApprovalKind, file: string) =>
      decidePermission({
        request: request(kind, { file_path: file }),
        runtimeMode: "full-access",
        interactionMode: "default",
        rules: [],
        workspaceRoot: root,
      });
    expect(decide("file_read", `${root}/package.json`)).toBe("allow");
    expect(decide("file_write", `${root}/src/app.ts`)).toBe("allow");
    expect(decide("file_write", `${root}/.claude/settings.json`)).toBe("prompt");
  });
});

describe("decidePermission precedence table", () => {
  it("runs 100+ rows", () => {
    expect(rows.length + generated.length).toBeGreaterThanOrEqual(100);
    for (const [index, row] of generated.entries()) {
      const req = request(row.kind, row.input ?? {}, row.toolName ?? "tool");
      const got = decidePermission({
        request: req,
        runtimeMode: row.mode,
        interactionMode: row.interaction ?? "default",
        rules: row.rules ?? [],
      });
      expect(got, `generated row ${index}: ${JSON.stringify(row)}`).toBe(row.want);
    }
  });
});
