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
});
