import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import type { ConnectorSummary } from "@poseidon/contracts/connectors";
import { describe, expect, it } from "vitest";

import { instanceCapabilities, threadConnectorInstanceId } from "./connector-routing";

const instance = (id: string, enabled: boolean): ConnectorSummary => ({
  connectorInstanceId: id as ConnectorInstanceId,
  kind: "harness",
  displayName: id,
  enabled,
  capabilities: null,
  extensions: { skills: false, plugins: false, mcpServers: false },
  probe: { status: "ready", probedAt: "2026-09-18T00:00:00.000Z" },
});

const id = (value: string) => value as ConnectorInstanceId;

describe("threadConnectorInstanceId", () => {
  it("uses the bound session's instance once there is one", () => {
    expect(
      threadConnectorInstanceId(id("bound"), id("chosen"), [
        instance("first", true),
        instance("chosen", true),
        instance("bound", true),
      ]),
    ).toBe("bound");
  });

  it("uses the thread's chosen instance before the first turn", () => {
    expect(
      threadConnectorInstanceId(null, id("b"), [instance("a", true), instance("b", true)]),
    ).toBe("b");
  });

  it("falls back to the first enabled instance when the thread chose none", () => {
    // The regression: a thread binds a session only on its first turn, and
    // until then the header picker and `/model` asked for a null instance and
    // got an empty model list.
    expect(threadConnectorInstanceId(null, null, [instance("a", true), instance("b", true)])).toBe(
      "a",
    );
  });

  it("falls back when the chosen instance is disabled or gone", () => {
    const connectors = [instance("a", true), instance("off", false)];
    expect(threadConnectorInstanceId(null, id("off"), connectors)).toBe("a");
    expect(threadConnectorInstanceId(undefined, id("removed"), connectors)).toBe("a");
  });

  it("skips disabled instances, the way the server's routing does", () => {
    expect(
      threadConnectorInstanceId(null, undefined, [
        instance("off", false),
        instance("on", true),
        instance("later", true),
      ]),
    ).toBe("on");
  });

  it("passes over an instance whose probe says it cannot run, as the server does", () => {
    const probedAt = "2026-10-01T00:00:00.000Z";
    const probed = (name: string, probe: ConnectorSummary["probe"]) => ({
      ...instance(name, true),
      probe,
    });
    const missing = probed("missing", { status: "not-installed", probedAt });
    const signedOut = probed("signed-out", { status: "ready", probedAt, auth: "absent" });
    const broken = probed("broken", { status: "ready", probedAt, installed: false });
    // A probe that timed out or crashed found nothing, so it moves nothing.
    const timedOut = probed("timed-out", { status: "error", probedAt, installed: false });

    expect(
      threadConnectorInstanceId(null, null, [missing, signedOut, instance("next", true)]),
    ).toBe("next");
    expect(threadConnectorInstanceId(null, null, [broken, instance("next", true)])).toBe("next");
    expect(threadConnectorInstanceId(null, null, [timedOut, instance("next", true)])).toBe(
      "timed-out",
    );
    // Nothing can run: the first enabled one, whose banner says what to fix.
    expect(threadConnectorInstanceId(null, null, [missing, signedOut])).toBe("missing");
    // A thread that chose one keeps it; a probe still running moves nothing.
    expect(threadConnectorInstanceId(null, id("missing"), [missing, instance("next", true)])).toBe(
      "missing",
    );
    expect(
      threadConnectorInstanceId(null, null, [
        probed("probing", { status: "probing", probedAt }),
        instance("next", true),
      ]),
    ).toBe("probing");
  });

  it("answers null when nothing is configured or everything is off", () => {
    expect(threadConnectorInstanceId(null, null, [])).toBeNull();
    expect(threadConnectorInstanceId(undefined, id("off"), [instance("off", false)])).toBeNull();
  });
});

describe("instanceCapabilities", () => {
  const capabilities = {
    modelSwitch: "per-turn",
    effortSwitch: "per-turn",
    steering: false,
    planMode: true,
    subagents: false,
    images: false,
    resume: true,
    fork: false,
    interrupt: "turn",
    rollback: false,
    compaction: false,
    questions: false,
    runtimeModes: ["approval-required"],
    attachments: "images",
  } as const;

  it("reads the instance's capabilities", () => {
    expect(
      instanceCapabilities(id("a"), [
        { ...instance("a", true), capabilities },
        instance("b", true),
      ]),
    ).toEqual(capabilities);
  });

  it("answers null while the instance has reported none, or there is no instance", () => {
    expect(instanceCapabilities(id("a"), [instance("a", true)])).toBeNull();
    expect(instanceCapabilities(null, [{ ...instance("a", true), capabilities }])).toBeNull();
  });
});
