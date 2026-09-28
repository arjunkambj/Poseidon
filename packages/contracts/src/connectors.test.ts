import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ModelOption } from "./connectors";

const base = { id: "model-1", label: "Model 1", family: "Family", efforts: ["low", "high"] };

describe("ModelOption", () => {
  it.effect("decodes a payload recorded before `hidden` existed", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(ModelOption)(base);
      expect(decoded).toEqual(base);
      expect(decoded.hidden).toBeUndefined();
    }),
  );

  it.effect("decodes a model its connector marks hidden", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(ModelOption)({ ...base, hidden: true });
      expect(decoded.hidden).toBe(true);
    }),
  );

  it.effect("rejects a `hidden` that is not a boolean", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Schema.decodeUnknownEffect(ModelOption)({ ...base, hidden: "yes" }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("decodes a payload recorded before `description` existed", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(ModelOption)(base);
      expect(decoded).toEqual(base);
      expect(decoded.description).toBeUndefined();
    }),
  );

  it.effect("decodes a model with its tagline as `description`", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(ModelOption)({
        ...base,
        id: "google/gemini-3.5-flash",
        label: "Gemini 3.5 Flash",
        description: "Pro-level coding proficiency, parallel agentic execution",
      });
      expect(decoded.label).toBe("Gemini 3.5 Flash");
      expect(decoded.description).toBe("Pro-level coding proficiency, parallel agentic execution");
    }),
  );

  it.effect("rejects a `description` that is not a string", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Schema.decodeUnknownEffect(ModelOption)({ ...base, description: 42 }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("rejects an empty `description`", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Schema.decodeUnknownEffect(ModelOption)({ ...base, description: "" }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});
