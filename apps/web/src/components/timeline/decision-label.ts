/**
 * The words on a decision row: what was chosen, then what it was about —
 * "Allowed once · npm test", "Allowed for session · Shell(npm run *)",
 * "Answered · Which database?", "Plan accepted". A rule-writing approval names
 * the rule it saved rather than the one request, since the rule is what keeps
 * applying; a plan's record needs no subject, the plan sits just above it. A
 * card the runtime released as its process exited reads "Not answered · …",
 * muted: the request was refused, but the user chose nothing.
 */

import type { ResolvedDecision } from "@poseidon/contracts/decisions";
import { UNANSWERED_OUTCOME } from "@poseidon/contracts/decisions";

const APPROVAL_LABEL: Readonly<Record<string, string>> = {
  "allow-once": "Allowed once",
  "allow-session": "Allowed for session",
  "allow-always": "Always allowed",
  deny: "Denied",
};

const PLAN_LABEL: Readonly<Record<string, string>> = {
  accept: "Plan accepted",
  "accept-auto": "Plan accepted with auto-edits",
  revise: "Revision requested",
  handoff: "Plan handed to a new thread",
};

/** An outcome this build does not know yet, readable rather than raw: "allow-x" → "Allow x". */
const fallbackLabel = (outcome: string): string => {
  const words = outcome.replaceAll("-", " ").trim();
  return words.length === 0 ? "Answered" : words.charAt(0).toUpperCase() + words.slice(1);
};

const withTarget = (lead: string, target: string | undefined): string =>
  target === undefined || target.length === 0 ? lead : `${lead} · ${target}`;

export const decisionLabel = (decision: ResolvedDecision): string => {
  if (decision.outcome === UNANSWERED_OUTCOME && decision.kind !== "plan") {
    return withTarget("Not answered", decision.subject);
  }
  switch (decision.kind) {
    case "approval": {
      const lead = APPROVAL_LABEL[decision.outcome] ?? fallbackLabel(decision.outcome);
      const savesRule = decision.outcome === "allow-session" || decision.outcome === "allow-always";
      return withTarget(
        lead,
        savesRule ? (decision.pattern ?? decision.subject) : decision.subject,
      );
    }
    case "question":
      return withTarget("Answered", decision.subject);
    case "plan":
      return PLAN_LABEL[decision.outcome] ?? fallbackLabel(decision.outcome);
  }
};

/** A refused request reads as destructive; every other record stays muted. */
export const decisionDenied = (decision: ResolvedDecision): boolean =>
  decision.kind === "approval" && decision.outcome === "deny";
