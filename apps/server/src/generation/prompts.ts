/**
 * Every prompt Poseidon sends for generated text, in one place: the commit
 * message, the pull request's title and body, and a thread's title.
 *
 * Each builder answers a system instruction, the prompt and the JSON schema
 * the answer should follow. A harness that can enforce the schema does; the
 * rest are told the shape in words, and `parse.ts` reads either leniently.
 *
 * Commit and pull-request text take their style from the settings: the
 * repository's own conventions (its recent subjects and agent notes, passed
 * as text), Conventional Commits, or the user's instructions. Custom with no
 * instructions reads as the repository's conventions, and a repository with
 * no history gets a plain imperative instruction. Everything the model reads
 * is capped first: a patch at `PATCH_CAP` characters, a summary, a log or a
 * conversation at `SUMMARY_CAP`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as nodePath from "node:path";
import type { WritingStyle } from "@poseidon/contracts/generation";

import { realPathInside } from "./insideRoot";

/** The most of a diff the model reads, in characters. */
export const PATCH_CAP = 50_000;
/** The most of a log, a template, agent notes or a conversation, in characters. */
export const SUMMARY_CAP = 8_000;
/** The longest commit subject the prompt asks for. */
const SUBJECT_MAX = 72;

export interface GenerationPrompt {
  readonly system: string;
  readonly prompt: string;
  readonly jsonSchema: Record<string, unknown>;
}

/** What the style instruction is built from. */
export interface StyleContext {
  readonly style: WritingStyle;
  readonly customInstructions: string;
  /** The repository's most recent commit subjects, newest first. */
  readonly recentSubjects: ReadonlyArray<string>;
  /** AGENTS.md or CLAUDE.md at the workspace root, when there is one. */
  readonly agentNotes: string | null;
}

// ── Caps ───────────────────────────────────────────────────────

/**
 * `text` cut to `max` characters, with a line saying so. `head` keeps the
 * start (a diff, a first message); `tail` keeps the end (a conversation).
 */
export const capText = (text: string, max: number, keep: "head" | "tail" = "head"): string => {
  if (text.length <= max) {
    return text;
  }
  const note = `[… ${text.length - max} more characters left out]`;
  return keep === "head" ? `${text.slice(0, max)}\n${note}` : `${note}\n${text.slice(-max)}`;
};

// ── Style ──────────────────────────────────────────────────────

const PLAIN_STYLE =
  "Write a plain subject in the imperative mood, starting with a capital letter, " +
  'such as "Fix the login redirect" or "Add retries to the upload client".';

const CONVENTIONAL_STYLE =
  "Follow Conventional Commits: `type(scope): summary`, where type is one of feat, fix, " +
  "docs, style, refactor, perf, test, build, ci or chore, the scope is optional, and the " +
  "summary is lowercase and imperative.";

const repositoryStyle = (context: StyleContext): string => {
  const parts: Array<string> = [];
  if (context.recentSubjects.length > 0) {
    parts.push(
      "Match the style of this repository's recent commit subjects:\n" +
        capText(context.recentSubjects.map((subject) => `- ${subject}`).join("\n"), SUMMARY_CAP),
    );
  }
  if (context.agentNotes !== null && context.agentNotes.trim() !== "") {
    parts.push(
      "The repository's notes for agents (follow any commit or pull request rules in them):\n" +
        capText(context.agentNotes.trim(), SUMMARY_CAP),
    );
  }
  return parts.length === 0 ? PLAIN_STYLE : parts.join("\n\n");
};

/** The style instruction for commit and pull-request text. */
export const styleInstruction = (context: StyleContext): string => {
  switch (context.style) {
    case "conventional":
      return CONVENTIONAL_STYLE;
    case "custom": {
      const custom = context.customInstructions.trim();
      return custom === ""
        ? repositoryStyle(context)
        : `Follow these instructions from the user:\n${capText(custom, SUMMARY_CAP)}`;
    }
    case "repository":
      return repositoryStyle(context);
  }
};

// ── Schemas ────────────────────────────────────────────────────

/** An object of string fields, every one required and nothing else allowed. */
const stringObject = (...keys: ReadonlyArray<string>): Record<string, unknown> => ({
  type: "object",
  properties: Object.fromEntries(keys.map((key) => [key, { type: "string" }])),
  required: [...keys],
  additionalProperties: false,
});

const ANSWER_JSON = "Answer with one JSON object and nothing else — no code fence, no comment.";

// ── Commit message ─────────────────────────────────────────────

export interface CommitInput {
  readonly style: StyleContext;
  /** One line per changed file, as `git diff --name-status` prints it. */
  readonly files: ReadonlyArray<string>;
  readonly patch: string;
}

