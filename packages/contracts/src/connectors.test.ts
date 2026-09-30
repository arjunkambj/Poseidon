import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ModelOption, probeCanRun, type ConnectorProbe } from "./connectors";

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

describe("probeCanRun", () => {
  it("rules out a harness that is not installed or is signed out", () => {
    expect(probeCanRun({ status: "not-installed" })).toBe(false);
    expect(probeCanRun({ status: "not-authenticated" })).toBe(false);
    // A probe that could not run at all found nothing installed.
    expect(probeCanRun({ status: "error", installed: false })).toBe(false);
    // Ready, but the harness reported no credentials.
    expect(probeCanRun({ status: "ready", installed: true, auth: "absent" })).toBe(false);
  });

  it("counts a probe still running, or one that could not tell, as able", () => {
    expect(probeCanRun({ status: "probing" })).toBe(true);
    expect(probeCanRun({ status: "ready", installed: true, auth: "unknown" })).toBe(true);
    expect(probeCanRun({ status: "error", installed: true, auth: "present" })).toBe(true);
    // The wire's probe, which also carries `authenticated`, reads the same.
    const wire: ConnectorProbe = {
      status: "ready",
      probedAt: "2026-10-01T00:00:00.000Z",
      installed: true,
      authenticated: true,
      auth: "present",
    };
    expect(probeCanRun(wire)).toBe(true);
  });
});
