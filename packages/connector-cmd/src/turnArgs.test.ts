/**
 * The argv one turn is spawned with — and the one line of it that decides
 * whether a mode the UI calls "Plan first" is read-only or not.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { makeThreadId } from "@poseidon/contracts/ids";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import type { TurnInput } from "@poseidon/connector-sdk/definition";
import type { SessionPlugin } from "@poseidon/connector-sdk/plugins";

import { cmdEffort, prepareTurn } from "./turnArgs";

const RECORDINGS = NodePath.resolve(
  NodeURL.fileURLToPath(import.meta.url),
  "../../../testkit/fixtures/cmd",
);

const settings = (interactionMode: ThreadSettings["interactionMode"]): ThreadSettings => ({
  model: "meta/muse-spark-1.3-contributor",
  runtimeMode: "approval-required",
  interactionMode,
});

const prepare = (interactionMode: ThreadSettings["interactionMode"]) =>
  prepareTurn({
    turn: { text: "hi", attachments: [], mentions: [] },
    settings: settings(interactionMode),
    attachmentsDir: NodePath.join(NodeFS.realpathSync(NodePath.resolve("/tmp")), "poseidon-none"),
    threadId: makeThreadId(),
    resumeSessionId: null,
  });

describe("prepareTurn", () => {
  it("maps the contract's minimal effort onto Command Code's lowest rung", async () => {
    const prepared = await prepareTurn({
      turn: { text: "hi", attachments: [], mentions: [] },
      settings: { ...settings("default"), effort: "minimal" },
      attachmentsDir: NodePath.join(NodeFS.realpathSync(NodePath.resolve("/tmp")), "poseidon-none"),
      threadId: makeThreadId(),
      resumeSessionId: null,
    });
    expect(prepared.args.join(" ")).toContain("--effort low");
    expect(prepared.args).not.toContain("minimal");
  });

  it("leaves --effort out for ultra, a rung Command Code does not have", async () => {
    expect(cmdEffort("ultra")).toBeUndefined();
    const prepared = await prepareTurn({
      turn: { text: "hi", attachments: [], mentions: [] },
      settings: { ...settings("default"), effort: "ultra" },
      attachmentsDir: NodePath.join(NodeFS.realpathSync(NodePath.resolve("/tmp")), "poseidon-none"),
      threadId: makeThreadId(),
      resumeSessionId: null,
    });
    expect(prepared.args).not.toContain("--effort");
    expect(prepared.args).not.toContain("ultra");
  });

  it("passes every other effort through unchanged", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(cmdEffort(effort)).toBe(effort);
    }
  });

  it("sends --yolo on an ordinary turn", async () => {
    const prepared = await prepare("default");
    expect(prepared.args).toContain("--yolo");
    expect(prepared.args).not.toContain("--permission-mode");
    expect(prepared.plan).toBe(false);
  });

  /**
   * Plan mode fires no PreToolUse hook — `hookCount: 0` in all four plan
   * recordings, including one whose `read_file` fires a hook in an ordinary
   * run — so none of the permission ladder runs there: not the user's `deny`
   * rules, not "plan mode is read-only", not the sensitive-path prompt. Adding
   * `--yolo` on top removed the only thing left, print mode's own refusal of
   * writes and shell calls, and left a mode the UI presents as read-only with
   * no enforcement of any kind. `plan-write/` is that experiment recorded
   * against the real CLI: plan mode, `--yolo`, told outright to mutate.
   */
  it("does not send --yolo on a plan turn", async () => {
    const prepared = await prepare("plan");
    expect(prepared.plan).toBe(true);
    expect(prepared.args).not.toContain("--yolo");
    expect(prepared.args.join(" ")).toContain("--permission-mode plan");
  });

  it("spawns a plan turn the way plan-no-yolo was recorded", async () => {
    // The recording that shows what the refusal looks like: `write_file`
    // blocked with "requires permissions", and the plan's whole body sitting
    // in the `tool_queued` frame that announced it.
    const recorded = JSON.parse(
      NodeFS.readFileSync(NodePath.join(RECORDINGS, "plan-no-yolo", "manifest.json"), "utf8"),
    ) as { turns: ReadonlyArray<{ connectorArgs: ReadonlyArray<string> }> };
    const argv = recorded.turns[0]!.connectorArgs;
    const prepared = await prepare("plan");
    for (const args of [argv, prepared.args]) {
      expect(args).not.toContain("--yolo");
      expect(args.join(" ")).toContain("--permission-mode plan");
      expect(args.slice(2, 8)).toEqual([
        "--output-format",
        "json",
        "--verbose",
        "-t",
        "--skip-onboarding",
        "--no-auto-update",
      ]);
    }
  });
});

