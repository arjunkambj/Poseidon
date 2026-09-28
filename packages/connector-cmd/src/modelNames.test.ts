/**
 * `modelNameFromId` against REAL ids from the recorded `cmd --list-models`
 * tables (`fixtures/cmd/probe/list-models.stdout.txt`, 1.55.1, and
 * `fixtures/cmd/probe-list-models-1.66.0.stdout.txt`). Each expected name is
 * the CLI's own name for the model where its catalogue has one, except for the
 * "(Free)" suffix on `-free` ids, which keeps them apart from a paid twin.
 */

import { describe, expect, it } from "@effect/vitest";

import { modelNameFromId } from "./modelNames";

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["google/gemini-3.5-flash", "Gemini 3.5 Flash"],
  ["google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"],
  ["meta/muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor"],
  ["xai/grok-4.5", "Grok 4.5"],
  ["claude-opus-4-8", "Claude Opus 4.8"],
  // Joined by position: an indexOf-based join read this as "Claude Opus 5 5".
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
  ["claude-fable-5-1", "Claude Fable 5.1"],
  ["gpt-5.4-mini", "GPT-5.4 Mini"],
  ["gpt-6-astra", "GPT-6 Astra"],
  ["gpt-5.3-codex", "GPT-5.3 Codex"],
  ["zai-org/glm-5.2-fast", "GLM-5.2 Fast"],
  ["zai-org/glm-5", "GLM-5"],
  ["deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
  ["moonshotai/kimi-k2.5", "Kimi K2.5"],
  ["qwen/qwen3.8-max-0902", "Qwen 3.8 Max 0902"],
  ["qwen/qwen3.8-27b", "Qwen 3.8 27B"],
  ["minimaxai/minimax-m2.7", "MiniMax M2.7"],
  ["xiaomi/mimo-v2.5-pro", "MiMo V2.5 Pro"],
  ["stepfun/step-3.5-flash", "Step 3.5 Flash"],
  ["thinkingmachines/inkling-small", "Inkling Small"],
  ["stealth/space-bunny-alpha", "Space Bunny Alpha"],
  ["meituan/longcat-2.0", "LongCat 2.0"],
  ["meituan/longcat-2.0:free", "LongCat 2.0 (Free)"],
  ["poolside/laguna-s-2.1-free", "Laguna S 2.1 (Free)"],
  ["inclusionai/ling-3.0-flash-sante:free", "Ling 3.0 Flash Sante (Free)"],
];

describe("modelNameFromId", () => {
  it.each(CASES)("%s → %s", (id, name) => {
    expect(modelNameFromId(id)).toBe(name);
  });

  it("keeps a model and its :free twin apart", () => {
    expect(modelNameFromId("meituan/longcat-2.0")).not.toBe(
      modelNameFromId("meituan/longcat-2.0:free"),
    );
  });

  it("reads upper-case ids the same way", () => {
    expect(modelNameFromId("Qwen/Qwen3.8-27B")).toBe("Qwen 3.8 27B");
  });

  it("falls back to the id when nothing readable is left", () => {
    expect(modelNameFromId("acme/-")).toBe("acme/-");
  });
});
