/**
 * Every brand logo the renderer draws, and the keys that pick one. This
 * directory is the one renderer path the neutrality gate lets name a harness
 * (docs/development.md, "Renderer neutrality"), so the connector words stay
 * here: the rest of the renderer passes a connector's `metadata.iconKey`, an
 * editor or a model's id and family, and draws whatever comes back.
 *
 * Every lookup falls back cleanly. A key this build does not know draws a
 * generic glyph in a heading, and nothing (the caller's monogram) in an
 * avatar or beside a model name. Map keys are written unquoted on purpose:
 * a quoted connector kind is refused anywhere in the renderer.
 *
 * A logo is drawn in its brand colours (`*Color`) wherever Honeyicons ships
 * them; those are exempt from the bold-icon gate. A logo with no colour
 * variant is monochrome and drawn with `variant="bold"` like every other icon.
 */

import type { DetectedEditor, EditorId } from "@poseidon/contracts/editors";
import {
  ClaudeAiColor,
  ClaudeCodeColor,
  Code,
  CodexColor,
  Cursor,
  DeepseekColor,
  FolderOpen,
  GeminiColor,
  GoogleColor,
  type HoneyIcon,
  KimiColor,
  MetaColor,
  MistralColor,
  NvidiaColor,
  Openai,
  QwenColor,
  Server,
  Terminal,
  Windsurf,
  Xai,
  Zai,
  ZedColor,
} from "@honeyicons/react";

const lookup = <T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined =>
  key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;

// ── Connectors ─────────────────────────────────────────────────

/** A connector's `iconKey` → its colour logo, for an avatar or a heading. */
const HARNESS_LOGOS: Readonly<Record<string, HoneyIcon>> = {
  "claude-code": ClaudeCodeColor,
  codex: CodexColor,
};

/** A connector's `iconKey` → the icon for a heading or a card. */
const CONNECTOR_ICONS: Readonly<Record<string, HoneyIcon>> = {
  ...HARNESS_LOGOS,
  terminal: Terminal,
  server: Server,
};

/**
 * The icon a heading draws for a connector: its logo when the key names one,
 * the generic glyph it names otherwise, and the server glyph for a key this
 * build does not know.
 */
export const connectorIconFor = (iconKey: string | undefined): HoneyIcon =>
  lookup(CONNECTOR_ICONS, iconKey) ?? Server;

/**
 * The colour logo an avatar draws for a connector, or `undefined` when the
 * key names no logo (a generic glyph, or a key this build does not know), so
 * the avatar keeps its monogram.
 */
export const harnessLogoFor = (iconKey: string | undefined): HoneyIcon | undefined =>
  lookup(HARNESS_LOGOS, iconKey);

// ── Editors ────────────────────────────────────────────────────

/**
 * The apps Honeyicons has a logo for. Cursor and Windsurf ship no colour
 * variant, so they are monochrome; VS Code, Sublime, the file manager and the
 * terminal have no logo at all.
 */
const EDITOR_LOGOS: Partial<Readonly<Record<EditorId, HoneyIcon>>> = {
  cursor: Cursor,
  windsurf: Windsurf,
  zed: ZedColor,
};

/** An app's logo when one exists, else a glyph for its kind. */
export const editorIconFor = (editor: DetectedEditor): HoneyIcon => {
  const logo = EDITOR_LOGOS[editor.id];
  if (logo !== undefined) return logo;
  if (editor.kind === "file-manager") return FolderOpen;
  if (editor.kind === "terminal") return Terminal;
  return Code;
};

// ── Model providers ────────────────────────────────────────────

/**
 * A model's provider key: the prefix of an id such as `qwen/qwen3.8-max`, or
 * else its family (the header its list came under) lowercased with anything
 * but letters and digits dropped, so `"OpenAI"` reads `openai`. The label is
 * never read; a connector may rename it.
 */
export const providerKey = (modelId: string, family: string): string => {
  const slash = modelId.indexOf("/");
  const raw = slash > 0 ? modelId.slice(0, slash) : family;
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
};

/**
 * Whether a harness's models come from more than one provider, by their
 * `providerKey`s. Only then does a model row lead with its provider's mark: a
 * harness whose every model shares one family (one maker) needs no marks.
 */
export const spansProviders = (
  models: ReadonlyArray<{ readonly id: string; readonly family: string }>,
): boolean => new Set(models.map((model) => providerKey(model.id, model.family))).size > 1;

/**
 * Provider keys → their mark. The keys are the id prefixes and family headers
 * the recorded model lists carry (normalised as `providerKey` does), with the
 * spellings one provider goes by folded together. Anthropic's models draw
 * Claude's mark and Gemini's its own; OpenAI, xAI and Z.ai ship no colour
 * variant, so theirs stay monochrome.
 */
const PROVIDER_MARKS: Readonly<Record<string, HoneyIcon>> = {
  anthropic: ClaudeAiColor,
  deepseek: DeepseekColor,
  gemini: GeminiColor,
  google: GoogleColor,
  kimi: KimiColor,
  meta: MetaColor,
  mistral: MistralColor,
  mistralai: MistralColor,
  moonshotai: KimiColor,
  nvidia: NvidiaColor,
  openai: Openai,
  qwen: QwenColor,
  xai: Xai,
  zai: Zai,
  zaiorg: Zai,
};

/** A provider's mark, or `undefined` for one Honeyicons has no logo for. */
export const providerMarkFor = (key: string | undefined): HoneyIcon | undefined =>
  lookup(PROVIDER_MARKS, key);