/** The built-in Browser plugin as the server hands it to a session. */
const browserPlugin: SessionPlugin = {
  name: "browser",
  root: "/home/builtin-plugins/browser",
  builtin: true,
  skills: [{ name: "browser", path: "/home/builtin-plugins/browser/skills/browser" }],
  skillsDirs: ["/home/builtin-plugins/browser/skills"],
  mcpServers: [],
};

describe("a forked first turn", () => {
  const forkTurn = (resumeSessionId: string | null, fork: boolean) =>
    prepareTurn({
      turn: { text: "hi", attachments: [], mentions: [] },
      settings: settings("default"),
      attachmentsDir: NodePath.join(NodeFS.realpathSync(NodePath.resolve("/tmp")), "poseidon-none"),
      threadId: makeThreadId(),
      resumeSessionId,
      fork,
    });

  /**
   * `fixtures/cmd/fork/` turn 2 was spawned with `--fork-session` straight
   * after `--session <id>`: the harness answered with a new session id on
   * `run_start` and left the first session's transcript byte for byte as it
   * was. The flag sits in the same place here.
   */
  it("puts --fork-session right after the session it forks, as recorded", async () => {
    const recorded = JSON.parse(
      NodeFS.readFileSync(NodePath.join(RECORDINGS, "fork", "manifest.json"), "utf8"),
    ) as { turns: ReadonlyArray<{ connectorArgs: ReadonlyArray<string>; sessionId: string }> };
    const origin = recorded.turns[0]!.sessionId;
    const flags = (args: ReadonlyArray<string>) => {
      const at = args.indexOf("--session");
      return args.slice(at, at + 3);
    };
    const prepared = await forkTurn(origin, true);
    expect(flags(prepared.args)).toEqual(["--session", origin, "--fork-session"]);
    expect(flags(recorded.turns[1]!.connectorArgs)).toEqual(flags(prepared.args));
  });

  it("resumes without forking once the fork is made", async () => {
    const prepared = await forkTurn("d7046b9b-50c8-4567-a5c8-81615db9a65b", false);
    expect(prepared.args).toContain("--session");
    expect(prepared.args).not.toContain("--fork-session");
  });

  it("has nothing to fork without a session to resume", async () => {
    const prepared = await forkTurn(null, true);
    expect(prepared.args).not.toContain("--session");
    expect(prepared.args).not.toContain("--fork-session");
  });
});

/** The prompt `prepareTurn` builds for one turn: argv's second element. */
const promptOf = async (
  turn: TurnInput,
  attachmentsDir = NodePath.join(NodeFS.realpathSync(NodePath.resolve("/tmp")), "poseidon-none"),
  plugins?: ReadonlyArray<SessionPlugin>,
) => {
  const prepared = await prepareTurn({
    turn,
    settings: settings("default"),
    attachmentsDir,
    threadId: makeThreadId(),
    resumeSessionId: null,
    ...(plugins === undefined ? {} : { plugins }),
  });
  expect(prepared.args[0]).toBe("-p");
  return { prompt: prepared.args[1], warnings: prepared.warnings, args: prepared.args };
};

