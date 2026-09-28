/**
 * A pull request's look, decided once for the sidebar row's glyph
 * (`@/components/sidebar/thread-pr-mark`) and the Pull request tab's state
 * badge (`@/components/panes/pull-request/pr-summary`), so the two never
 * disagree about what a pull request is in.
 *
 * Five tones, on the theme's tokens only:
 *
 * - failing — open (draft or not) with a failing check: the destructive tint
 *   outranks the state, because it is the one the user has to act on;
 * - draft — muted, it is not asking for anything yet;
 * - open — the added tint (there is no success token);
 * - merged — the merge glyph in the primary accent;
 * - closed — the removed tint.
 */

import type { PullRequestMark, PullRequestState } from "@poseidon/contracts/pullRequest";
import { type HoneyIcon, GitMerge, GitPullRequest } from "@honeyicons/react";

export type PullRequestToneKind = "failing" | "draft" | "open" | "merged" | "closed";

export interface PullRequestTone {
  readonly kind: PullRequestToneKind;
  readonly icon: HoneyIcon;
  /** The state as a word: Open, Draft, Merged or Closed. */
  readonly state: string;
  /** The state, or "Checks failing" when that is what the tint says. */
  readonly label: string;
  /** Text colour class for the icon. */
  readonly tone: string;
}

/** What decides the look: the mark carries all three, a detail derives `failing`. */
export interface PullRequestLook {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly failing: boolean;
}

const CHECKS_FAILING = "Checks failing";

export const pullRequestTone = ({ state, isDraft, failing }: PullRequestLook): PullRequestTone => {
  if (state === "merged") {
    return {
      kind: "merged",
      icon: GitMerge,
      state: "Merged",
      label: "Merged",
      tone: "text-primary",
    };
  }
  if (state === "closed") {
    return {
      kind: "closed",
      icon: GitPullRequest,
      state: "Closed",
      label: "Closed",
      tone: "text-removed",
    };
  }
  const word = isDraft ? "Draft" : "Open";
  if (failing) {
    return {
      kind: "failing",
      icon: GitPullRequest,
      state: word,
      label: CHECKS_FAILING,
      tone: "text-destructive",
    };
  }
  return isDraft
    ? {
        kind: "draft",
        icon: GitPullRequest,
        state: word,
        label: word,
        tone: "text-muted-foreground",
      }
    : { kind: "open", icon: GitPullRequest, state: word, label: word, tone: "text-added" };
};

/** The glyph's tooltip and accessible name: "PR #12 · Open · Checks failing". */
export const pullRequestMarkLabel = (mark: Pick<PullRequestMark, "number"> & PullRequestLook) => {
  const tone = pullRequestTone(mark);
  return [`PR #${mark.number}`, tone.state, ...(tone.kind === "failing" ? [tone.label] : [])].join(
    " · ",
  );
};
