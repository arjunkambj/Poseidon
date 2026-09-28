/**
 * One turn's prompt and argv.
 *
 * Print mode has no image flag, so attachments are staged under
 * `<attachmentsDir>/<threadId>/`, that directory joins the run's scope through
 * `--add-dir`, and the prompt names the absolute paths.
 * Mentions become `@name` lines and skill references `Use the "<name>" skill.`
 * lines (`fixtures/cmd/skill/`); a reference to one of the session's Poseidon
 * plugins becomes `Use the "<name>" plugin.`, any other plugin is left out
 * with a warning. The enabled plugins' skill directories go on the argv as
 * `--skill <dir>`, which is how Command Code loads them. Everything else is
 * `buildArgs`.
 *
 * `--yolo` goes on every ordinary turn: print mode refuses writes and shell
 * without it whatever a hook answered (`fixtures/cmd/shell-allow/`), while a
 * deny still stops the call under it — recorded under this exact argv in
 * `fixtures/cmd/shell-deny-yolo/`. A plan turn is the exception and does not
 * carry it; see below.
 */

import type { Effort } from "@poseidon/contracts/enums";
import type { ThreadId } from "@poseidon/contracts/ids";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import type { TurnReference } from "@poseidon/contracts/runtime";
import type { TurnInput } from "@poseidon/connector-sdk/definition";
import type { SessionPlugin } from "@poseidon/connector-sdk/plugins";

import { stageTurnAttachments } from "./attachments";
import { buildArgs, TOOLS_ENABLED } from "./spawn";

export interface PreparedTurn {
  readonly args: ReadonlyArray<string>;
  /**
   * Attachment problems, and references the harness cannot take, worth
   * telling the user about.
   */
  readonly warnings: ReadonlyArray<string>;
  /** Spawned with `--permission-mode plan`. */
  readonly plan: boolean;
}

/**
 * The contract's effort, as a rung Command Code takes. Its ladder starts at
 * `low`: no model it lists offers `minimal`, and the CLI exits 1 on an effort
 * the model does not support, so the contract's lowest rung maps onto its
 * lowest instead of failing the turn.
 */
export const cmdEffort = (effort: Effort): string => (effort === "minimal" ? "low" : effort);

/**
 * A turn's skill and plugin references, as prompt lines and warnings.
 *
 * A skill becomes one sentence naming it, quoted, after the user's text. The
 * text itself carries the composer's draft token for it, which the harness
 * gives no meaning to; the sentence is what the model acts on, and
 * `fixtures/cmd/skill/` records it calling `activate_skill` for exactly that
 * skill. A repeated reference is named once.
 *
 * Command Code has no plugins of its own; the only ones it has are the
 * session's Poseidon plugins, whose skills its argv loads. A reference to one
 * of those is one more sentence naming it. Any other plugin reference is not
 * written as text the harness could not resolve: it is left out, and the user
 * is told.
 */
const referenceParts = (
  references: ReadonlyArray<TurnReference>,
  sessionPlugins: ReadonlyArray<SessionPlugin>,
): { readonly lines: ReadonlyArray<string>; readonly warnings: ReadonlyArray<string> } => {
  const loaded = new Set(sessionPlugins.map((plugin) => plugin.name));
  const skills = new Set<string>();
  const plugins = new Set<string>();
  for (const reference of references) {
    (reference.kind === "skill" ? skills : plugins).add(reference.name);
  }
  const known = [...plugins].filter((name) => loaded.has(name));
  return {
    lines: [
      ...[...skills].map((name) => `Use the ${JSON.stringify(name)} skill.`),
      ...known.map((name) => `Use the ${JSON.stringify(name)} plugin.`),
    ],
    warnings: [...plugins]
      .filter((name) => !loaded.has(name))
      .map(
        (name) =>
          `the plugin "${name}" was left out of the prompt: it is not a Poseidon plugin enabled for this session`,
      ),
  };
};

export const prepareTurn = async (input: {
  readonly turn: TurnInput;
  readonly settings: ThreadSettings;
  readonly attachmentsDir: string;
  readonly threadId: ThreadId;
  /** The session to resume, or null to let the harness open a new one. */
  readonly resumeSessionId: string | null;
  /** The session's enabled Poseidon plugins; absent means none. */
  readonly plugins?: ReadonlyArray<SessionPlugin>;
}): Promise<PreparedTurn> => {
  const plugins = input.plugins ?? [];
  const skills = [...new Set(plugins.flatMap((plugin) => plugin.skillsDirs))];
  const attached = await stageTurnAttachments({
    attachmentsDir: input.attachmentsDir,
    threadId: input.threadId,
    attachments: input.turn.attachments,
  });
  const mentioned = input.turn.mentions.map((mention) => `@${mention}`);
  const referenced = referenceParts(input.turn.references ?? [], plugins);
  const prompt = [input.turn.text, ...mentioned, ...referenced.lines, ...attached.promptLines]
    .filter((part) => part.length > 0)
    .join("\n\n");
  const plan = input.settings.interactionMode === "plan";
  return {
    plan,
    warnings: [...referenced.warnings, ...attached.warnings],
    args: buildArgs({
      prompt,
      model: input.settings.model,
      ...(input.settings.effort === undefined ? {} : { effort: cmdEffort(input.settings.effort) }),
      ...(input.resumeSessionId === null ? {} : { sessionId: input.resumeSessionId }),
      // Not in plan mode. `--yolo` turns off print mode's own refusal of
      // writes and shell calls, and in plan mode PreToolUse never fires —
      // `hookCount: 0` in all four plan recordings, including one whose
      // `read_file` fires a hook in an ordinary run — so under both together
      // a mode the UI labels "Plan first" had no enforcement of any kind:
      // not the user's deny rules, not the ladder's own "plan mode is
      // read-only", not the sensitive-path prompt. Nothing but the model's
      // compliance. Without `--yolo` the CLI refuses every write and every
      // shell call itself (`fixtures/cmd/plan-no-yolo/`), which is what the
      // mode claims to be — and the plan survives, because the body of the
      // refused `write_file` is in the frame that announced it (`plans.ts`).
      yolo: !plan,
      ...(plan ? { permissionMode: "plan" as const } : {}),
      ...(attached.addDirs.length === 0 ? {} : { addDir: attached.addDirs }),
      toolsEnable: TOOLS_ENABLED,
      ...(skills.length === 0 ? {} : { skills }),
    }),
  };
};
