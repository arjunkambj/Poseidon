/**
 * What `record-cmd.mjs` asks the real CLI to do.
 *
 * Every scenario answers a question the connector had to guess at, or
 * exercises a path the connector implements. Prompts are deliberately tiny:
 * each one spends the operator's plan, so they say the least that still forces
 * the behaviour, and `maxTurns` caps every run.
 *
 * A turn is `{ prompt, ...flags }`, or a function of the previous turn's
 * session id when it has to resume.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * The one-shot scenario's two halves, joined the way
 * `packages/connector-cmd/src/generateText.ts` joins `system` and `prompt`.
 */
const GENERATE_SYSTEM =
  "You write git commit messages. Reply with the subject line only: imperative mood, under 72 characters, no quotes.";
const GENERATE_REQUEST = "Changed files:\n- README.md: fixed a typo in the install section";

/** A one-shot turn, in a fresh empty directory under the scratch root. */
const generateTurn = (scratch) => ({
  prompt: `${GENERATE_SYSTEM}\n\n${GENERATE_REQUEST}`,
  noSession: true,
  maxTurns: 1,
  yolo: false,
  toolsEnable: [],
  cwd: NodeFS.mkdtempSync(NodePath.join(scratch, "generate-")),
});

export const SCENARIOS = {
  text: {
    description: "Text-only answer: does print mode stream deltas?",
    turns: [{ prompt: "Reply with exactly: ok", maxTurns: 1 }],
  },

  "shell-allow": {
    description: "shell_command approved through the PreToolUse hook (no --yolo)",
    seed: { "note.txt": "hello\n" },
    turns: [
      {
        prompt: "Run the shell command `cat note.txt` and tell me the output. Use the shell tool.",
        maxTurns: 3,
        yolo: false,
        hookPolicy: { default: "allow" },
      },
    ],
  },

  "shell-deny": {
    description: "shell_command denied through the PreToolUse hook (no --yolo)",
    seed: { "note.txt": "hello\n" },
    turns: [
      {
        prompt: "Run the shell command `cat note.txt` and tell me the output. Use the shell tool.",
        maxTurns: 3,
        yolo: false,
        hookPolicy: { default: "deny" },
      },
    ],
  },

  "shell-yolo": {
    description:
      "the same shell call WITH --yolo — the PreToolUse hook still fires and still gates the call",
    seed: { "note.txt": "hello\n" },
    turns: [
      {
        prompt: "Run the shell command `cat note.txt` and tell me the output. Use the shell tool.",
        maxTurns: 3,
        hookPolicy: { default: "allow" },
      },
    ],
  },

  "file-edit": {
    description: "edit_file / write_file blocks in frames and transcript",
    seed: { "greeting.txt": "hello world\n" },
    turns: [
      {
        prompt: "Edit greeting.txt so it says `hello there` instead of `hello world`.",
        maxTurns: 3,
        hookPolicy: { default: "allow" },
      },
    ],
  },

  plan: {
    description:
      "plan mode: is the plan file written before run_end, does run_end reference it? (5.7 q6)",
    seed: { "app.js": "export const add = (a, b) => a + b;\n" },
    turns: [
      {
        prompt:
          "Plan how to add a subtract function to app.js, then call exit_plan_mode to present it.",
        maxTurns: 10,
        permissionMode: "plan",
        // Plan mode skips PreToolUse hooks and denies writes, so without
        // --yolo the model cannot write the plan file it is told to write.
        yolo: true,
      },
      ({ sessionId }) => ({
        prompt: "The plan is accepted. Implement it now.",
        maxTurns: 6,
        sessionId,
        hookPolicy: { default: "allow" },
      }),
    ],
  },

  question: {
    description:
      "ask_user_question with the connector's own argv: print mode withholds the tool (5.7 q3)",
    turns: [
      {
        prompt:
          "Use the ask_user_question tool to ask me whether I prefer tabs or spaces. Ask before doing anything else.",
        maxTurns: 2,
        // The point of this recording: the argv as it was before the flag
        // below existed, where print mode simply withholds the tool.
        toolsEnable: [],
        hookPolicy: { default: "deny" },
      },
    ],
  },

  "question-tools": {
    description:
      "the same ask_user_question prompt with --tools-enable ask_user_question — the flag `--help` says un-withholds a headless tool (5.7 q3)",
    turns: [
      {
        prompt:
          "Use the ask_user_question tool to ask me whether I prefer tabs or spaces. Ask before doing anything else.",
        maxTurns: 2,
        hookPolicy: { default: "deny" },
      },
    ],
  },

  "plan-guard": {
    description:
      "plan mode WITH --yolo, asked to edit the workspace: does the plan ladder still deny mutations once --yolo has lifted the print-mode gate? (decides the connector's plan argv)",
    seed: { "app.js": "export const add = (a, b) => a + b;\n" },
    turns: [
      {
        prompt: "Edit app.js right now to add a subtract function. Do it immediately.",
        maxTurns: 3,
        permissionMode: "plan",
        yolo: true,
        hookPolicy: { default: "allow" },
      },
    ],
  },

  "plan-no-yolo": {
    description:
      "plan mode exactly as the connector spawns it — `--permission-mode plan` and no --yolo",
    seed: { "app.js": "export const add = (a, b) => a + b;\n" },
    turns: [
      {
        prompt: "Plan how to add a subtract function to app.js. Write the plan file.",
        maxTurns: 4,
        permissionMode: "plan",
        yolo: false,
      },
    ],
  },

  "shell-deny-yolo": {
    description:
      "the connector's OWN argv — --yolo and --tools-enable — with the hook answering deny. The one claim the branch could not otherwise make: that a deny still stops the call once --yolo has lifted the CLI's own refusal.",
    seed: { "note.txt": "hello\n" },
    turns: [
      {
        prompt:
          "Run the shell command `cp note.txt copied.txt` and tell me what happened. Use the shell tool.",
        maxTurns: 3,
        hookPolicy: { default: "deny" },
      },
    ],
  },

  "plan-write": {
    description:
      "plan mode WITH --yolo, told in as many words to mutate the workspace and not to plan: is anything but the model's own compliance stopping it? (the gate question plan-guard leaves open)",
    seed: { "app.js": "export const add = (a, b) => a + b;\n" },
    turns: [
      {
        prompt:
          "Create a file called newfile.txt containing exactly: hi. Do not plan, do not ask, do not explain — write the file now.",
        maxTurns: 3,
        permissionMode: "plan",
        yolo: true,
        hookPolicy: { default: "allow" },
      },
    ],
  },

  interrupt: {
    description: "SIGINT mid-turn — exit code and whether run_end still lands",
    seed: { "note.txt": "hello\n" },
    turns: [
      {
        prompt: "Count slowly from 1 to 200, one number per line, with a short comment on each.",
        maxTurns: 2,
        sigintAfterMs: 9000,
      },
    ],
  },

  resume: {
    description: "second turn resuming the first session id (--session)",
    turns: [
      { prompt: "Remember the word `pineapple`. Reply with exactly: stored", maxTurns: 1 },
      ({ sessionId }) => ({
        prompt: "What word did I ask you to remember? Reply with just the word.",
        maxTurns: 1,
        sessionId,
      }),
    ],
  },

  fork: {
    description:
      "a first turn, then --session <it> --fork-session: a new session carrying the first one's history, the first left untouched — and a third turn resuming the fork",
    turns: [
      { prompt: "Remember the word `pineapple`. Reply with exactly: stored", maxTurns: 1 },
      ({ sessionId }) => ({
        prompt: "What word did I ask you to remember? Reply with just the word.",
        maxTurns: 1,
        sessionId,
        forkSession: true,
      }),
      ({ sessionId }) => ({
        prompt: "Reply with that word again, in capitals.",
        maxTurns: 1,
        sessionId,
      }),
    ],
  },

  "max-turns": {
    description: "--max-turns exhausted: stopReason, result.subtype and exit code",
    seed: { "note.txt": "one\n" },
    turns: [
      {
        prompt:
          "Read note.txt, then run `ls`, then run `pwd`, then run `date`, then summarise. Use one tool per step.",
        maxTurns: 1,
        hookPolicy: { default: "allow" },
      },
    ],
  },

  image: {
    description:
      "image attachment the way the connector stages one: the file under an attachments dir, that dir in --add-dir, the absolute path named in the prompt",
    // A 2×2 red PNG, written into the scratch root the same way the server
    // writes a staged upload into `<attachmentsDir>/<threadId>/`.
    scratchSeed: { "attachments/red.png": { png: "red" } },
    turns: [
      ({ scratch }) => ({
        prompt: [
          "What colour is the image? Answer with one word.",
          "",
          `Attachment (image/png): ${scratch}/attachments/red.png`,
        ].join("\n"),
        maxTurns: 3,
        addDir: [`${scratch}/attachments`],
        hookPolicy: { default: "allow" },
      }),
    ],
  },

  mcp: {
    description: "an mcp__<server>__<tool> call — does PreToolUse fire for it? (5.7 q7)",
    // A dependency-free stdio MCP server, registered into the throwaway repo's
    // own `.mcp.json` through `cmd mcp add-json --scope project`.
    mcpServer: true,
    turns: [
      {
        prompt: "Call the `echo` tool on the `rec` MCP server with text `hi`, then stop.",
        maxTurns: 3,
        hookPolicy: { default: "allow" },
      },
    ],
  },

  "shell-twice": {
    description:
      "the same shell call twice in one session — what 'allow always' needs: a second, distinct tool call the persisted rule has to answer without asking again",
    seed: { "note.txt": "hello\n" },
    turns: [
      {
        prompt: "Run the shell command `cat note.txt` and tell me the output. Use the shell tool.",
        maxTurns: 3,
        hookPolicy: { default: "allow" },
      },
      ({ sessionId }) => ({
        prompt:
          "Run the shell command `cat note.txt` again and tell me the output. Use the shell tool.",
        maxTurns: 3,
        sessionId,
        hookPolicy: { default: "allow" },
      }),
    ],
  },

  "file-edit-twice": {
    description:
      "two editing turns in one session — what checkpoints need: two turns that each leave the worktree different, so there is a real diff between the two snapshots and something for a restore to undo",
    seed: { "greeting.txt": "hello world\n", "farewell.txt": "bye world\n" },
    turns: [
      {
        prompt: "Edit greeting.txt so it says `hello there` instead of `hello world`.",
        maxTurns: 3,
        hookPolicy: { default: "allow" },
      },
      ({ sessionId }) => ({
        prompt: "Now edit farewell.txt so it says `bye there` instead of `bye world`.",
        maxTurns: 3,
        sessionId,
        hookPolicy: { default: "allow" },
      }),
    ],
  },

  "interrupt-resume": {
    description:
      "a turn interrupted mid-flight and then a second turn on the same thread — what the composer promises after Stop: the thread takes the next message, and a queued follow-up runs once the interrupted turn has settled",
    seed: { "note.txt": "hello\n" },
    turns: [
      {
        prompt: "Count slowly from 1 to 200, one number per line, with a short comment on each.",
        maxTurns: 2,
        sigintAfterMs: 9000,
      },
      ({ sessionId }) => ({
        prompt: "Never mind. Reply with exactly: ok",
        maxTurns: 1,
        sessionId,
      }),
    ],
  },

  "interrupt-continue": {
    description:
      "the same interrupt, then the next message started the way the connector now starts it — in a NEW session, because the interrupted run wrote no transcript for --session to resume (see interrupt-resume for what happens when it tries)",
    seed: { "note.txt": "hello\n" },
    turns: [
      {
        prompt: "Count slowly from 1 to 200, one number per line, with a short comment on each.",
        maxTurns: 2,
        sigintAfterMs: 9000,
      },
      // Deliberately no `sessionId`: that is the whole difference.
      { prompt: "Never mind. Reply with exactly: ok", maxTurns: 1 },
    ],
  },

  skill: {
    description:
      "a skill reference the way the connector writes one: the user's text with its $greeting token, then the line prepareTurn adds for the skill — does the model activate that skill?",
    // A project skill, found where `skills.ts` looks for one. Its body asks
    // for a reply no model gives unprompted, so the answer shows it was read.
    seed: {
      ".commandcode/skills/greeting/SKILL.md": [
        "---",
        "name: greeting",
        "description: How to greet the user.",
        "---",
        "",
        "Reply with exactly: hello from the greeting skill",
        "",
      ].join("\n"),
    },
    turns: [
      {
        // Exactly what `prepareTurn` builds for the text `Greet me with
        // $greeting.` and one skill reference `greeting`; `turnArgs.test.ts`
        // holds the two together.
        prompt: 'Greet me with $greeting.\n\nUse the "greeting" skill.',
        maxTurns: 3,
        hookPolicy: { default: "allow" },
      },
    ],
  },

  "generate-text": {
    description:
      "one-shot text the way generateText.ts asks for it: --no-session, --max-turns 1, no --yolo and no --tools-enable, in an empty directory of its own outside the repo, where no hook is installed",
    model: "poolside/laguna-s-2.1-free",
    turns: [({ scratch }) => generateTurn(scratch)],
  },

  "generate-text-effort": {
    description:
      "the same one-shot with --effort low on a model that takes no effort: the CLI refuses before any request and exits 1, which is why the caller leaves effort out for such a model",
    model: "poolside/laguna-s-2.1-free",
    turns: [({ scratch }) => ({ ...generateTurn(scratch), effort: "low" })],
  },

  subagent: {
    description:
      "a delegated subagent call — does PreToolUse fire for the subagent's own tool calls? (5.7 q7, the half the mcp recording leaves open)",
    seed: { "note.txt": "hello\n" },
    turns: [
      {
        prompt:
          "Delegate this to a subagent with the agent tool: read note.txt and report what it says. Do not read the file yourself.",
        maxTurns: 4,
        // `--tools-all` because a subagent tool is exactly the kind a headless
        // run withholds, and this recording is what decides whether it is.
        extraArgs: ["--tools-all"],
        hookPolicy: { default: "allow" },
      },
    ],
  },
};

export const scenarioNames = () => Object.keys(SCENARIOS);
