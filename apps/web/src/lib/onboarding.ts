/**
 * First-run setup as values: when it opens on its own, which steps it has,
 * and what a harness row says about its probe. Pure, so the rules are tested
 * without a DOM; the dialog is `@/components/onboarding/onboarding-dialog`.
 */

import type { ConnectorSummary } from "@poseidon/contracts/connectors";
import type { Settings } from "@poseidon/contracts/settings";

import { probeHealthState } from "@/lib/connector-health";

/**
 * Whether setup opens by itself: only once the project list and the settings
 * have both answered (`null` until then — an empty list while loading would
 * open it on every boot), with no projects and setup never finished or
 * skipped. An install from before setup existed decodes as finished.
 */
export const shouldOpenOnboarding = (
  projects: ReadonlyArray<unknown> | null,
  settings: Pick<Settings, "onboardingCompleted"> | null,
): boolean =>
  projects !== null && settings !== null && projects.length === 0 && !settings.onboardingCompleted;

export type OnboardingStep = "harnesses" | "theme" | "project" | "import";

/**
 * The steps, in order. Import is there only when there is something to
 * import: kept while the list is still loading (`null`), left out once it has
 * answered empty — or failed, which the caller passes as 0.
 */
export const onboardingSteps = (importable: number | null): ReadonlyArray<OnboardingStep> =>
  importable === 0
    ? ["harnesses", "theme", "project"]
    : ["harnesses", "theme", "project", "import"];

/**
 * What a harness row says under its name: whether the probe found the
 * harness, its version, and that it is signed in — only what the probe
 * reported. Not being signed in is the status badge's to say, so it is not
 * repeated here. Nothing while it is still probing; the row shows a spinner.
 */
export const harnessFacts = (summary: ConnectorSummary): ReadonlyArray<string> => {
  const { probe } = summary;
  const state = probeHealthState(probe);
  if (state === "probing") {
    return [];
  }
  if (state === "not-installed" || probe.installed === false) {
    return ["Not installed"];
  }
  const facts = ["Installed"];
  if (probe.version !== undefined) {
    facts.push(`v${probe.version}`);
  }
  if (state !== "signed-out" && (probe.auth === "present" || probe.authenticated === true)) {
    facts.push(
      probe.account === undefined || probe.account === ""
        ? "Signed in"
        : `Signed in as ${probe.account}`,
    );
  }
  return facts;
};

/** The id and tab name of the script a harness's setup command runs as. */
export const setupScript = (summary: ConnectorSummary, command: string) => ({
  id: `setup:${summary.connectorInstanceId}`,
  name: `${summary.displayName} setup`,
  command,
});
