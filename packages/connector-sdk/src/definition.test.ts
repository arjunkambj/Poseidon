import { describe, expect, it } from "@effect/vitest";

import { makeConnectorInstanceId } from "@poseidon/contracts/ids";
import * as Effect from "effect/Effect";

import type { ConnectorError, ConnectorProbe } from "./definition";
import { GenerationFailed, toWireProbe } from "./definition";

const base: ConnectorProbe = {
  status: "ready",
  probedAt: new Date(0).toISOString(),
  installed: true,
  auth: "present",
  models: [
    { id: "acme/one", label: "One", family: "acme", efforts: ["low"] },
    { id: "acme/two", label: "Two", family: "acme", efforts: ["low"] },
  ],
  warnings: ["an old build"],
};

describe("toWireProbe", () => {
  it("carries installed, derives authenticated from auth, and counts the models", () => {
    expect(toWireProbe(base)).toEqual({
      status: "ready",
      probedAt: base.probedAt,
      installed: true,
      auth: "present",
      authenticated: true,
      modelCount: 2,
    });
  });

  it("reports absent credentials as not authenticated", () => {
    const wire = toWireProbe({ ...base, status: "not-authenticated", auth: "absent" });
    expect(wire.authenticated).toBe(false);
  });

  it("leaves authenticated out when the probe could not tell", () => {
    const wire = toWireProbe({ ...base, status: "error", installed: false, auth: "unknown" });
    expect(wire.installed).toBe(false);
    expect("authenticated" in wire).toBe(false);
  });

  it("passes the connector's own commands through, and only when it named them", () => {
    const wire = toWireProbe({
      ...base,
      status: "not-authenticated",
      auth: "absent",
      loginCommand: "harness login",
      installCommand: "harness install",
    });
    expect(wire.loginCommand).toBe("harness login");
    expect(wire.installCommand).toBe("harness install");
    expect("loginCommand" in toWireProbe(base)).toBe(false);
    expect("installCommand" in toWireProbe(base)).toBe(false);
  });

  it("keeps models and warnings server-side", () => {
    const wire = toWireProbe(base) as Record<string, unknown>;
    expect(wire.models).toBeUndefined();
    expect(wire.warnings).toBeUndefined();
  });
});

describe("GenerationFailed", () => {
  it.effect("is a ConnectorError a caller can tell apart by its tag", () =>
    Effect.gen(function* () {
      const failed: ConnectorError = new GenerationFailed({
        kind: "acme",
        instanceId: makeConnectorInstanceId(),
        message: "the answer was not JSON",
      });
      const error = yield* Effect.flip(Effect.fail(failed));
      expect(error._tag).toBe("GenerationFailed");
      expect(error.message).toBe("the answer was not JSON");
    }),
  );
});