describe("skill and plugin references in the prompt", () => {
  it("writes the text, then mentions, then skills, then attachments", async () => {
    const attachmentsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "poseidon-refs-"));
    const threadId = makeThreadId();
    const staged = NodePath.join(attachmentsDir, threadId, "abc-shot.png");
    NodeFS.mkdirSync(NodePath.dirname(staged), { recursive: true });
    NodeFS.writeFileSync(staged, "PNG");
    const prepared = await prepareTurn({
      turn: {
        text: "Tidy #src/app.ts with $lint and $commit",
        attachments: [{ path: staged, mime: "image/png", name: "shot.png" }],
        mentions: ["src/app.ts"],
        references: [
          { kind: "skill", name: "lint" },
          { kind: "skill", name: "commit" },
        ],
      },
      settings: settings("default"),
      attachmentsDir,
      threadId,
      resumeSessionId: null,
    });
    expect(prepared.args[1]).toBe(
      [
        "Tidy #src/app.ts with $lint and $commit",
        "@src/app.ts",
        'Use the "lint" skill.',
        'Use the "commit" skill.',
        `Attachment (image/png): ${staged}`,
      ].join("\n\n"),
    );
    expect(prepared.warnings).toEqual([]);
  });

  it("names a repeated skill once and quotes a name that needs it", async () => {
    const { prompt } = await promptOf({
      text: "go",
      attachments: [],
      mentions: [],
      references: [
        { kind: "skill", name: "deploy" },
        { kind: "skill", name: "deploy" },
        { kind: "skill", name: 'say "hi"' },
      ],
    });
    expect(prompt).toBe(
      ["go", 'Use the "deploy" skill.', 'Use the "say \\"hi\\"" skill.'].join("\n\n"),
    );
  });

  it("leaves a turn without references exactly as it was", async () => {
    const turn = { text: "hi", attachments: [], mentions: ["a.ts"] } as const;
    const absent = await promptOf(turn);
    const empty = await promptOf({ ...turn, references: [] });
    expect(absent.prompt).toBe("hi\n\n@a.ts");
    expect(empty.args).toEqual(absent.args);
    expect(absent.warnings).toEqual([]);
  });

  it("leaves a plugin out of the prompt and says so", async () => {
    const withPlugin = await promptOf({
      text: "Ship it with @release-notes",
      attachments: [],
      mentions: [],
      references: [
        { kind: "plugin", name: "release-notes" },
        { kind: "skill", name: "commit" },
      ],
    });
    expect(withPlugin.prompt).toBe(
      ["Ship it with @release-notes", 'Use the "commit" skill.'].join("\n\n"),
    );
    expect(withPlugin.warnings).toEqual([
      'the plugin "release-notes" was left out of the prompt: it is not a Poseidon plugin enabled for this session',
    ]);
  });

  it("names a plugin the session loaded, once, and still warns about any other", async () => {
    const withPlugins = await promptOf(
      {
        text: "Check the page with @browser",
        attachments: [],
        mentions: [],
        references: [
          { kind: "plugin", name: "browser" },
          { kind: "skill", name: "commit" },
          { kind: "plugin", name: "browser" },
          { kind: "plugin", name: "release-notes" },
        ],
      },
      undefined,
      [browserPlugin],
    );
    expect(withPlugins.prompt).toBe(
      ["Check the page with @browser", 'Use the "commit" skill.', 'Use the "browser" plugin.'].join(
        "\n\n",
      ),
    );
    expect(withPlugins.warnings).toEqual([
      'the plugin "release-notes" was left out of the prompt: it is not a Poseidon plugin enabled for this session',
    ]);
  });

  /**
   * `fixtures/cmd/skill/` was recorded with the prompt this input builds, and
   * the model called `activate_skill` for `greeting` off the back of it. If
   * the line changes, this fails until the recording is made again.
   */
  it("builds the prompt the skill recording was made with", async () => {
    const recorded = JSON.parse(
      NodeFS.readFileSync(NodePath.join(RECORDINGS, "skill", "manifest.json"), "utf8"),
    ) as { turns: ReadonlyArray<{ prompt: string; connectorArgs: ReadonlyArray<string> }> };
    const { prompt } = await promptOf({
      text: "Greet me with $greeting.",
      attachments: [],
      mentions: [],
      references: [{ kind: "skill", name: "greeting" }],
    });
    expect(prompt).toBe(recorded.turns[0]!.prompt);
    expect(prompt).toBe(recorded.turns[0]!.connectorArgs[1]);
  });
});

describe("plugin skills on the argv", () => {
  it("adds one --skill per enabled plugin's skills directory, after everything else", async () => {
    const tools: SessionPlugin = {
      ...browserPlugin,
      name: "tools",
      root: "/home/plugins/tools",
      builtin: false,
      skillsDirs: ["/home/plugins/tools/skills", "/home/plugins/tools/extra"],
    };
    const { args } = await promptOf({ text: "hi", attachments: [], mentions: [] }, undefined, [
      browserPlugin,
      tools,
      browserPlugin,
    ]);
    const plain = (await promptOf({ text: "hi", attachments: [], mentions: [] })).args;
    expect(args).toEqual([
      ...plain,
      "--skill",
      "/home/builtin-plugins/browser/skills",
      "--skill",
      "/home/plugins/tools/skills",
      "--skill",
      "/home/plugins/tools/extra",
    ]);
  });

  it("adds nothing when no plugin carries skills", async () => {
    const turn = { text: "hi", attachments: [], mentions: [] };
    const none = await promptOf(turn, undefined, []);
    const bare = await promptOf(turn, undefined, [
      { ...browserPlugin, skills: [], skillsDirs: [] },
    ]);
    const absent = await promptOf(turn);
    expect(none.args).toEqual(absent.args);
    expect(bare.args).toEqual(absent.args);
    expect(absent.args).not.toContain("--skill");
  });
});
