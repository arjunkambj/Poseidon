import { UNANSWERED_OUTCOME, type ResolvedDecision } from "@poseidon/contracts/decisions";
import { describe, expect, it } from "vitest";

import { decisionDenied, decisionLabel } from "./decision-label";

const decision = (over: Partial<ResolvedDecision>): ResolvedDecision => ({
  kind: "approval",
  id: "req-1",
  outcome: "allow-once",
  resolvedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("decisionLabel", () => {
  it("says a card the runtime released was not answered, and not as a denial", () => {
    const released = decision({ outcome: UNANSWERED_OUTCOME, subject: "npm test" });
    expect(decisionLabel(released)).toBe("Not answered · npm test");
    expect(decisionDenied(released)).toBe(false);
    expect(
      decisionLabel(
        decision({ kind: "question", outcome: UNANSWERED_OUTCOME, subject: "Database" }),
      ),
    ).toBe("Not answered · Database");
  });

  it("names a one-off approval by its subject", () => {
    expect(decisionLabel(decision({ outcome: "allow-once", subject: "npm test" }))).toBe(
      "Allowed once · npm test",
    );
    expect(decisionLabel(decision({ outcome: "deny", subject: "rm -rf dist" }))).toBe(
      "Denied · rm -rf dist",
    );
  });

  it("names a rule-writing approval by the rule it saved", () => {
    const rule = { subject: "npm run build", pattern: "Shell(npm run *)" };
    expect(decisionLabel(decision({ outcome: "allow-session", ...rule }))).toBe(
      "Allowed for session · Shell(npm run *)",
    );
    expect(decisionLabel(decision({ outcome: "allow-always", ...rule }))).toBe(
      "Always allowed · Shell(npm run *)",
    );
  });

  it("falls back to the subject when a rule-writing approval has no pattern", () => {
    expect(decisionLabel(decision({ outcome: "allow-always", subject: "Read" }))).toBe(
      "Always allowed · Read",
    );
  });

  it("drops the separator when there is nothing to name", () => {
    expect(decisionLabel(decision({ outcome: "allow-once" }))).toBe("Allowed once");
    expect(decisionLabel(decision({ outcome: "deny", subject: "" }))).toBe("Denied");
  });

  it("names an answered question by what it asked", () => {
    const question = { kind: "question", outcome: "answered" } as const;
    expect(decisionLabel(decision({ ...question, subject: "Which database?" }))).toBe(
      "Answered · Which database?",
    );
    expect(decisionLabel(decision(question))).toBe("Answered");
  });

  it("reads each plan response", () => {
    const plan = { kind: "plan", id: "turn-1", subject: "plan.md" } as const;
    expect(decisionLabel(decision({ ...plan, outcome: "accept" }))).toBe("Plan accepted");
    expect(decisionLabel(decision({ ...plan, outcome: "accept-auto" }))).toBe(
      "Plan accepted with auto-edits",
    );
    expect(decisionLabel(decision({ ...plan, outcome: "revise" }))).toBe("Revision requested");
    expect(decisionLabel(decision({ ...plan, outcome: "handoff" }))).toBe(
      "Plan handed to a new thread",
    );
  });

  it("keeps an outcome it does not know readable", () => {
    expect(decisionLabel(decision({ outcome: "allow-forever", subject: "ls" }))).toBe(
      "Allow forever · ls",
    );
    expect(decisionLabel(decision({ kind: "plan", outcome: "" }))).toBe("Answered");
  });
});

describe("decisionDenied", () => {
  it("is true only for a denied approval", () => {
    expect(decisionDenied(decision({ outcome: "deny" }))).toBe(true);
    expect(decisionDenied(decision({ outcome: "allow-once" }))).toBe(false);
    expect(decisionDenied(decision({ kind: "plan", outcome: "revise" }))).toBe(false);
  });
});
