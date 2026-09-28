import type { ConnectorProbe, ConnectorSummary } from "@poseidon/contracts/connectors";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "vitest";

import { harnessFacts, onboardingSteps, setupScript, shouldOpenOnboarding } from "./onboarding";

const summary = (probe: Omit<ConnectorProbe, "probedAt">): ConnectorSummary => ({
  connectorInstanceId: "0199c0de-0001-7000-8000-000000000001" as ConnectorInstanceId,
  kind: "harness",
  displayName: "Harness",
  enabled: true,
  capabilities: null,
  extensions: { skills: false, plugins: false, mcpServers: false },
  probe: { ...probe, probedAt: "2026-09-28T00:00:00.000Z" },
});

describe("shouldOpenOnboarding", () => {
  const fresh = { onboardingCompleted: false };

  it("opens a fresh install once both lists have answered", () => {
    expect(shouldOpenOnboarding([], fresh)).toBe(true);
  });

  it("waits for the projects and the settings to load", () => {
    expect(shouldOpenOnboarding(null, fresh)).toBe(false);
    expect(shouldOpenOnboarding([], null)).toBe(false);
  });

  it("stays shut once setup was finished or skipped, or a project exists", () => {
    expect(shouldOpenOnboarding([], { onboardingCompleted: true })).toBe(false);
    expect(shouldOpenOnboarding([{ projectId: "p" }], fresh)).toBe(false);
  });
});

describe("onboardingSteps", () => {
  it("keeps Import while the list loads or has sessions", () => {
    expect(onboardingSteps(null)).toEqual(["harnesses", "theme", "project", "import"]);
    expect(onboardingSteps(3)).toEqual(["harnesses", "theme", "project", "import"]);
  });

  it("leaves Import out when there is nothing to import", () => {
    expect(onboardingSteps(0)).toEqual(["harnesses", "theme", "project"]);
  });
});

describe("harnessFacts", () => {
  it("says nothing while probing", () => {
    expect(harnessFacts(summary({ status: "probing" }))).toEqual([]);
  });

  it("says a missing harness is not installed", () => {
    expect(
      harnessFacts(summary({ status: "not-installed", installCommand: "npm install -g harness" })),
    ).toEqual(["Not installed"]);
  });

  it("gives the version and the account of a signed-in harness", () => {
    expect(
      harnessFacts(
        summary({ status: "ready", version: "1.2.3", auth: "present", account: "a@b.c" }),
      ),
    ).toEqual(["Installed", "v1.2.3", "Signed in as a@b.c"]);
    expect(harnessFacts(summary({ status: "ready", authenticated: true }))).toEqual([
      "Installed",
      "Signed in",
    ]);
  });

  it("leaves a signed-out harness's sign-in to the badge", () => {
    expect(harnessFacts(summary({ status: "ready", version: "2.0.0", auth: "absent" }))).toEqual([
      "Installed",
      "v2.0.0",
    ]);
  });

  it("claims no sign-in the probe did not report", () => {
    expect(harnessFacts(summary({ status: "ready", auth: "unknown" }))).toEqual(["Installed"]);
    expect(harnessFacts(summary({ status: "error", message: "boom" }))).toEqual(["Installed"]);
  });
});

describe("setupScript", () => {
  it("keys the script by instance and names the tab after the harness", () => {
    expect(setupScript(summary({ status: "not-installed" }), "npm install -g harness")).toEqual({
      id: "setup:0199c0de-0001-7000-8000-000000000001",
      name: "Harness setup",
      command: "npm install -g harness",
    });
  });
});
