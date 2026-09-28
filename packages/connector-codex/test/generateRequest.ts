/**
 * The one request `fixtures/codex/generate-text/` was recorded with
 * (`recordGenerateText.test.ts`), which its replay sends again: a thread
 * title as JSON, on the CLI's default model at effort low.
 */

import type { GenerateTextInput } from "@poseidon/connector-sdk/definition";

export const GENERATE_REQUEST = {
  system: "You name chat threads. Answer with a title of 3 to 8 words.",
  prompt: "First message: fix the flaky login test",
  model: "default",
  effort: "low",
  jsonSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
    additionalProperties: false,
  },
} as const satisfies GenerateTextInput;