export const commitPrompt = (input: CommitInput): GenerationPrompt => ({
  system: [
    "You write git commit messages. You only read the change you are given; you never run tools.",
    `The subject is at most ${SUBJECT_MAX} characters, in the imperative mood, with no trailing period.`,
    'The body is either empty or a few short "- " bullets saying what changed and why. ' +
      "Leave it empty when the subject says it all.",
    styleInstruction(input.style),
    `${ANSWER_JSON} Shape: {"subject": string, "body": string}.`,
  ].join("\n\n"),
  prompt: [
    "Write the commit message for this change.",
    `Changed files:\n${capText(input.files.join("\n"), SUMMARY_CAP)}`,
    `Diff:\n${capText(input.patch, PATCH_CAP)}`,
  ].join("\n\n"),
  jsonSchema: stringObject("subject", "body"),
});

// ── Pull request ───────────────────────────────────────────────

/** The body's layout when the repository has no template, or it is not followed. */
export const DEFAULT_PR_LAYOUT = "## Summary\n\n## Testing";

export interface PullRequestInput {
  readonly style: StyleContext;
  readonly base: string;
  readonly branch: string | null;
  /** The branch's commits beyond the base: subjects and bodies, oldest last. */
  readonly commits: string;
  readonly patch: string;
  /** The repository's template, already read; null to use `DEFAULT_PR_LAYOUT`. */
  readonly template: string | null;
}

export const pullRequestPrompt = (input: PullRequestInput): GenerationPrompt => ({
  system: [
    "You write GitHub pull request titles and descriptions. You only read the change you are given; you never run tools.",
    "The title is one short line in the imperative mood, with no trailing period.",
    input.template === null
      ? `The body is Markdown laid out as:\n${DEFAULT_PR_LAYOUT}\nUnder Summary, a few bullets on what changed and why; under Testing, how it was or can be checked.`
      : "The body fills in the repository's pull request template below: keep its headings and checklists, " +
        `answer each part from the change, and leave out parts that do not apply.\n\nTemplate:\n${capText(input.template, SUMMARY_CAP)}`,
    styleInstruction(input.style),
    `${ANSWER_JSON} Shape: {"title": string, "body": string}.`,
  ].join("\n\n"),
  prompt: [
    `Write the pull request for merging ${input.branch ?? "this branch"} into ${input.base}.`,
    `Commits:\n${capText(input.commits.trim() === "" ? "(none)" : input.commits, SUMMARY_CAP)}`,
    `Diff against ${input.base}:\n${capText(input.patch, PATCH_CAP)}`,
  ].join("\n\n"),
  jsonSchema: stringObject("title", "body"),
});

// ── Thread title ───────────────────────────────────────────────

/** The longest title the prompt asks for, in characters. */
const TITLE_MAX = 40;

/**
 * A thread's title from its conversation: the first message for a new
 * thread, the end of the conversation for "Regenerate title".
 */
export const titlePrompt = (conversation: string): GenerationPrompt => ({
  system: [
    "You name chat threads about software work. You never run tools.",
    `The title is 3 to 8 words and under ${TITLE_MAX} characters, in sentence case, ` +
      "saying what the work is about. No quotes, no trailing period, no emoji.",
    `${ANSWER_JSON} Shape: {"title": string}.`,
  ].join("\n\n"),
  prompt: `Name the thread this conversation belongs to.\n\n${capText(conversation, SUMMARY_CAP, "tail")}`,
  jsonSchema: stringObject("title"),
});

// ── The pull request template ─────────────────────────────────

/** Where GitHub looks for a single template, in the order it looks. */
const TEMPLATE_DIRS = [".github", "", "docs"];
const TEMPLATE_FILE = "pull_request_template.md";
const TEMPLATE_DIR = "pull_request_template";

const entriesOf = (dir: string): ReadonlyArray<string> => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** A template's text; null when it is empty, unreadable or links out of `root`. */
const readTemplate = (root: string, path: string): string | null => {
  const inside = realPathInside(root, path);
  if (inside === null) return null;
  try {
    const text = readFileSync(inside, "utf8").trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
};

/**
 * The repository's pull request template, as GitHub finds it: a
 * `pull_request_template.md` in `.github/`, the root or `docs/` (any case),
 * else the first Markdown file of `.github/PULL_REQUEST_TEMPLATE/`. Null when
 * there is none, or it is empty. A template that links out of the repository
 * is never read.
 */
export const findPullRequestTemplate = (root: string): string | null => {
  for (const dir of TEMPLATE_DIRS) {
    const base = nodePath.join(root, dir);
    const name = entriesOf(base).find((entry) => entry.toLowerCase() === TEMPLATE_FILE);
    if (name !== undefined && isFile(nodePath.join(base, name))) {
      const text = readTemplate(root, nodePath.join(base, name));
      if (text !== null) return text;
    }
  }
  const github = nodePath.join(root, ".github");
  const folder = entriesOf(github).find((entry) => entry.toLowerCase() === TEMPLATE_DIR);
  if (folder === undefined) {
    return null;
  }
  const dir = nodePath.join(github, folder);
  for (const entry of entriesOf(dir)) {
    if (entry.toLowerCase().endsWith(".md") && isFile(nodePath.join(dir, entry))) {
      const text = readTemplate(root, nodePath.join(dir, entry));
      if (text !== null) return text;
    }
  }
  return null;
};
